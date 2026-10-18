// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, link, chmod, rename, truncate } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Files } from './files'
import { Processes, type RecordValue } from './common'
import { Sessions } from './sessions'
import { OPENED_SUFFIX, PURPOSE_SUFFIX } from './session-files'
import type { HostWorkspace } from '../../packages/shared/ssh-host-types'

let temp: string, root: string, dir: string, sessions: Sessions, ws: HostWorkspace, processes: Processes
const children: (ChildProcessWithoutNullStreams & { emitRecord: (record: RecordValue) => void })[] = []
const header = (id: string) => JSON.stringify({ type: 'session', version: 3, id, cwd: root, timestamp: new Date().toISOString() }) + '\n'
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'session-delete-')); root = join(temp, 'project'); await mkdir(root)
  const files = new Files(temp); ws = await files.register({ path: root, trusted: true })
  dir = join(temp, '.pi/desktop-code/sessions', ws.id); await mkdir(dir, { recursive: true, mode: 0o700 })
  processes = new Processes()
  vi.spyOn(processes, 'start').mockImplementation((_command, args) => {
    const file = args[args.indexOf('--session') + 1]
    const id = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id : 'lazy-id'
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null }) as unknown as typeof children[number]
    child.emitRecord = (record) => { child.stdout.emit('data', Buffer.from(JSON.stringify(record) + '\n')) }
    child.stdin.on('data', (data) => {
      const command = JSON.parse(data.toString())
      if (command.type === 'get_state') queueMicrotask(() => child.emitRecord({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: id, sessionFile: file, isStreaming: false } }))
      else if (command.type !== 'get_tree') queueMicrotask(() => child.emitRecord({ type: 'response', id: command.id, command: command.type, success: true, data: {} }))
    })
    children.push(child); return child
  })
  vi.spyOn(processes, 'stop').mockImplementation(async (child) => { Object.assign(child, { exitCode: 0 }); child.emit('close', 0) })
  sessions = new Sessions(files, processes, () => {})
})
afterEach(async () => { await sessions.dispose(); children.length = 0; vi.restoreAllMocks(); await rm(temp, { recursive: true, force: true }) })
const args = (extra: RecordValue = {}) => ({ workspaceId: ws.id, ...extra })
async function put(id: string, extra = '') { const file = join(dir, id + '.jsonl'); await writeFile(file, header(id) + extra, { mode: 0o600 }); return file }
async function remove(file: string, id: string) { return sessions.delete(args({ sessionFile: file, sessionId: id })) }

describe('session directory validation', () => {
  it('tightens owned app storage on upgrade without changing global Pi permissions', async () => {
    const global = join(temp, '.pi'), owned = [join(global, 'desktop-code'), join(global, 'desktop-code', 'sessions'), dir]
    await chmod(global, 0o755)
    for (const path of owned) await chmod(path, 0o775)
    expect(await sessions.list(ws)).toEqual({ sessions: [] })
    expect((await lstat(global)).mode & 0o777).toBe(0o755)
    for (const path of owned) expect((await lstat(path)).mode & 0o777).toBe(0o700)
    expect(processes.start).not.toHaveBeenCalled()
  })
  it('accepts owned 0775 global Pi configuration and reaches model RPC without changing its permissions', async () => {
    const global = join(temp, '.pi')
    await chmod(global, 0o775)
    const runtime = await sessions.start(args({ piPath: process.execPath, utility: true }))
    const reply = await sessions.rpc(args({ runtimeId: runtime.runtimeId, command: { type: 'get_available_models' } }))
    expect(reply).toMatchObject({ success: true, command: 'get_available_models' })
    expect((await lstat(global)).mode & 0o777).toBe(0o775)
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    expect(existsSync(runtime.sessionFile)).toBe(false)
    expect(processes.start).toHaveBeenCalledOnce()
  })
  it('still rejects world-writable global Pi configuration without modifying it or starting Pi', async () => {
    const global = join(temp, '.pi')
    await chmod(global, 0o777)
    await expect(sessions.list(ws)).rejects.toThrow('unsafe_session_directory:pi-config:write-access:0777')
    expect((await lstat(global)).mode & 0o777).toBe(0o777)
    expect(processes.start).not.toHaveBeenCalled()
  })
  it('still refuses foreign ownership rather than repairing an unrelated directory', async () => {
    const uid = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    await expect(sessions.list(ws)).rejects.toThrow('unsafe_session_directory:pi-config:owner:')
    expect(processes.start).not.toHaveBeenCalled()
  })
})
describe('remote private session provenance', () => {
  it('returns capability unavailable without sending an unknown quota command or model prompt to Pi', async () => {
    const runtime = await sessions.start(args({ piPath: process.execPath, utility: true }))
    const writes: string[] = []
    children[0].stdin.on('data', data => writes.push(String(data)))
    expect(await sessions.rpc(args({ runtimeId: runtime.runtimeId, command: { type: 'desktop_provider_usage' } }))).toMatchObject({ success: true, data: { status: 'unavailable', reason: 'remote-unsupported' } })
    expect(writes).toEqual([])
    const start = vi.mocked(processes.start).mock.calls[0]
    expect(start[1]).toContain('--extension')
    const extension = start[1][start[1].indexOf('--extension') + 1]
    expect((await lstat(extension)).mode & 0o777).toBe(0o600)
    expect(start[4]).toBe(true)
    await sessions.dispose()
    expect(existsSync(extension)).toBe(false)
  })
  it('does not precreate utility histories; durable provenance survives SDK-owned header rewrites and internal reads do not adopt', async () => {
    const utility = await sessions.start(args({ piPath: process.execPath, utility: true }))
    expect(existsSync(utility.sessionFile)).toBe(false)
    expect(JSON.parse(await readFile(utility.sessionFile + PURPOSE_SUFFIX, 'utf8'))).toMatchObject({ purpose: 'utility', sessionId: 'lazy-id' })
    // Simulate a Pi version/extension persisting setup entries without our old custom header tag.
    await writeFile(utility.sessionFile, header('lazy-id') + JSON.stringify({ type: 'model_change', modelId: 'fake' }) + '\n', { mode: 0o600 })
    await sessions.rpc(args({ runtimeId: utility.runtimeId, command: { type: 'get_messages' } }))
    expect(existsSync(utility.sessionFile + OPENED_SUFFIX)).toBe(false)
    expect(await sessions.list(ws as never)).toEqual({ sessions: [] })
    await sessions.adopt(args({ sessionFile: utility.sessionFile }))
    expect((await sessions.list(ws as never)).sessions).toHaveLength(1)
    expect((await lstat(utility.sessionFile + PURPOSE_SUFFIX)).mode & 0o777).toBe(0o600)
  })
  it('keeps invalid/mismatched or symlinked provenance visible, never follows it', async () => {
    const a = await put('mismatch'), b = await put('linked')
    await writeFile(a + PURPOSE_SUFFIX, '{"version":1,"purpose":"utility","sessionId":"someone-else"}', { mode: 0o600 })
    await symlink(a + PURPOSE_SUFFIX, b + PURPOSE_SUFFIX)
    expect((await sessions.list(ws)).sessions.map((row) => row.sessionId).sort()).toEqual(['linked', 'mismatch'])
    await expect(remove(b, 'linked')).rejects.toThrow('unsafe_session_file')
    expect(existsSync(a)).toBe(true); expect(existsSync(b)).toBe(true)
  })
  it('preserves legacy unknown, explicit-new, named, malformed and any history; no automatic deletion', async () => {
    const legacy = await put('legacy')
    await put('named', JSON.stringify({ type: 'session_info', name: 'A deliberate name' }) + '\n')
    await put('history', JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'Important' } }) + '\n')
    await put('malformed', '{"type":"message"')
    const explicit = await sessions.start(args({ piPath: process.execPath, fresh: true }))
    const rows = (await sessions.list(ws as never)).sessions
    expect(rows.map((row) => row.sessionId)).toEqual(expect.arrayContaining(['legacy', 'named', 'history', 'malformed', explicit.sessionId]))
    expect(rows.find((row) => row.sessionId === 'malformed')?.messageCount).toBeUndefined()
    expect(existsSync(legacy)).toBe(true)
  })
})
describe('exact confirmed remote deletion', () => {
  it('unlinks only the selected history and its private sidecars without spawning Pi', async () => {
    const file = await put('selected'), other = await put('other')
    await writeFile(file + PURPOSE_SUFFIX, '{"version":1,"purpose":"user","sessionId":"selected"}', { mode: 0o600 })
    await sessions.adopt(args({ sessionFile: file }))
    expect(await remove(file, 'selected')).toEqual({ ok: true })
    expect(existsSync(file)).toBe(false); expect(existsSync(file + PURPOSE_SUFFIX)).toBe(false); expect(existsSync(file + OPENED_SUFFIX)).toBe(false)
    expect(JSON.parse((await readFile(other, 'utf8')).split('\n')[0]).id).toBe('other')
    expect(processes.start).not.toHaveBeenCalled()
  })
  it('rejects cross-root, changed ID, symlinks, hardlinks, loose permissions and unsafe companions', async () => {
    const file = await put('selected'), outside = join(root, 'outside.jsonl')
    await writeFile(outside, header('outside'), { mode: 0o600 })
    await expect(remove(outside, 'outside')).rejects.toThrow('session_not_allowed')
    await expect(remove(file, 'wrong')).rejects.toThrow('session_identity_changed')
    const linked = join(dir, 'linked.jsonl'); await symlink(outside, linked)
    await expect(remove(linked, 'outside')).rejects.toThrow('session_not_allowed')
    const hard = join(dir, 'hard.jsonl'); await link(outside, hard)
    await expect(remove(hard, 'outside')).rejects.toThrow('session_not_allowed')
    await chmod(file, 0o644)
    expect((await sessions.list(ws)).sessions.map((row) => row.sessionId)).toContain('selected')
    await expect(remove(file, 'selected')).rejects.toThrow('unsafe_session_file'); await chmod(file, 0o600)
    await symlink(outside, file + OPENED_SUFFIX)
    await expect(remove(file, 'selected')).rejects.toThrow('unsafe_session_file')
    expect(existsSync(file)).toBe(true); expect(existsSync(outside)).toBe(true)
    const escapeDir = dir + '-moved'; await rename(dir, escapeDir); await symlink(escapeDir, dir)
    await expect(remove(file, 'selected')).rejects.toThrow('unsafe_session_directory')
  })
  it('refuses oversized deletion inputs/sidecars without hiding or deleting existing history', async () => {
    const huge = await put('huge')
    await truncate(huge, 256 * 1024 * 1024 + 1) // sparse temp file: no history/content/network reads
    expect((await sessions.list(ws)).sessions.map((row) => row.sessionId)).toContain('huge')
    await expect(remove(huge, 'huge')).rejects.toThrow('unsafe_session_file')
    const file = await put('companion')
    await writeFile(file + OPENED_SUFFIX, 'x'.repeat(513), { mode: 0o600 })
    await expect(remove(file, 'companion')).rejects.toThrow('unsafe_session_file')
    expect(existsSync(huge)).toBe(true); expect(existsSync(file)).toBe(true)
  })
  it('refuses active and in-flight RPC races, then stops precisely the idle owner before unlink', async () => {
    const a = await sessions.start(args({ piPath: process.execPath, fresh: true }))
    const b = await sessions.start(args({ piPath: process.execPath, fresh: true }))
    children[0].emitRecord({ type: 'agent_start' })
    await expect(remove(a.sessionFile, a.sessionId)).rejects.toThrow('session_busy')
    children[0].emitRecord({ type: 'agent_settled' })
    const read = sessions.rpc(args({ runtimeId: a.runtimeId, command: { type: 'get_tree' } }))
    await expect(remove(a.sessionFile, a.sessionId)).rejects.toThrow('session_busy')
    const pending = [...sessions.runtimes.get(a.runtimeId)!.pending.keys()][0]
    children[0].emitRecord({ type: 'response', id: pending, command: 'get_tree', success: true, data: {} }); await read
    expect(await remove(a.sessionFile, a.sessionId)).toEqual({ ok: true })
    expect(processes.stop).toHaveBeenCalledExactlyOnceWith(children[0])
    expect(sessions.runtimes.has(b.runtimeId)).toBe(true); expect(existsSync(b.sessionFile)).toBe(true)
    await expect(sessions.rpc(args({ runtimeId: a.runtimeId, command: { type: 'prompt', message: 'race' } }))).rejects.toThrow('runtime_not_found')
  })
  it('refuses replacement files and failed stops rather than deleting a different/current writer', async () => {
    const a = await sessions.start(args({ piPath: process.execPath }))
    vi.mocked(processes.stop).mockImplementationOnce(async (child) => {
      Object.assign(child, { exitCode: 0 }); child.emit('close', 0)
      await rename(a.sessionFile, a.sessionFile + '.original')
      await writeFile(a.sessionFile, header(a.sessionId), { mode: 0o600 })
    })
    await expect(remove(a.sessionFile, a.sessionId)).rejects.toThrow('session_file_changed')
    expect(existsSync(a.sessionFile)).toBe(true)
    const b = await sessions.start(args({ piPath: process.execPath }))
    vi.mocked(processes.stop).mockImplementationOnce(async () => {})
    await expect(remove(b.sessionFile, b.sessionId)).rejects.toThrow('runtime_stop_failed')
    expect(existsSync(b.sessionFile)).toBe(true)
  })
})
