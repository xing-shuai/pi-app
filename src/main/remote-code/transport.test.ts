import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { spawn } from 'node:child_process'
import { SshWorkspace } from '../ssh/ssh-workspace'
import { sshProfileSchema, type SshRecord, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import { hostBootstrap } from './bootstrap'
import { sshArgs, REMOTE_STARTUP_MARKERS } from '../ssh/command'

const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Fake', host: 'test.invalid', cwd: '/', authMethod: 'password' })
describe('secure host transport', () => {
  it('does not let an early EPIPE erase the following fixed EOF diagnosis', async () => {
    const stdout = new PassThrough(), stderr = new PassThrough()
    const stdin = new Writable({ write(_data, _encoding, callback) { callback(Object.assign(new Error('fixture-private-error'), { code: 'EPIPE' })) } })
    const fd = new Writable({ write(_data, _encoding, callback) { callback() } })
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, fd], kill: vi.fn() })
    const spawned = vi.fn(() => child)
    const workspace = new SshWorkspace(() => {}, () => {}, spawned as unknown as typeof spawn, async () => ({ password: true }), async () => '/fake/ssh')
    const pending = workspace.connect(profile, undefined, { password: 'fixture-password' }, { hostMode: true, remoteCommand: 'trusted bootstrap' })
    const expected = expect(pending).rejects.toThrow('standard input closed')
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledOnce())
    stderr.write(REMOTE_STARTUP_MARKERS.hostStarting + '\n' + REMOTE_STARTUP_MARKERS.hostRuntime + '\n' + REMOTE_STARTUP_MARKERS.hostInputClosed + '\n')
    child.emit('close', 0)
    await expected
    expect(workspace.getStatus().error).not.toContain('fixture-private-error')
  })
  it('runs only bundled host code, preserves password-matching host paths and correlates host requests', async () => {
    const events: SshWorkspaceEvent[] = [], commands: SshRecord[] = [], fdCopies: Buffer[] = []
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    stdin.on('data', (b: Buffer) => commands.push(JSON.parse(b.toString())))
    const fd = new Writable({ write(b, _enc, cb) { fdCopies.push(Buffer.from(b)); cb() } })
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, fd], kill: vi.fn() })
    const spawnProcess = vi.fn(() => child)
    const remember = vi.fn()
    const workspace = new SshWorkspace((e) => events.push(e), remember, spawnProcess as unknown as typeof spawn, async () => ({ password: true }), async () => '/fake/ssh')
    await expect(workspace.connect(profile, undefined, { password: 'remote' }, { hostMode: true })).rejects.toThrow('bootstrap is required')
    expect(spawnProcess).not.toHaveBeenCalled()
    const bootstrap = hostBootstrap(profile, 'import fs from "node:fs"; /* fake bundled helper */')
    const pending = workspace.connect(profile, undefined, { password: 'remote' }, { hostMode: true, remoteCommand: bootstrap })
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0].type).toBe('get_state')
    stderr.write('remote raw auth password diagnostic\n')
    const host = { home: '/home/remote', platform: 'linux', nodeVersion: 'v22', capabilities: { files: true, git: true, pty: false, sessions: true }, workspaces: [] }
    stdout.write(JSON.stringify({ type: 'response', id: commands[0].id, command: 'get_state', success: true, data: { host } }) + '\n')
    await pending
    expect(workspace.getHostState()).toEqual(host)
    expect(remember).not.toHaveBeenCalled()
    expect(fdCopies[0].toString()).toBe('remote\n')
    expect(events.some((e) => e.kind === 'diagnostic')).toBe(false)
    expect(JSON.stringify(commands)).not.toContain('remote')
    const request = workspace.requestHost('browse', {})
    expect(commands[1]).toMatchObject({ type: 'host', op: 'browse', args: {} })
    stdout.write(JSON.stringify({ type: 'response', id: commands[1].id, command: 'host', success: true, data: { path: '/home/remote', entries: [] } }) + '\n')
    expect(await request).toEqual({ path: '/home/remote', entries: [] })
    expect(spawnProcess).toHaveBeenCalledWith('sshpass', ['-d', '3', '/fake/ssh', ...sshArgs(profile, undefined, bootstrap)], expect.any(Object))
    const args = sshArgs(profile, undefined, bootstrap)
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args.at(-1)).not.toContain('--mode rpc')
    expect(args.at(-1)).not.toContain('remote raw auth')
    expect(bootstrap).toContain('data:text/javascript;base64,')
    expect(bootstrap).not.toContain('pi --mode')
    workspace.disconnect()
  })
})
