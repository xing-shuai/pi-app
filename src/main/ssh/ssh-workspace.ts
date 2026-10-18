import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'
import { sshPasswordSchema, sshProfileSchema, type SshAuthCapabilities, type SshCommand, type SshCredentials, type SshFilesResult, type SshProfile, type SshRecord, type SshStatus, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import { remoteFilesCommand, sshArgs } from './command'
import type { HostOperation, HostState } from '@shared/ssh-host-types'
import { detectSshAuthCapabilities, PASSWORD_HELPER_UNAVAILABLE } from './auth'
import { resolveLocalOpenSsh, LOCAL_SSH_UNAVAILABLE, LOCAL_SSH_LOOKUP_TIMEOUT } from './executable'
import { SshStartupSignals, stripStartupMarkers } from './startup'

type Pending = { resolve: (record: SshRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const MAX_FRAME = 16 * 1024 * 1024
type Attempt = {
  passwordMode: boolean
  secret?: string
  failure?: string
  cancelPreflight?: () => void
  clearPipe?: () => void
  clearOutput?: () => void
  stdinError?: (error: Error) => void
}
const AUTH_FAILED = 'SSH password authentication failed. Check the password and server authentication policy.'
const STARTUP_FAILED = 'SSH password authentication or remote RPC startup failed. Check server access and the remote Pi installation.'

/** Password-mode messages reaching this boundary contain only fixed stage diagnostics. */
export class SshSafeConnectError extends Error {}

/** One explicit remote workspace, isolated from all local workers and local filesystem handlers. */
export class SshWorkspace {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private uncertain = new Set<string>()
  private status: SshStatus = { phase: 'disconnected' }
  private profile: SshProfile | null = null
  private stderr = ''
  private hostState?: HostState
  getHostState(): HostState | undefined { return this.hostState }
  private agentBusy = false
  private attempt: Attempt | null = null
  get hasActiveWork(): boolean { return this.status.phase === 'connecting' || this.agentBusy || this.pending.size > 0 }
  constructor(
    private emit: (event: SshWorkspaceEvent) => void,
    private remember: (profileId: string, sessionFile: string) => void,
    private spawnProcess: typeof spawn = spawn,
    private detectAuth: () => Promise<SshAuthCapabilities> = detectSshAuthCapabilities,
    private resolveSsh: () => Promise<string | undefined> = resolveLocalOpenSsh,
  ) {}

  getStatus(): SshStatus { return { ...this.status } }
  private publish(status: SshStatus): void {
    this.status = status
    this.emit({ kind: 'status', status: this.getStatus() })
  }
  private clearPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.uncertain.clear()
  }

  async connect(profile: SshProfile, sessionFile?: string, credentials?: SshCredentials, opts?: { remoteCommand?: string; hostMode?: boolean }): Promise<SshStatus> {
    // Reserve synchronously, before helper detection yields. Never keep credentials on a profile.
    if (this.attempt || this.child) throw new Error('Disconnect the current SSH workspace first')
    const parsed = sshProfileSchema.safeParse(profile)
    if (!parsed.success) throw new Error('Invalid SSH profile; credentials must not be saved in profiles')
    profile = parsed.data
    if (opts?.hostMode && !opts.remoteCommand) throw new Error('Remote host bootstrap is required')
    const attempt: Attempt = { passwordMode: profile.authMethod === 'password', secret: credentials?.password }
    credentials = undefined
    if (attempt.passwordMode) {
      if (!sshPasswordSchema.safeParse(attempt.secret).success) {
        attempt.secret = undefined
        throw new Error('SSH password authentication requires a nonempty password of at most 4096 characters without NUL, CR or LF')
      }
    } else if (attempt.secret !== undefined) {
      attempt.secret = undefined
      throw new Error('A password may only be supplied for SSH password authentication')
    }
    this.attempt = attempt
    this.profile = profile
    this.stderr = ''
    this.hostState = undefined
    this.publish({ phase: 'connecting', profileId: profile.id })
    try {
      let sshExecutable = 'ssh'
      if (attempt.passwordMode) {
        const cancelled = new Promise<never>((_resolve, reject) => {
          attempt.cancelPreflight = () => reject(new Error('SSH connection cancelled'))
        })
        const capabilities = await Promise.race([this.detectAuth(), cancelled])
        if (this.attempt !== attempt) throw new Error('SSH connection cancelled')
        if (!capabilities.password) {
          attempt.failure = capabilities.passwordUnavailableReason || PASSWORD_HELPER_UNAVAILABLE
          throw new Error(attempt.failure)
        }
        let lookupTimer: ReturnType<typeof setTimeout> | undefined
        let localSsh: string | undefined
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            lookupTimer = setTimeout(() => { attempt.failure = LOCAL_SSH_LOOKUP_TIMEOUT; reject(new Error(LOCAL_SSH_LOOKUP_TIMEOUT)) }, 1500)
            lookupTimer.unref?.()
          })
          localSsh = await Promise.race([this.resolveSsh(), cancelled, deadline])
        } finally { clearTimeout(lookupTimer) }
        if (this.attempt !== attempt) throw new Error('SSH connection cancelled')
        if (!localSsh) { attempt.failure = LOCAL_SSH_UNAVAILABLE; throw new Error(LOCAL_SSH_UNAVAILABLE) }
        sshExecutable = localSsh
        attempt.cancelPreflight = undefined
      }
      if (this.attempt !== attempt) throw new Error('SSH connection cancelled')
      const env = { ...process.env }
      delete env.SSHPASS
      const child = (attempt.passwordMode
        ? this.spawnProcess('sshpass', ['-d', '3', sshExecutable, ...sshArgs(profile, sessionFile, opts?.remoteCommand)], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, env })
        : this.spawnProcess('ssh', sshArgs(profile, sessionFile, opts?.remoteCommand), { stdio: 'pipe', windowsHide: true })) as ChildProcessWithoutNullStreams
      this.child = child
      let decoder: StringDecoder | undefined = new StringDecoder('utf8')
      let buffer = ''
      const startup = new SshStartupSignals()
      let stderrBuffer = ''
      let stdinFailureTimer: ReturnType<typeof setTimeout> | undefined
      const stderrDecoder = new StringDecoder('utf8')
      const visibleDiagnostic = (line: string) => {
        const visible = stripStartupMarkers(line)
        if (!visible.trim()) return
        this.stderr = (this.stderr + visible + '\n').slice(-4000)
        this.emit({ kind: 'diagnostic', text: visible.slice(-2000) + '\n' })
      }
      attempt.clearOutput = () => { clearTimeout(stdinFailureTimer); attempt.stdinError = undefined; buffer = ''; decoder = undefined; stderrBuffer = ''; startup.clearPrefix() }
      // Redact decoded values, never JSON syntax or protocol routing fields. In particular, a valid
      // short password such as "p" or "type" must not corrupt response IDs or the framing protocol.
      // Raw password-mode transport diagnostics are suppressed, including split/echoed prompts.
      const redactText = (text: string): string => {
        if (!attempt.secret) return text
        if (attempt.secret.length < 4) return text === attempt.secret ? '[redacted]' : text
        return text.split(attempt.secret).join('[redacted]')
      }
      const redactValue = (value: unknown): unknown => {
        if (typeof value === 'string') return redactText(value)
        if (Array.isArray(value)) return value.map(redactValue)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), redactValue(item)]))
        return value
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return
        buffer += decoder!.write(chunk)
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (raw.length > MAX_FRAME) { this.fail(child, 'Remote RPC record exceeds 16 MiB'); return }
          try {
            let record: unknown = JSON.parse(raw)
            if (record && typeof record === 'object' && 'type' in record && typeof record.type === 'string') {
              if (!opts?.hostMode && attempt.secret && record.type === 'response') record = Object.fromEntries(Object.entries(record).map(([key, value]) =>
                ['type', 'id', 'command', 'success'].includes(key) ? [key, value] : [redactText(key), redactValue(value)]))
              this.onRecord(record as SshRecord, (value) => !opts?.hostMode && attempt.secret ? redactValue(value) as SshRecord : value)
            }
          } catch {
            // A remote shell banner must not break framing or be mistaken for a response.
            if (!attempt.passwordMode && raw.trim()) this.emit({ kind: 'diagnostic', text: raw.slice(0, 1000) })
          }
          if (this.child !== child) return
        }
        if (buffer.length > MAX_FRAME) this.fail(child, 'Remote RPC record exceeds 16 MiB')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.child !== child) return
        const hadShell = startup.seen.has('shell'), hadStarting = startup.seen.has('starting')
        startup.push(chunk.toString('utf8'))
        if (!hadShell && startup.seen.has('shell')) this.emit({ kind: 'diagnostic', text: 'SSH: remote shell reached.\n' })
        if (!hadStarting && startup.seen.has('starting')) this.emit({ kind: 'diagnostic', text: 'SSH: starting remote Pi RPC.\n' })
        if (!attempt.passwordMode) {
          stderrBuffer = (stderrBuffer + stderrDecoder.write(chunk)).slice(-8000)
          let newline: number
          while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
            visibleDiagnostic(stderrBuffer.slice(0, newline).replace(/\r$/, ''))
            stderrBuffer = stderrBuffer.slice(newline + 1)
          }
        }
      })
      const stdinError = (error: Error) => {
        if (this.child !== child) return
        if (this.status.phase === 'connecting') {
          // EPIPE may arrive before stderr/close. Give fixed startup signals a bounded chance
          // to identify EOF/protocol/version failures instead of erasing the useful diagnosis.
          if (!stdinFailureTimer) stdinFailureTimer = setTimeout(() => {
            if (this.child === child && this.status.phase === 'connecting') this.fail(child, startup.failure(null, false, attempt.passwordMode) || (attempt.passwordMode ? STARTUP_FAILED : error.message))
          }, 200)
          return
        }
        this.fail(child, startup.failure(null, true, attempt.passwordMode) || (attempt.passwordMode ? STARTUP_FAILED : error.message))
      }
      attempt.stdinError = stdinError
      child.stdin.on('error', stdinError)
      child.on('error', (error: NodeJS.ErrnoException) => this.fail(child, attempt.passwordMode ? (error.code === 'ENOENT' ? PASSWORD_HELPER_UNAVAILABLE : STARTUP_FAILED) : error.message))
      child.on('close', (code) => {
        if (this.child !== child) return
        if (!attempt.passwordMode && stderrBuffer) visibleDiagnostic(stderrBuffer)
        const error = startup.failure(code, this.status.phase === 'connected', attempt.passwordMode)
          || (attempt.passwordMode ? code === 5 ? AUTH_FAILED : STARTUP_FAILED : `SSH exited (${code ?? 'signal'}). ${this.stderr || 'Connection closed.'}`)
        this.fail(child, error)
      })
      if (attempt.passwordMode) {
        const pipe = (child.stdio as unknown as Array<Writable | null>)[3]
        if (!pipe) throw new Error(STARTUP_FAILED)
        const bytes = Buffer.from(attempt.secret! + '\n', 'utf8')
        attempt.clearPipe = () => { bytes.fill(0); pipe.destroy() }
        pipe.on('error', () => this.fail(child, 'SSH password could not be delivered securely'))
        // Exactly one write on the dedicated anonymous pipe. RPC stdin/stdout remain untouched.
        pipe.end(bytes, () => { bytes.fill(0) })
      }
      const state = await this.request({ type: 'get_state' }, 30000)
      if (this.child !== child || this.attempt !== attempt) throw new Error('SSH connection cancelled')
      if (opts?.hostMode) {
        const host = (state.data as { host?: HostState } | undefined)?.host
        if (!host || typeof host.home !== 'string' || !host.capabilities) throw new Error('Invalid remote host handshake')
        this.hostState = host
      }
      clearTimeout(stdinFailureTimer)
      attempt.secret = undefined
      this.stderr = ''
      this.publish({ ...this.status, phase: 'connected' })
      this.updateState(state)
      return this.getStatus()
    } catch (error) {
      const message = attempt.failure || (this.attempt !== attempt ? 'SSH connection cancelled'
        : attempt.passwordMode ? (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? PASSWORD_HELPER_UNAVAILABLE
          : error instanceof Error && error.message.startsWith('Remote get_state timed out;') ? error.message : STARTUP_FAILED)
          : error instanceof Error ? error.message : 'SSH connection failed')
      if (this.attempt === attempt) {
        if (this.child) this.fail(this.child, message)
        else {
          this.attempt = null
          this.stderr = ''
          this.publish({ ...this.status, phase: 'disconnected', error: message, outcomeUnknown: false })
        }
      }
      throw new SshSafeConnectError(message)
    } finally {
      attempt.secret = undefined
      attempt.cancelPreflight = undefined
    }
  }

  private fail(child: ChildProcessWithoutNullStreams, error: string): void {
    if (this.child !== child) return
    this.child = null
    if (this.attempt) {
      this.attempt.failure = error
      this.attempt.secret = undefined
      this.attempt.clearPipe?.()
      this.attempt.clearOutput?.()
      this.attempt = null
    }
    this.stderr = ''
    this.agentBusy = false
    child.kill()
    this.clearPending(error)
    this.publish({ ...this.status, phase: 'disconnected', error, outcomeUnknown: false })
  }
  disconnect(): void {
    const child = this.child
    this.child = null
    if (this.attempt) {
      this.attempt.failure = 'SSH disconnected'
      this.attempt.secret = undefined
      this.attempt.cancelPreflight?.()
      this.attempt.clearPipe?.()
      this.attempt.clearOutput?.()
      this.attempt = null
    }
    this.stderr = ''
    this.agentBusy = false
    this.clearPending('SSH disconnected')
    if (child) { child.stdin.end(); child.kill() }
    this.publish({ ...this.status, phase: 'disconnected', error: undefined, outcomeUnknown: false })
  }

  private onRecord(record: SshRecord, redact: (record: SshRecord) => SshRecord): void {
    if (record.type === 'agent_start') this.agentBusy = true
    if (record.type === 'agent_settled') this.agentBusy = false
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(record.id)
        if (this.uncertain.delete(record.id)) this.publish({ ...this.status, outcomeUnknown: this.uncertain.size > 0 })
        if (record.success === false) pending.reject(new Error(this.attempt?.passwordMode && this.status.phase === 'connecting' ? STARTUP_FAILED : String(record.error || 'Remote command failed')))
        else pending.resolve(record)
      }
      if (record.command === 'get_state' && record.success) this.updateState(record)
      return
    }
    this.emit({ kind: 'record', record: redact(record) })
  }
  private updateState(record: SshRecord): void {
    const data = record.data as { sessionFile?: string; model?: { provider?: string; id?: string } } | undefined
    if (!data) return
    const sessionFile = data.sessionFile
    if (sessionFile && this.profile) this.remember(this.profile.id, sessionFile)
    this.publish({ ...this.status, sessionFile, model: data.model ? `${data.model.provider}/${data.model.id}` : undefined })
  }
  private request(command: Record<string, unknown>, timeoutMs = 60000): Promise<SshRecord> {
    const child = this.child
    if (!child?.stdin.writable) return Promise.reject(new Error('SSH is not connected'))
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending remote requests'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Keep activity and command correlation until a late response or explicit disconnect.
        this.uncertain.add(id)
        this.publish({ ...this.status, outcomeUnknown: true })
        reject(new Error(`Remote ${command.type} timed out; its outcome is unknown. Disconnect or abort before retrying.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // Node buffers writes until drained; reject further work if a remote stops reading.
      if (child.stdin.writableLength > 1024 * 1024) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Remote input is congested'))
        return
      }
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => {
        if (!error) return
        if (this.status.phase === 'connecting' && this.attempt?.stdinError) { this.attempt.stdinError(error); return }
        const p = this.pending.get(id)
        if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(error) }
      })
    })
  }
  /** Internal host operations only; never register this as a raw renderer RPC endpoint. */
  async requestHost(op: HostOperation, args: Record<string, unknown>): Promise<unknown> {
    if (this.status.phase !== 'connected') throw new Error('SSH is not connected')
    if (!this.hostState) throw new Error('SSH connection is not a Code host transport')
    if (this.uncertain.size && !['session.close', 'terminal.kill', 'session.rpc'].includes(op)) throw new Error('A remote operation has an unknown outcome; disconnect before retrying')
    if (this.uncertain.size && op === 'session.rpc' && !['abort', 'get_state', 'extension_ui_response'].includes(String((args.command as { type?: string })?.type))) throw new Error('A remote operation has an unknown outcome; abort or disconnect before retrying')
    return (await this.request({ type: 'host', op, args })).data
  }
  async command(command: SshCommand): Promise<SshRecord> {
    if (this.status.phase !== 'connected') throw new Error('SSH is not connected')
    if (this.uncertain.size && !['abort', 'abort_bash', 'get_state', 'get_messages', 'extension_ui_response'].includes(command.type)) throw new Error('A previous remote operation has an unknown outcome. Abort or disconnect before starting more work.')
    if (command.type === 'extension_ui_response') {
      // Extension dialogs carry the remote ID, not a generated command ID, and have no response.
      if (!this.child?.stdin.writable) throw new Error('SSH is not connected')
      this.child.stdin.write(JSON.stringify(command) + '\n')
      return { type: 'response', success: true }
    }
    const result = await this.request(command, command.type === 'bash' ? 600000 : 60000)
    if (command.type === 'new_session' || command.type === 'set_model') await this.request({ type: 'get_state' })
    return result
  }
  async files(action: 'list' | 'read', path: string): Promise<SshFilesResult> {
    if (!this.profile || this.status.phase !== 'connected') throw new Error('SSH is not connected')
    if (this.uncertain.size) throw new Error('A remote operation has an unknown outcome; file browsing is paused')
    const response = await this.request({ type: 'bash', command: remoteFilesCommand(this.profile, action, path), excludeFromContext: true }, 30000)
    const result = response.data as { output: string; exitCode: number; truncated?: boolean }
    if (result.exitCode !== 0 || result.truncated) throw new Error(result.output?.slice(-1500) || 'Remote file operation failed')
    return JSON.parse(result.output) as SshFilesResult
  }
}
