import { chmod, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { QUOTA_EXTENSION_SOURCE } from './quota-extension-source'
import { QuotaBridge, unavailableRemoteQuota } from './quota-bridge'
import type { HostEvent, HostSession, HostWorkspace } from '../../packages/shared/ssh-host-types'
import { Files } from './files'
import { skipAgentNameOnboarding } from './onboarding'
import { executable, fail, HostError, object, Processes, readJsonl, sanitize, Serial, text, writeRecord, type RecordValue } from './common'
import { checkedFile, markOpened, markPurpose, OPENED_SUFFIX, PURPOSE_SUFFIX, purpose, sameFile, sidecar, unlinkChecked } from './session-files'

type Pending = { command: string; originalId?: string; resolve: (record: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Runtime = { id: string; workspace: HostWorkspace; child: ChildProcessWithoutNullStreams; file: string; sessionId: string; busy: boolean; epoch: number; pending: Map<string, Pending>; closed: boolean; deleting?: boolean; rpcCount?: number; quota?: QuotaBridge; quotaFile?: string }
const COMMANDS = new Set(('prompt steer follow_up abort clear_queue get_state get_messages get_entries get_tree new_session set_model cycle_model get_available_models set_thinking_level cycle_thinking_level get_available_thinking_levels set_steering_mode set_follow_up_mode get_session_stats get_commands compact set_auto_compaction set_auto_retry abort_retry bash abort_bash get_fork_messages get_last_assistant_text set_session_name fork clone extension_ui_response').split(' '))

export class Sessions {
  readonly runtimes = new Map<string, Runtime>()
  private readonly starts = new Serial()
  private disposed = false
  constructor(readonly files: Files, readonly processes: Processes, readonly event: (event: HostEvent) => void, readonly timeout = 30000) {}
  private async directory(ws: HostWorkspace): Promise<string> {
    let current = this.files.home
    for (const [index, part] of ['.pi', 'desktop-code', 'sessions', ws.id].entries()) {
      current = join(current, part)
      await mkdir(current, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
      const info = await lstat(current)
      const component = ['pi-config', 'desktop-code', 'sessions', 'workspace'][index]
      const reject = (reason: string): never => fail(`unsafe_session_directory:${component}:${reason}:${(info.mode & 0o7777).toString(8).padStart(4, '0')}`)
      if (info.isSymbolicLink()) reject('symlink')
      if (!info.isDirectory()) reject('not-directory')
      if (info.uid !== process.getuid?.()) reject('owner')
      if (await realpath(current) !== current) reject('changed')
      if (index === 0) {
        // Global Pi configuration may use the account's trusted group (normal umask
        // 0002). It is not our private session directory and must not be chmodded.
        // Keep ownership/path checks and reject writes by arbitrary other users.
        if ((info.mode & 0o002) !== 0) reject('write-access')
      } else {
        // Owned app directories were already normalized to 0700, but rejecting their
        // old mode before normalization made upgrades fail. Tighten through a checked
        // descriptor instead; never repair a symlink or somebody else's directory.
        const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== info.uid) reject('changed')
          await handle.chmod(0o700)
          const after = await lstat(current)
          if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.uid !== opened.uid || (after.mode & 0o777) !== 0o700) reject('changed')
        } finally { await handle.close() }
      }
    }
    return current
  }
  private async metadata(ws: HostWorkspace, path: string): Promise<RecordValue | null> {
    try {
      const { handle, info } = await checkedFile(path, Number.MAX_SAFE_INTEGER, false)
      let buffer: Buffer, tail = '', unchanged = false
      try {
        const first = Buffer.alloc(Math.min(info.size, 1024 * 1024))
        const result = await handle.read(first, 0, first.length, 0)
        buffer = first.subarray(0, result.bytesRead)
        if (info.size > first.length) {
          const last = Buffer.alloc(Math.min(info.size - first.length, 256 * 1024))
          const read = await handle.read(last, 0, last.length, info.size - last.length)
          const value = last.subarray(0, read.bytesRead).toString('utf8')
          tail = value.slice(value.indexOf('\n') + 1)
        }
        unchanged = sameFile(info, await handle.stat())
      } finally { await handle.close() }
      const lines = buffer.toString('utf8').split('\n')
      const header = object(JSON.parse(lines.shift()!))
      if (header.type !== 'session' || typeof header.id !== 'string' || header.cwd !== ws.root || !Number.isFinite(Date.parse(header.timestamp))) return null
      let title = '', modelId = '', firstMessage = '', messageCount = 0, hasUserMessages = false
      let complete = unchanged && info.size <= buffer.length && Buffer.from(buffer.toString('utf8')).equals(buffer), named = false, emptySafe = !header.parentSession
      // Invalid sidecars are not evidence of emptiness/non-adoption. Preserve the row.
      let adopted = true, provenance: 'utility' | 'user' | undefined
      try {
        adopted = !!await sidecar(path + OPENED_SUFFIX)
        provenance = await purpose(path, header.id)
      } catch { emptySafe = false }
      for (const line of [...lines, ...tail.split('\n')]) {
        try {
          const entry = JSON.parse(line)
          if (!['message', 'session_info', 'model_change', 'thinking_level_change'].includes(entry?.type)) emptySafe = false
          if (entry.type === 'message') {
            messageCount++
            if (entry.message?.role === 'user') {
              hasUserMessages = true
              if (!firstMessage) {
                const content = entry.message.content
                firstMessage = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: { type?: unknown }) => b?.type === 'text').map((b: { text?: unknown }) => b.text).join(' ') : '').slice(0, 120)
              }
            }
          }
          if (entry.type === 'session_info' && typeof entry.name === 'string') { title = entry.name.slice(0, 200); named = true }
          else if (!title && entry.type === 'message' && entry.message?.role === 'user') {
            const content = entry.message.content
            title = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: { type?: unknown }) => b?.type === 'text').map((b: { text?: unknown }) => b.text).join(' ') : '').slice(0, 200)
          }
          if (entry.type === 'model_change' && typeof entry.modelId === 'string') modelId = entry.modelId
          if (entry.type === 'message' && typeof entry.message?.model === 'string') modelId = entry.message.model
        } catch { if (line.trim()) complete = false /* Never infer emptiness from a malformed/truncated read. */ }
      }
      const runtime = [...this.runtimes.values()].find((r) => r.file === path && !r.closed)
      return { sessionId: header.id, sessionFile: path, title: title || 'New session', firstMessage, messageCount: complete ? messageCount : undefined, hasUserMessages: hasUserMessages ? true : complete ? false : undefined, confirmedEmptyUtility: (provenance === 'utility' || (!provenance && header.desktopUtility === true)) && complete && emptySafe && messageCount === 0 && !named && !adopted && !runtime?.busy, createdAt: Date.parse(header.timestamp), updatedAt: info.mtimeMs, modelId, status: runtime?.busy ? 'busy' : 'idle' }
    } catch { return null }
  }
  async list(ws: HostWorkspace): Promise<{ sessions: RecordValue[] }> {
    const dir = await this.directory(ws), candidates: { path: string; time: number }[] = []
    const entries = await opendir(dir)
    let count = 0
    for await (const entry of entries) {
      if (++count > 10000) fail('session_directory_too_large')
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(dir, entry.name), info = await lstat(path)
      candidates.push({ path, time: info.mtimeMs })
    }
    candidates.sort((a, b) => b.time - a.time)
    const sessions = []
    for (const candidate of candidates.slice(0, 500)) { const metadata = await this.metadata(ws, candidate.path); if (metadata && !metadata.confirmedEmptyUtility) { delete metadata.confirmedEmptyUtility; sessions.push(metadata) } }
    return { sessions }
  }
  private async allowed(ws: HostWorkspace, input: unknown): Promise<string> {
    const path = text(input), dir = await this.directory(ws)
    // Require native absolute paths issued by this host, never IDs or arbitrary CLI search strings.
    if (dirname(path) !== dir || !basename(path).endsWith('.jsonl') || await realpath(path).catch(() => '') !== path || !await this.metadata(ws, path)) fail('session_not_allowed')
    return path
  }
  async start(args: RecordValue): Promise<HostSession> {
    const ws = this.files.workspace(args)
    return this.starts.run(async () => {
      if (this.disposed) fail('host_closed')
      if (this.runtimes.size >= 4) fail('runtime_limit')
      // An explicit invalid executable must never silently fall back to another Pi.
      const command = await executable(text(args.piPath, 'pi'), this.files.home, this.processes.env, args.piPath !== undefined)
      const dir = await this.directory(ws)
      let file: string
      if (args.sessionFile !== undefined && args.fresh !== true) file = await this.allowed(ws, args.sessionFile)
      else {
        const id = randomUUID()
        file = join(dir, `${new Date().toISOString().replace(/:/g, '-')}_${id}.jsonl`)
        // Pi lazily persists new sessions. Do not precreate utility JSONL files:
        // opening a precreated header makes Pi mark it flushed and persist setup-only entries.
        if (args.utility !== true) {
          const handle = await open(file, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: ws.root }) + '\n') } finally { await handle.close() }
        }
      }
      if ([...this.runtimes.values()].some((r) => r.file === file)) fail('session_in_use')
      if (args.utility !== true || args.sessionFile !== undefined) await chmod(file, 0o600)
      if (this.disposed) fail('host_closed')
      // umask is inherited at spawn. Keep API callers' process mask unchanged while ensuring
      // Pi-created replacement/fork sessions and auxiliary files are private too.
      const quotaFile = join(dir, `.quota-${randomUUID()}.mjs`)
      const quotaHandle = await open(quotaFile, 'wx', 0o600)
      try { await quotaHandle.writeFile(QUOTA_EXTENSION_SOURCE) } finally { await quotaHandle.close() }
      const quotaNonce = randomBytes(32).toString('hex')
      const previousMask = process.umask(0o077)
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.processes.start(command, ['--mode', 'rpc', '--session-dir', dir, '--session', file, '--approve', '--extension', quotaFile], ws.root, {
          ...this.processes.env,
          PI_DESKTOP_QUOTA_NONCE: quotaNonce,
          PATH: [dirname(process.execPath), dirname(command), this.processes.env.PATH ?? '/usr/bin:/bin'].join(':'),
        }, true)
      } catch (error) { await unlink(quotaFile).catch(() => {}); throw error }
      finally { process.umask(previousMask) }
      const runtime: Runtime = { id: randomUUID(), workspace: ws, child, file, sessionId: '', busy: false, epoch: 0, pending: new Map(), closed: false, quotaFile, quota: new QuotaBridge(child.stdio?.[3] as Duplex | undefined, quotaNonce) }
      this.runtimes.set(runtime.id, runtime)
      const stopReading = readJsonl(child.stdout, (record) => this.receive(runtime, record), () => { this.reject(runtime, 'pi_protocol_error'); void this.closeRuntime(runtime) }, true)
      child.once('error', () => this.reject(runtime, 'pi_start_failed'))
      child.stdin.on('error', () => this.reject(runtime, 'pi_transport_closed'))
      child.once('close', (code) => {
        stopReading(); runtime.closed = true; runtime.quota?.close(); void unlink(quotaFile).catch(() => {}); this.reject(runtime, 'pi_exited'); this.runtimes.delete(runtime.id)
        this.event({ type: 'host_event', kind: 'session-exit', workspaceId: ws.id, runtimeId: runtime.id, code })
      })
      try {
        const response = await this.send(runtime, { type: 'get_state' })
        if (!response.success) fail('pi_handshake_failed')
        const state = object(response.data)
        if (typeof state.sessionId !== 'string' || !state.sessionId || typeof state.sessionFile !== 'string') fail('pi_handshake_failed')
        await this.updateState(runtime, state)
        if (args.sessionFile === undefined) await markPurpose(runtime.file, runtime.sessionId, args.utility === true ? 'utility' : 'user')
        runtime.busy = state.isStreaming === true || state.isCompacting === true || Number(state.pendingMessageCount) > 0
        return { runtimeId: runtime.id, sessionId: runtime.sessionId, sessionFile: runtime.file, cwd: ws.root, model: typeof state.model?.id === 'string' ? state.model.id : undefined, thinkingLevel: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined, isStreaming: runtime.busy }
      } catch (error) { await this.closeRuntime(runtime); throw error }
    })
  }
  private async updateState(runtime: Runtime, state: RecordValue): Promise<void> {
    if (typeof state.sessionId === 'string') runtime.sessionId = state.sessionId
    if (typeof state.sessionFile === 'string') {
      const dir = await this.directory(runtime.workspace)
      if (dirname(state.sessionFile) !== dir || !state.sessionFile.endsWith('.jsonl')) fail('unsafe_pi_session')
      const existing = await lstat(state.sessionFile).catch(() => null)
      if (existing) { await this.allowed(runtime.workspace, state.sessionFile); await chmod(state.sessionFile, 0o600) }
      if ([...this.runtimes.values()].some((r) => r !== runtime && r.file === state.sessionFile)) fail('session_in_use')
      runtime.file = state.sessionFile
    }
  }
  private reject(runtime: Runtime, code: string): void {
    for (const pending of runtime.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError(code)) }
    runtime.pending.clear()
  }
  private receive(runtime: Runtime, record: RecordValue): void {
    if (record.type === 'extension_ui_request' && record.method === 'input' && typeof record.id === 'string' && skipAgentNameOnboarding(record.title, record.placeholder)) {
      // Optional CLI extension onboarding can run before get_state/desktop runtime binding.
      // Decline here as well, so a hidden startup input cannot deadlock the handshake.
      try { writeRecord(runtime.child.stdin, { type: 'extension_ui_response', id: record.id, cancelled: true }) }
      catch { this.reject(runtime, 'pi_protocol_error') }
      return
    }
    if (record.type === 'response') {
      const pending = runtime.pending.get(record.id)
      if (!pending) return
      runtime.pending.delete(record.id); clearTimeout(pending.timer)
      if (record.command !== pending.command || typeof record.success !== 'boolean') { pending.reject(new HostError('pi_protocol_error')); return }
      pending.resolve(object(sanitize(record))); return
    }
    if (typeof record.type !== 'string') return
    if (record.type === 'agent_start') { runtime.busy = true; runtime.epoch++ }
    if (record.type === 'agent_settled') { runtime.busy = false; runtime.epoch++ }
    if (record.type === 'bash_execution_update' && typeof record.id === 'string') {
      const originalId = runtime.pending.get(record.id)?.originalId
      if (originalId) record.id = originalId
      else delete record.id
    }
    this.event({ type: 'host_event', kind: 'pi', workspaceId: runtime.workspace.id, runtimeId: runtime.id, event: object(sanitize(record)) })
  }
  private send(runtime: Runtime, command: RecordValue): Promise<RecordValue> {
    if (runtime.closed) fail('runtime_closed')
    if (runtime.pending.size >= 64) fail('pending_limit')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // Keep a timed-out slot until the real response/exit: timeouts do not unlock active turns.
      const timer = setTimeout(() => reject(new HostError('pi_timeout')), this.timeout)
      runtime.pending.set(id, { command: command.type, originalId: typeof command.id === 'string' ? command.id : undefined, resolve, reject, timer })
      try { writeRecord(runtime.child.stdin, { ...command, id }) } catch (error) { clearTimeout(timer); runtime.pending.delete(id); reject(error) }
    })
  }
  async rpc(args: RecordValue): Promise<unknown> {
    const runtime = this.runtime(args)
    runtime.rpcCount = (runtime.rpcCount || 0) + 1
    try { return await this.rpcCommand(runtime, args) } finally { runtime.rpcCount!-- }
  }
  private async rpcCommand(runtime: Runtime, args: RecordValue): Promise<unknown> {
    const command = { ...object(args.command) }
    const type = text(command.type)
    if (type === 'desktop_provider_usage') {
      // Private transport capability only; NEVER write an unknown command or slash prompt to Pi.
      const data = runtime.quota ? await runtime.quota.query(runtime.sessionId, runtime.file) : unavailableRemoteQuota('remote-unsupported')
      return { type: 'response', command: type, success: true, data }
    }
    if (!COMMANDS.has(type)) fail('rpc_command_not_allowed')
    if (type === 'extension_ui_response') {
      text(command.id)
      writeRecord(runtime.child.stdin, command) // Pi's dialog ID must NOT be rewritten.
      return { type: 'response', command: type, success: true }
    }
    if (type === 'new_session' && command.parentSession !== undefined) command.parentSession = await this.allowed(runtime.workspace, command.parentSession)
    // Read RPCs are also used by internal hydration/metadata probes, not proof of user adoption.
    if (['prompt', 'steer', 'follow_up', 'set_session_name', 'bash'].includes(type)) await markOpened(runtime.file)
    const lifecycle = ['new_session', 'fork', 'clone'].includes(type)
    if ((lifecycle || type === 'compact') && runtime.busy) fail('session_busy')
    if (runtime.deleting || runtime.closed) fail('runtime_closed')
    const wasBusy = runtime.busy, epoch = runtime.epoch
    if (lifecycle || ['prompt', 'steer', 'follow_up', 'compact', 'bash'].includes(type)) runtime.busy = true
    const response = await this.send(runtime, command)
    if (runtime.epoch === epoch && (!response.success || response.data?.disposition === 'handled' || type === 'compact' || type === 'bash')) runtime.busy = wasBusy
    if (type === 'get_state' && response.success) await this.updateState(runtime, object(response.data))
    if (lifecycle) {
      if (response.success && !response.data?.cancelled) {
        const state = await this.send(runtime, { type: 'get_state' })
        if (!state.success) fail('pi_state_failed')
        await this.updateState(runtime, object(state.data))
      }
      if (runtime.epoch === epoch) runtime.busy = wasBusy
    }
    // Preserve the entire Pi response inside host data, rather than flattening Pi semantics.
    delete response.id
    return response
  }
  private runtime(args: RecordValue): Runtime {
    const ws = this.files.workspace(args), runtime = this.runtimes.get(text(args.runtimeId))
    if (!runtime || runtime.workspace.id !== ws.id) fail('runtime_not_found')
    if (runtime.deleting || runtime.closed) fail('runtime_closed')
    return runtime
  }
  async adopt(args: RecordValue): Promise<{ ok: true }> {
    const ws = this.files.workspace(args)
    return this.starts.run(async () => {
      const file = await this.allowed(ws, args.sessionFile)
      await markOpened(file)
      return { ok: true }
    })
  }
  async delete(args: RecordValue): Promise<{ ok: true }> {
    const ws = this.files.workspace(args)
    // Serialize with starts: a concurrent resume cannot acquire the file after the check.
    return this.starts.run(async () => {
      const file = await this.allowed(ws, args.sessionFile)
      const { handle, info } = await checkedFile(file)
      try {
        const head = Buffer.alloc(Math.min(info.size, 16384))
        const read = await handle.read(head, 0, head.length, 0)
        const header = object(JSON.parse(head.subarray(0, read.bytesRead).toString('utf8').split('\n')[0]))
        if (header.id !== text(args.sessionId) || header.cwd !== ws.root) fail('session_identity_changed')
        const companions = await Promise.all([PURPOSE_SUFFIX, OPENED_SUFFIX].map(async (suffix) => ({ path: file + suffix, entry: await sidecar(file + suffix) })))
        const runtime = [...this.runtimes.values()].find((r) => r.file === file)
        if (runtime) {
          if (runtime.busy || runtime.pending.size || runtime.rpcCount || runtime.deleting || runtime.closed) fail('session_busy')
          runtime.deleting = true // Reject RPCs before the first await; never abort live work to delete.
          await this.closeRuntime(runtime)
          if (runtime.child.exitCode === null && runtime.child.signalCode === null) fail('runtime_stop_failed')
          this.runtimes.delete(runtime.id)
        }
        // Revalidate directory and exact inode/size after stopping Pi, then unlink only this file.
        await this.directory(ws)
        // Clean companions first: a metadata cleanup failure must not be reported after
        // successfully removing the history. The final unlink rechecks the exact history.
        for (const companion of companions) if (companion.entry) await unlinkChecked(companion.path, companion.entry.info)
        await unlinkChecked(file, info)
        return { ok: true }
      } finally { await handle.close() }
    })
  }
  async close(args: RecordValue): Promise<{ ok: true }> { await this.closeRuntime(this.runtime(args)); return { ok: true } }
  private async closeRuntime(runtime: Runtime): Promise<void> {
    if (!runtime.closed) {
      runtime.closed = true
      runtime.quota?.close()
      if (runtime.quotaFile) await unlink(runtime.quotaFile).catch(() => {})
      try { writeRecord(runtime.child.stdin, { id: randomUUID(), type: 'abort' }) } catch { /* dead */ }
      await this.processes.stop(runtime.child)
      this.reject(runtime, 'runtime_closed')
    }
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.runtimes.values()].map((r) => this.closeRuntime(r))) }
}
