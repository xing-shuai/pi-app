import { expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { sshProfileSchema, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import { SshWorkspace } from './ssh-workspace'

let available = process.platform === 'linux' && existsSync('/usr/bin/python3')
try { execFileSync('sshpass', ['-V'], { stdio: 'ignore', timeout: 1500 }) } catch { available = false }

it.skipIf(!available)('local sshpass /dev/tty challenge leaves RPC stdin/stdout intact (no network)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sshpass-test-'))
  const secret = '  ' + randomBytes(24).toString('hex') + '  '
  const events: SshWorkspaceEvent[] = []
  const invocations: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  // The fixture contains no credential: it checks a digest and reads the actual password only via
  // sshpass's controlling terminal. PATH intercepts ssh, so no host or known_hosts is ever touched.
  writeFileSync(join(root, 'ssh'), `#!/usr/bin/python3
import os, sys, json, hashlib, termios
tty = os.open('/dev/tty', os.O_RDWR)
previous = termios.tcgetattr(tty)
hidden = termios.tcgetattr(tty)
hidden[3] &= ~termios.ECHO
termios.tcsetattr(tty, termios.TCSANOW, hidden)
try:
    os.write(tty, b'Password: ')
    password = b''
    while not password.endswith(b'\\n'):
        password += os.read(tty, 1)
finally:
    termios.tcsetattr(tty, termios.TCSANOW, previous)
    os.close(tty)
if hashlib.sha256(password[:-1]).hexdigest() != os.environ['EXPECTED_PASSWORD_SHA256']:
    sys.exit(90)
for line in sys.stdin:
    request = json.loads(line)
    data = {'sessionFile': '/controlled/session'} if request['type'] == 'get_state' else {'messages': ['rpc-intact']}
    print(json.dumps({'type': 'response', 'id': request['id'], 'command': request['type'], 'success': True, 'data': data}), flush=True)
`, { mode: 0o700 })
  const spawnProcess: typeof spawn = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const env = { ...options?.env, PATH: root + ':' + process.env.PATH, EXPECTED_PASSWORD_SHA256: createHash('sha256').update(secret).digest('hex') }
    invocations.push({ command, args, env })
    return spawn(command, args, { ...options, env })
  }) as typeof spawn
  const service = new SshWorkspace((event) => events.push(event), () => {}, spawnProcess, undefined, async () => join(root, 'ssh'))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Controlled local fake', host: 'not-a-real-host.invalid', cwd: '/controlled', authMethod: 'password' })
    await Promise.race([
      service.connect(profile, undefined, { password: secret }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Local sshpass test timed out')), 5000) }),
    ])
    expect(service.getStatus().phase).toBe('connected')
    expect((await service.command({ type: 'get_messages' })).data).toEqual({ messages: ['rpc-intact'] })
    expect(invocations).toHaveLength(1)
    expect(invocations[0].args.slice(0, 3)).toEqual(['-d', '3', join(root, 'ssh')])
    expect(JSON.stringify(invocations)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  } finally {
    clearTimeout(timer)
    service.disconnect()
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)

it.skipIf(!available)('sshpass propagates a remote missing-Pi exit 127, not a missing local ssh client (no network)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sshpass-remote-127-'))
  const secret = randomBytes(24).toString('hex')
  const events: SshWorkspaceEvent[] = []
  const fakeSsh = join(root, 'ssh')
  writeFileSync(fakeSsh, `#!/usr/bin/python3
import os, sys, hashlib, termios, shlex
tty = os.open('/dev/tty', os.O_RDWR)
previous = termios.tcgetattr(tty)
hidden = termios.tcgetattr(tty)
hidden[3] &= ~termios.ECHO
termios.tcsetattr(tty, termios.TCSANOW, hidden)
try:
    os.write(tty, b'Password: ')
    password = b''
    while not password.endswith(b'\\n'):
        password += os.read(tty, 1)
finally:
    termios.tcsetattr(tty, termios.TCSANOW, previous)
    os.close(tty)
if hashlib.sha256(password[:-1]).hexdigest() != os.environ['EXPECTED_PASSWORD_SHA256']:
    sys.exit(90)
# Execute only the client-generated POSIX body; never evaluate real login profiles in the fixture.
remote = shlex.split(sys.argv[-1])
assert remote[:2] == ['sh', '-lc'] and len(remote) == 3
os.execv('/bin/sh', ['sh', '-c', remote[2]])
`, { mode: 0o700 })
  const spawnProcess = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, { ...options, env: { ...options?.env, HOME: root, EXPECTED_PASSWORD_SHA256: createHash('sha256').update(secret).digest('hex') } })) as typeof spawn
  const service = new SshWorkspace((event) => events.push(event), () => {}, spawnProcess, undefined, async () => fakeSsh)
  try {
    const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Controlled missing remote Pi', host: 'no-network.invalid', cwd: root, piPath: join(root, 'no-pi-executable'), authMethod: 'password' })
    await expect(service.connect(profile, undefined, { password: secret })).rejects.toThrow('Pi was not found on the remote machine')
    expect(service.getStatus().error).not.toContain('sshpass could not start OpenSSH')
    expect(JSON.stringify(events)).not.toContain(secret)
  } finally { service.disconnect(); rmSync(root, { recursive: true, force: true }) }
}, 10000)
