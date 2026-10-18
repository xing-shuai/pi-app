import { homedir } from 'node:os'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import type { HostEvent, HostReply, HostState } from '../../packages/shared/ssh-host-types'
import { Files, under } from './files'
import { Git } from './git'
import { Sessions } from './sessions'
import { Terminals } from './terminals'
import { errorCode, fail, HostError, object, Processes, readJsonl, text, writeRecord, type RecordValue, type SpawnFunction } from './common'

export interface HostOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFunction
  event?: (event: HostEvent) => void
  pty?: boolean
  piTimeoutMs?: number
}
export async function createHost(options: HostOptions = {}) {
  let home: string
  try {
    home = await realpath(options.home ?? homedir())
    if (!(await stat(home)).isDirectory()) throw new HostError('home_unavailable')
    await access(home, constants.R_OK | constants.X_OK)
  } catch { throw new HostError('home_unavailable') }
  const processes = new Processes(options.spawn, { ...(options.env ?? process.env), HOME: home })
  const files = new Files(home)
  const event = options.event ?? (() => {})
  const sessions = new Sessions(files, processes, event, options.piTimeoutMs)
  const terminals = new Terminals(files, processes, event)
  const git = new Git(files, processes)
  const pty = options.pty !== false && await terminals.supported()
  let disposed = false
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    // Close the spawn gate immediately, including for starts still awaiting filesystem work.
    processes.disposed = true
    disposal = (async () => { await Promise.all([sessions.dispose(), terminals.dispose()]); await processes.dispose() })()
    return disposal
  }
  const state = (): HostState => ({ home, platform: process.platform, nodeVersion: process.version, capabilities: { files: true, git: true, pty, sessions: true }, workspaces: [...files.workspaces.values()] })
  async function operation(op: string, args: RecordValue): Promise<unknown> {
    if (disposed) fail('host_closed')
    if (op === 'browse') return files.browse(args)
    if (op === 'workspace.register') return files.register(args)
    if (op === 'terminal.profiles') return terminals.profiles()
    // All remaining operations need an explicit registered/trusted root.
    const ws = files.workspace(args)
    await under(ws.root)
    if (disposed) fail('host_closed')
    if (op.startsWith('fs.')) return files.operation(op, args)
    if (op.startsWith('git.')) return git.operation(op, args)
    if (op === 'session.list') return sessions.list(ws)
    if (op === 'session.start') return sessions.start(args)
    if (op === 'session.rpc') return sessions.rpc(args)
    if (op === 'session.close') return sessions.close(args)
    if (op === 'session.delete') return sessions.delete(args)
    if (op === 'session.adopt') return sessions.adopt(args)
    if (op === 'terminal.create') return terminals.create(args)
    if (op === 'terminal.write') return terminals.write(args)
    if (op === 'terminal.resize') return terminals.resize(args)
    if (op === 'terminal.kill') return terminals.kill(args)
    fail('unsupported_operation')
  }
  async function handle(request: RecordValue): Promise<HostReply> {
    let id = '', command = 'host'
    try {
      id = text(request.id)
      if (!id || id.length > 256) fail('invalid_request_id')
      if (disposed) fail('host_closed')
      if (request.type === 'get_state') {
        command = 'get_state'
        return { id, type: 'response', command, success: true, data: { host: state(), isStreaming: false } }
      }
      if (request.type !== 'host') fail('invalid_request')
      const data = await operation(text(request.op), object(request.args ?? {}))
      // Large Git/Pi results must become a bounded failure, not break the wire mid-record.
      if (Buffer.byteLength(JSON.stringify(data) ?? '') > 16 * 1024 * 1024 - 4096) fail('response_too_large')
      return { id, type: 'response', command, success: true, data }
    } catch (error) {
      const code = errorCode(error)
      return { id, type: 'response', command, success: false, error: code, errorCode: code }
    }
  }
  return { handle, operation, dispose, state }
}
export type Host = Awaited<ReturnType<typeof createHost>>

export async function startHost(options: HostOptions & { input?: Readable; output?: Writable; diagnostics?: Writable } = {}) {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout, diagnostics = options.diagnostics ?? process.stderr
  diagnostics.on('error', () => {})
  let closed = false
  // Forward references make teardown safe if stream/host setup emits synchronously.
  // eslint-disable-next-line prefer-const
  let host: Host | undefined, stopReading: (() => void) | undefined
  const pending = new Set<string>()
  let pendingBytes = 0
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    closed = true; stopReading?.(); input.pause()
    input.off('end', onEnd); input.off('error', onEnd); input.off('close', onEnd); output.off('error', onOutputError); output.off('close', onOutputError)
    stopping = host?.dispose() ?? Promise.resolve()
    return stopping
  }
  // Fixed diagnostics only; never include requests, paths, authentication or raw stderr.
  const diagnostic = (marker: string) => { if (!diagnostics.destroyed && diagnostics.writableLength < 4096) diagnostics.write(marker + '\n') }
  const onEnd = () => { diagnostic('__PI_DESKTOP_REMOTE_HOST_STDIN_CLOSED_V1__'); void stop() }
  const onOutputError = () => { void stop() }
  const invalidProtocol = () => { diagnostic('__PI_DESKTOP_REMOTE_HOST_INPUT_INVALID_V1__'); void stop() }
  const send = (value: unknown) => {
    if (closed) return
    try { writeRecord(output, value) } catch { void stop() }
  }
  // Error/close can occur during asynchronous HOME and utility discovery.
  input.on('end', onEnd); input.on('error', onEnd); input.on('close', onEnd); output.on('error', onOutputError); output.on('close', onOutputError)
  try { host = await createHost({ ...options, event: (event) => { send(event); options.event?.(event) } }) } catch (error) { await stop(); throw error }
  if (closed) { await host.dispose(); return { host, dispose: stop } }
  stopReading = readJsonl(input, (request, bytes) => {
    if (closed) return
    if (typeof request.id !== 'string' || !request.id || request.id.length > 256 || pending.has(request.id) || pending.size >= 64 || pendingBytes + bytes > 32 * 1024 * 1024) {
      // Closing on protocol overload avoids an unbounded queue of rejection replies.
      invalidProtocol(); return
    }
    const id = request.id
    pending.add(id); pendingBytes += bytes
    void host!.handle(request).then((reply) => {
      pending.delete(id); pendingBytes -= bytes
      send(reply)
    }).catch(() => { pending.delete(id); pendingBytes -= bytes; void stop() })
  }, invalidProtocol, true) // Accept LF or CRLF framing, never embedded raw CR or malformed UTF-8.
  if (input.readableEnded || input.destroyed) { onEnd(); await stop() }
  else if (output.destroyed) await stop()
  return { host, dispose: stop }
}
