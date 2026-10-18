import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { spawn } from 'node:child_process'
import { sshConnectSchema, sshProfileSchema, type SshRecord, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import { SshWorkspace } from './ssh-workspace'
import { sshArgs, REMOTE_STARTUP_MARKERS } from './command'

const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Dev', host: 'dev', cwd: '/code', authMethod: 'password' })
function fixture(detect = vi.fn(async () => ({ password: true })), resolveSsh: () => Promise<string | undefined> = async () => '/client/bin/ssh') {
  const children: ReturnType<typeof makeChild>[] = []
  const events: SshWorkspaceEvent[] = []
  const remember = vi.fn()
  function makeChild() {
    const fdCopies: Buffer[] = [], fdOriginals: Buffer[] = [], commands: SshRecord[] = []
    const fd3 = new Writable({ write(chunk: Buffer, _encoding, callback) { fdCopies.push(Buffer.from(chunk)); fdOriginals.push(chunk); callback() } })
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    stdin.on('data', (bytes: Buffer) => commands.push(JSON.parse(bytes.toString())))
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, fd3], fd3, fdCopies, fdOriginals, commands, kill: vi.fn() })
  }
  const spawnProcess = vi.fn(() => { const child = makeChild(); children.push(child); return child })
  const service = new SshWorkspace((event) => events.push(event), remember, spawnProcess as unknown as typeof spawn, detect, resolveSsh)
  const spawned = async () => { await vi.waitFor(() => expect(children).toHaveLength(1)); return children[0] }
  const reply = (child: ReturnType<typeof makeChild>, data: unknown = { sessionFile: '/remote/session' }) => child.stdout.write(JSON.stringify({ type: 'response', command: 'get_state', id: child.commands[0].id, success: true, data }) + '\n')
  return { children, events, remember, spawnProcess, service, detect, spawned, reply }
}

describe('SSH password boundaries', () => {
  it('keeps legacy profiles optional, rejects saved secrets and restricts password-only options', () => {
    expect(sshProfileSchema.parse({ ...profile, authMethod: undefined }).authMethod).toBeUndefined()
    expect(sshProfileSchema.safeParse({ ...profile, password: 'do-not-save' }).success).toBe(false)
    const args = sshArgs(profile)
    for (const option of ['BatchMode=no', 'PreferredAuthentications=password,keyboard-interactive', 'PubkeyAuthentication=no', 'NumberOfPasswordPrompts=1', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']) expect(args).toContain(option)
    const agent = sshArgs({ ...profile, authMethod: undefined })
    expect(agent).toContain('BatchMode=yes')
    expect(agent).not.toContain('PubkeyAuthentication=no')
    expect(agent).not.toContain('NumberOfPasswordPrompts=1')
    expect(agent).not.toContain('PreferredAuthentications=password,keyboard-interactive')
  })
  it.each(['', 'secret\nnext', 'secret\rnext', 'secret\0next', 'x'.repeat(4097), 123, {}])('rejects invalid transient credentials with static validation messages (%#)', async (password) => {
    const parsed = sshConnectSchema.safeParse({ id: profile.id, password })
    expect(parsed.success).toBe(false)
    if (!parsed.success && typeof password === 'string' && password.length) expect(parsed.error.issues.map((i) => i.message).join(' ')).not.toContain(password)
    const f = fixture()
    await expect(f.service.connect(profile, undefined, { password: password as string })).rejects.toThrow('password authentication requires')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(f.detect).not.toHaveBeenCalled()
  })
  it('requires a password only in password mode and does not trim spaces', async () => {
    const f = fixture()
    await expect(f.service.connect(profile)).rejects.toThrow('requires')
    await expect(f.service.connect({ ...profile, authMethod: 'agent' }, undefined, { password: 'secret' })).rejects.toThrow('only be supplied')
    const connecting = f.service.connect(profile, undefined, { password: '  ' })
    const child = await f.spawned(); f.reply(child); await connecting
    expect(Buffer.concat(child.fdCopies).toString()).toBe('  \n')
    f.service.disconnect()
    await expect(f.service.connect(profile)).rejects.toThrow('requires')
  })
  it.each(['p', '\\', 'type', 'response'])('does not confuse a valid password with JSON syntax or routing fields (%#)', async (password) => {
    const f = fixture()
    const pending = f.service.connect(profile, undefined, { password })
    const child = await f.spawned(); f.reply(child)
    await pending
    expect(f.service.getStatus()).toMatchObject({ phase: 'connected', sessionFile: '/remote/session' })
    expect(child.fdCopies[0].toString()).toBe(password + '\n')
    f.service.disconnect()
  })
  it('sends the secret once on FD3, zeros the temporary buffer, and leaves RPC and persistence clean', async () => {
    const f = fixture(), secret = 'p@ss \\"雪-secret'
    const connecting = f.service.connect(profile, '/remote/previous', { password: secret })
    expect(f.service.hasActiveWork).toBe(true)
    const child = await f.spawned()
    expect(f.spawnProcess).toHaveBeenCalledWith('sshpass', ['-d', '3', '/client/bin/ssh', ...sshArgs(profile, '/remote/previous')], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true }))
    const options = f.spawnProcess.mock.calls[0] as unknown[]
    expect(JSON.stringify(options)).not.toContain(secret)
    expect((options[2] as { env: NodeJS.ProcessEnv }).env.SSHPASS).toBeUndefined()
    expect(child.fdCopies).toHaveLength(1)
    expect(Buffer.concat(child.fdCopies).toString()).toBe(secret + '\n')
    expect(child.fd3.writableEnded).toBe(true)
    expect(JSON.stringify(child.commands)).not.toContain(secret)
    child.stderr.write(secret.slice(0, 4)); child.stderr.write(secret.slice(4))
    child.stdout.write(secret + '\n')
    const event = JSON.stringify({ type: 'notice', text: secret }) + '\n'
    child.stdout.write(event.slice(0, 20)); child.stdout.write(event.slice(20))
    child.stdout.write(JSON.stringify({ type: secret, id: secret, command: secret }) + '\n')
    f.reply(child)
    await connecting
    await new Promise(setImmediate)
    expect(child.fdOriginals.every((b) => b.every((byte) => byte === 0))).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(f.events).toContainEqual({ kind: 'record', record: { type: 'notice', text: '[redacted]' } })
    expect(f.events).toContainEqual({ kind: 'record', record: { type: '[redacted]', id: '[redacted]', command: '[redacted]' } })
    expect(f.remember).toHaveBeenCalledWith(profile.id, '/remote/session')
    expect(JSON.stringify(f.remember.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(profile)).not.toContain(secret)
    // File browsing reuses the established RPC transport, never starts another ssh/password prompt.
    const files = f.service.files('list', '')
    child.stdout.write(JSON.stringify({ type: 'response', id: child.commands[1].id, success: true, data: { exitCode: 0, output: '{"path":"","entries":[]}' } }) + '\n')
    expect(await files).toEqual({ path: '', entries: [] })
    expect(f.spawnProcess).toHaveBeenCalledOnce()
    f.service.disconnect()
  })
  it('reserves the connection before helper preflight and cancels without spawning or retaining credentials', async () => {
    let finish!: (result: { password: boolean }) => void
    const f = fixture(vi.fn(() => new Promise((resolve) => { finish = resolve })))
    const pending = f.service.connect(profile, undefined, { password: 'cancel-secret' })
    const check = expect(pending).rejects.toThrow('disconnected')
    expect(f.service.getStatus().phase).toBe('connecting')
    expect(f.service.hasActiveWork).toBe(true)
    await expect(f.service.connect(profile, undefined, { password: 'other' })).rejects.toThrow('Disconnect')
    f.service.disconnect()
    await check
    expect(f.service.hasActiveWork).toBe(false)
    finish({ password: true }); await Promise.resolve()
    expect(f.spawnProcess).not.toHaveBeenCalled()
    await expect(f.service.connect(profile)).rejects.toThrow('requires')
    expect(JSON.stringify(f.events)).not.toContain('cancel-secret')
  })
  it.each([5, 6, 7, 255])('classifies failures without echoing password/diagnostics (exit %s)', async (code) => {
    const f = fixture(), secret = 'secret-not-for-errors'
    const pending = f.service.connect(profile, undefined, { password: secret })
    const check = expect(pending).rejects.toThrow(code === 5 ? 'password authentication failed' : 'host key verification failed')
    const child = await f.spawned()
    child.stderr.write(secret + '\nHost key ver'); child.stderr.write('ification failed')
    child.emit('close', code)
    await check
    expect(JSON.stringify(f.events)).not.toContain(secret)
    expect(f.service.getStatus().phase).toBe('disconnected')
    expect(f.service.hasActiveWork).toBe(false)
    expect(child.fdOriginals.every((b) => b.every((byte) => byte === 0))).toBe(true)
  })
  it('distinguishes missing local SSH from remote Pi exit 127 without leaking credentials', async () => {
    const absent = fixture(undefined, async () => undefined)
    await expect(absent.service.connect(profile, undefined, { password: 'not-for-logs' })).rejects.toThrow('local OpenSSH client')
    expect(absent.spawnProcess).not.toHaveBeenCalled()
    const remote = fixture()
    const pending = remote.service.connect(profile, undefined, { password: 'not-for-logs' })
    const failure = expect(pending).rejects.toThrow('Pi was not found on the remote machine')
    const child = await remote.spawned()
    child.stderr.write(REMOTE_STARTUP_MARKERS.shell.slice(0, 10)); child.stderr.write(REMOTE_STARTUP_MARKERS.shell.slice(10) + '\n')
    child.stderr.write(REMOTE_STARTUP_MARKERS.piMissing + '\nnot-for-logs')
    child.emit('close', 127)
    await failure
    expect(JSON.stringify(remote.events)).not.toContain('not-for-logs')
    expect(remote.service.getStatus().error).not.toContain('sshpass could not start OpenSSH')
  })
  it('does not misclassify remote runtime exits as password rejection', async () => {
    const f = fixture()
    const pending = f.service.connect(profile, undefined, { password: 'not-for-logs' })
    const failure = expect(pending).rejects.toThrow('Remote Pi exited (5)')
    const child = await f.spawned()
    child.stderr.write(REMOTE_STARTUP_MARKERS.shell + '\n' + REMOTE_STARTUP_MARKERS.starting + '\n')
    child.emit('close', 5)
    await failure
  })
  it('can cancel local SSH resolution without starting a late helper', async () => {
    let finish!: (path: string) => void
    const f = fixture(undefined, () => new Promise((resolve) => { finish = resolve }))
    const pending = f.service.connect(profile, undefined, { password: 'not-for-logs' })
    const failure = expect(pending).rejects.toThrow('disconnected')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.service.disconnect(); await failure; finish('/client/bin/ssh'); await Promise.resolve()
    expect(f.spawnProcess).not.toHaveBeenCalled()
  })
  it('bounds stalled local path discovery without keeping credentials or spawning SSH', async () => {
    vi.useFakeTimers()
    const f = fixture(undefined, () => new Promise(() => {}))
    try {
      const pending = f.service.connect(profile, undefined, { password: 'not-for-logs' })
      const failure = expect(pending).rejects.toThrow('path lookup timed out')
      await vi.advanceTimersByTimeAsync(1501); await failure
      expect(f.spawnProcess).not.toHaveBeenCalled()
      expect(f.service.hasActiveWork).toBe(false)
      expect(JSON.stringify(f.events)).not.toContain('not-for-logs')
    } finally { f.service.disconnect(); vi.useRealTimers() }
  })
  it('does not spawn when helper detection says unavailable', async () => {
    const f = fixture(vi.fn(async () => ({ password: false, passwordUnavailableReason: 'Install sshpass' })))
    await expect(f.service.connect(profile, undefined, { password: 'not-for-logs' })).rejects.toThrow('Install sshpass')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(f.service.hasActiveWork).toBe(false)
    expect(JSON.stringify(f.events)).not.toContain('not-for-logs')
  })
  it('sanitizes remote startup errors and bounds password authentication time', async () => {
    const f = fixture()
    const pending = f.service.connect(profile, undefined, { password: 'not-for-logs' })
    const check = expect(pending).rejects.toThrow('remote RPC startup failed')
    const child = await f.spawned()
    child.stdout.write(JSON.stringify({ type: 'response', id: child.commands[0].id, success: false, error: 'not-for-logs' }) + '\n')
    await check
    expect(JSON.stringify(f.events)).not.toContain('not-for-logs')
    vi.useFakeTimers()
    const g = fixture()
    try {
      const timed = g.service.connect(profile, undefined, { password: 'not-for-logs' })
      const timedCheck = expect(timed).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30001)
      await timedCheck
      expect(g.service.hasActiveWork).toBe(false)
      expect(g.children[0].kill).toHaveBeenCalledOnce()
    } finally { g.service.disconnect(); vi.useRealTimers() }
  })
  it('distinguishes a helper removed after preflight from an authentication failure', async () => {
    const f = fixture()
    const pending = f.service.connect(profile, undefined, { password: 'secret-not-for-errors' })
    const check = expect(pending).rejects.toThrow('requires sshpass')
    const child = await f.spawned()
    child.emit('error', Object.assign(new Error('secret-not-for-errors'), { code: 'ENOENT' }))
    await check
    expect(JSON.stringify(f.events)).not.toContain('secret-not-for-errors')
  })
  it('ignores late old exits and never lets a cancelled preflight disconnect a new connection', async () => {
    let finish!: (result: { password: boolean }) => void
    const f = fixture(vi.fn(() => new Promise((resolve) => { finish = resolve })))
    const cancelled = f.service.connect(profile, undefined, { password: 'cancel-secret' })
    const check = expect(cancelled).rejects.toThrow('disconnected')
    f.service.disconnect()
    const current = f.service.connect({ ...profile, authMethod: 'agent' })
    const child = f.children[0]
    finish({ password: true }); await check
    expect(f.service.getStatus().phase).toBe('connecting')
    f.reply(child); await current
    f.service.disconnect()
    const next = f.service.connect({ ...profile, authMethod: 'agent' })
    child.emit('close', 5); child.emit('error', new Error('old'))
    expect(f.service.getStatus().phase).toBe('connecting')
    f.reply(f.children[1]); await next
    expect(f.service.getStatus().phase).toBe('connected')
    f.service.disconnect()
  })
})
