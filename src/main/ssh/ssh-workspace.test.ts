import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import type { SshRecord, SshWorkspaceEvent } from '@shared/ssh-workspace'
import { sshProfileSchema } from '@shared/ssh-workspace'
import { SshWorkspace } from './ssh-workspace'

const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Dev', host: 'dev', cwd: '/code' })
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  const commands: SshRecord[] = []
  child.stdin.on('data', (b: Buffer) => commands.push(JSON.parse(b.toString())))
  const events: SshWorkspaceEvent[] = []
  const remember = vi.fn()
  const spawnProcess = vi.fn(() => child)
  const service = new SshWorkspace((event) => events.push(event), remember, spawnProcess as unknown as typeof spawn)
  const reply = (command: SshRecord, data: unknown = {}, success = true) => child.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success, data, error: success ? undefined : 'remote failure' }) + '\n')
  const ready = async () => {
    const connecting = service.connect(profile)
    reply(commands[0], { sessionFile: '/remote/session.jsonl', model: { provider: 'test', id: 'model' } })
    await connecting
  }
  return { child, commands, events, service, remember, ready, reply, spawnProcess }
}
afterEach(() => vi.useRealTimers())
describe('SSH RPC lifecycle', () => {
  it('connects only after RPC handshake and remembers remote session without local fs access', async () => {
    const f = fixture()
    await f.ready()
    expect(f.spawnProcess).toHaveBeenCalledWith('ssh', expect.any(Array), { stdio: 'pipe', windowsHide: true })
    expect(f.service.getStatus()).toMatchObject({ phase: 'connected', sessionFile: '/remote/session.jsonl', model: 'test/model' })
    expect(f.remember).toHaveBeenCalledWith(profile.id, '/remote/session.jsonl')
    f.service.disconnect()
    expect(f.child.kill).toHaveBeenCalledOnce()
  })
  it('correlates out-of-order responses and surfaces command errors', async () => {
    const f = fixture(); await f.ready()
    const first = f.service.command({ type: 'get_messages' })
    const second = f.service.command({ type: 'get_available_models' })
    f.reply(f.commands[2], { models: ['second'] })
    f.reply(f.commands[1], { messages: ['first'] })
    expect((await second).data).toEqual({ models: ['second'] })
    expect((await first).data).toEqual({ messages: ['first'] })
    const bad = f.service.command({ type: 'get_state' })
    f.reply(f.commands[3], {}, false)
    await expect(bad).rejects.toThrow('remote failure')
    f.service.disconnect()
  })
  it('preserves split UTF-8, CRLF and unicode separators with strict LF framing', async () => {
    const f = fixture(); await f.ready()
    const bytes = Buffer.from(JSON.stringify({ type: 'test', text: '中文\u2028one\u2029two' }) + '\r\n')
    const split = bytes.findIndex((byte) => byte >= 0xe0) + 1
    f.child.stdout.write(bytes.subarray(0, split)); f.child.stdout.write(bytes.subarray(split))
    expect(f.events).toContainEqual({ kind: 'record', record: { type: 'test', text: '中文\u2028one\u2029two' } })
    f.service.disconnect()
  })
  it('keeps extension dialog IDs and does not await a nonexistent reply', async () => {
    const f = fixture(); await f.ready()
    await f.service.command({ type: 'extension_ui_response', id: 'remote-dialog', confirmed: false })
    expect(f.commands.at(-1)).toEqual({ type: 'extension_ui_response', id: 'remote-dialog', confirmed: false })
    f.service.disconnect()
  })
  it('rejects pending work on disconnect and ignores late exits from the old child', async () => {
    const f = fixture(); await f.ready()
    const pending = f.service.command({ type: 'get_messages' })
    f.service.disconnect()
    await expect(pending).rejects.toThrow('disconnected')
    f.child.emit('close', 255)
    expect(f.service.getStatus()).toMatchObject({ phase: 'disconnected', error: undefined })
  })
  it('bounds startup timeout and reports ssh authentication/host verification failures', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const failed = f.service.connect(profile)
    const check = expect(failed).rejects.toThrow(/host key verification failed/i)
    f.child.stderr.write('Host key verification failed')
    f.child.emit('close', 255)
    await check
    expect(f.service.getStatus().phase).toBe('disconnected')
    const g = fixture()
    const timed = g.service.connect(profile)
    const timedCheck = expect(timed).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30001)
    await timedCheck
    expect(g.child.kill).toHaveBeenCalledOnce()
  })
  it('keeps timed-out work locked and correlated until a late response', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.ready()
    const command = f.service.command({ type: 'bash', command: 'long-running-work', excludeFromContext: true })
    const rejected = expect(command).rejects.toThrow('outcome is unknown')
    await vi.advanceTimersByTimeAsync(600001)
    await rejected
    expect(f.service.hasActiveWork).toBe(true)
    expect(f.service.getStatus().outcomeUnknown).toBe(true)
    await expect(f.service.command({ type: 'new_session' })).rejects.toThrow('unknown outcome')
    f.reply(f.commands[1], { output: 'eventually done', exitCode: 0 })
    expect(f.service.hasActiveWork).toBe(false)
    expect(f.service.getStatus().outcomeUnknown).toBe(false)
    f.service.disconnect()
  })

  it('counts automatic remote work until agent_settled (not agent_end)', async () => {
    const f = fixture(); await f.ready()
    f.child.stdout.write('{"type":"agent_start"}\n')
    expect(f.service.hasActiveWork).toBe(true)
    f.child.stdout.write('{"type":"agent_end"}\n')
    expect(f.service.hasActiveWork).toBe(true)
    f.child.stdout.write('{"type":"agent_settled"}\n')
    expect(f.service.hasActiveWork).toBe(false)
    f.service.disconnect()
  })
})
