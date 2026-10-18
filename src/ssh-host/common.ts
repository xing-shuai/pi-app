import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'

/** Heterogeneous JSONL wire records; each operation validates fields with object/text/integer guards. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RecordValue = Record<string, any>
export const MAX_FRAME = 16 * 1024 * 1024
export class HostError extends Error {
  constructor(public code: string) { super(code) }
}
export function fail(code: string): never { throw new HostError(code) }
export function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_arguments')
  return value as RecordValue
}
export function text(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.includes('\0')) fail('invalid_arguments')
  return value
}
export function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('invalid_arguments')
  return Math.min(value as number, max)
}
export function errorCode(error: unknown): string {
  if (error instanceof HostError) return error.code
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found' : code === 'EEXIST' ? 'target_exists' : code === 'EACCES' ? 'permission_denied' : 'operation_failed'
}

/** Byte-based LF framing: no readline Unicode separators, replacement UTF-8, or unbounded tail. */
export function readJsonl(input: Readable, record: (value: RecordValue, bytes: number) => void, invalid: () => void, allowCRLF = false): () => void {
  let tail = Buffer.alloc(0), size = 0, stopped = false
  const bad = () => { if (!stopped) { stopped = true; tail = Buffer.alloc(0); size = 0; invalid() } }
  const append = (part: Buffer): boolean => {
    if (size + part.length > MAX_FRAME) { bad(); return false }
    if (size + part.length > tail.length) {
      const next = Buffer.allocUnsafe(Math.max(size + part.length, Math.min(MAX_FRAME, Math.max(4096, tail.length * 2))))
      tail.copy(next, 0, 0, size); tail = next
    }
    part.copy(tail, size); size += part.length
    return true
  }
  const data = (chunk: Buffer | string) => {
    if (stopped) return
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0, newline: number
    while ((newline = buf.indexOf(10, start)) >= 0) {
      const part = buf.subarray(start, newline)
      if (size + part.length > MAX_FRAME) return bad()
      let line = part
      if (size) { if (!append(part)) return; line = tail.subarray(0, size) }
      size = 0; start = newline + 1
      if (allowCRLF && line.at(-1) === 13) line = line.subarray(0, -1)
      if (!line.length || line.includes(13)) return bad()
      try {
        const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)))
        record(value, line.length)
      } catch { return bad() }
      if (stopped) return
    }
    if (start < buf.length) append(buf.subarray(start))
  }
  const end = () => { if (size) bad() }
  input.on('data', data); input.on('end', end)
  return () => { stopped = true; tail = Buffer.alloc(0); input.off('data', data); input.off('end', end) }
}

/** Node's writable queue honors backpressure; cap it rather than accumulating an unbounded user queue. */
export function writeRecord(output: Writable, value: unknown): void {
  const line = JSON.stringify(value) + '\n'
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_FRAME + 1) fail('frame_too_large')
  if (output.destroyed || output.writableEnded) fail('transport_closed')
  if (output.writableLength + bytes > 32 * 1024 * 1024) fail('output_overflow')
  output.write(line)
}

export type SpawnFunction = typeof spawn
export class Processes {
  readonly children = new Set<ChildProcessWithoutNullStreams>()
  disposed = false
  constructor(readonly spawnFn: SpawnFunction = spawn, readonly env: NodeJS.ProcessEnv = process.env) {}
  start(command: string, args: string[], cwd: string, env = this.env, privatePipe = false): ChildProcessWithoutNullStreams {
    if (this.disposed) fail('host_closed')
    if (this.children.size >= 64) fail('process_limit')
    const child = this.spawnFn(command, args, { cwd, env, stdio: privatePipe ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams
    this.children.add(child)
    child.once('close', () => this.children.delete(child))
    // Never send raw subprocess diagnostics (which can include auth/provider configuration).
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.on('error', () => {})
    return child
  }
  signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already gone */ }
  }
  async stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      // The leader may have exited while tools still hold its process group/stdio open.
      this.signal(child, 'SIGKILL')
      return
    }
    child.stdin.end()
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => this.signal(child, 'SIGTERM'), 300)
      const kill = setTimeout(() => { this.signal(child, 'SIGKILL'); done() }, 1300)
      const done = () => { clearTimeout(term); clearTimeout(kill); child.off('close', done); resolve() }
      child.once('close', done)
    })
  }
  async run(command: string, args: string[], cwd: string, input?: string, timeout = 15000, env = this.env): Promise<{ code: number; out: string; err: string }> {
    const child = this.start(command, args, cwd, env)
    return new Promise((resolve, reject) => {
      let out = '', err = '', bytes = 0, finished = false
      const timer = setTimeout(() => finish(new HostError('process_timeout')), timeout)
      const finish = (error?: Error, code = -1) => {
        if (finished) return
        finished = true; clearTimeout(timer)
        if (error) { this.signal(child, 'SIGKILL'); reject(error) } else resolve({ code, out, err })
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (value: string) => { bytes += Buffer.byteLength(value); if (bytes > 8 * 1024 * 1024) finish(new HostError('output_too_large')); else out += value })
      // stderr is used only for local Git error classification, never forwarded verbatim.
      child.stderr.on('data', (b: Buffer) => { if (err.length < 65536) err += b.toString('utf8').slice(0, 65536 - err.length) })
      child.once('error', () => finish(new HostError('process_start_failed')))
      child.once('close', (code) => finish(undefined, code ?? -1))
      child.stdin.end(input)
    })
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.children].map((child) => this.stop(child))) }
}

export async function executable(name: string, home: string, env: NodeJS.ProcessEnv, explicit = false): Promise<string> {
  const expanded = name === '~' ? home : name.startsWith('~/') ? join(home, name.slice(2)) : name
  if (expanded.includes('/') && !isAbsolute(expanded)) fail('executable_not_found')
  const candidates = isAbsolute(expanded) ? [expanded] : (env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean).map((dir) => join(dir, expanded))
  if (!explicit && name === 'pi') candidates.push(join(home, '.pi/agent/bin/pi'), join(home, '.local/bin/pi'), join(home, '.local/share/pi-node/current/bin/pi'), join(home, '.npm-global/bin/pi'), '/usr/local/bin/pi', '/opt/homebrew/bin/pi')
  for (const path of candidates) {
    try { const canonical = await realpath(path); if (!(await stat(canonical)).isFile()) continue; await access(canonical, constants.X_OK); return canonical } catch { /* next */ }
  }
  fail('executable_not_found')
}

/** Remove configuration secrets, including custom model headers, from child records. Text/tool output remains user data. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 64) return null
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1))
  if (!value || typeof value !== 'object') return value
  const out: RecordValue = Object.create(null)
  for (const [key, val] of Object.entries(value)) {
    if (/^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credentials|password|secret|clientSecret|headers|auth|oauth|baseUrl)$/i.test(key)) continue
    if (/^(error|errorMessage|finalError)$/i.test(key)) { out[key] = 'Remote Pi operation failed'; continue }
    out[key] = sanitize(val, depth + 1)
  }
  return out
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => {})
    return result
  }
}
