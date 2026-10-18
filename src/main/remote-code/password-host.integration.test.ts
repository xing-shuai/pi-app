// @vitest-environment node
import { beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { SshWorkspace } from '../ssh/ssh-workspace'
import { hostBootstrap } from './bootstrap'
import type { SshWorkspaceEvent } from '@shared/ssh-workspace'
let available = process.platform === 'linux' && existsSync('/usr/bin/python3')
try { execFileSync('sshpass', ['-V'], { stdio: 'ignore', timeout: 1500 }) } catch { available = false }
let source = ''
beforeAll(async () => { if (available) source = (await build({ entryPoints: ['src/ssh-host/entry.ts'], bundle: true, platform: 'node', format: 'esm', write: false })).outputFiles[0].text })
it.skipIf(!available).each(['pipe', 'null-stdin', 'exit-wrapper', 'exit-preload', 'bad-home'] as const)('real sshpass → POSIX bootstrap → bundled host: %s (no network)', async (mode) => {
  const home = mkdtempSync(join(tmpdir(), 'password-host-'))
  const password = randomBytes(24).toString('hex'), events: SshWorkspaceEvent[] = []
  const shim = join(home, 'ssh'), wrapper = join(home, 'node-wrapper'), preload = join(home, 'preload.cjs')
  writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(preload, 'process.exit(0)\n', { mode: 0o600 })
  writeFileSync(shim, `#!/usr/bin/python3
import os,sys,hashlib,termios
fd=os.open('/dev/tty',os.O_RDWR)
previous=termios.tcgetattr(fd)
hidden=termios.tcgetattr(fd);hidden[3]&=~termios.ECHO
termios.tcsetattr(fd,termios.TCSANOW,hidden)
try:
 os.write(fd,b'Password: ')
 value=b''
 while not value.endswith(b'\\n'): value+=os.read(fd,1)
finally:
 termios.tcsetattr(fd,termios.TCSANOW,previous);os.close(fd)
if hashlib.sha256(value[:-1]).hexdigest()!=os.environ['EXPECTED_SHA256']:sys.exit(90)
env={'HOME':os.environ['REMOTE_HOME'],'PATH':'/usr/bin:/bin','SHELL':'/bin/sh'}
if os.environ['FIXTURE_MODE']=='null-stdin':
 null=os.open('/dev/null',os.O_RDONLY);os.dup2(null,0);os.close(null)
if os.environ['FIXTURE_MODE']=='exit-preload':env['NODE_OPTIONS']='--require='+os.environ['PRELOAD_PATH']
if os.environ['FIXTURE_MODE']=='bad-home':env['HOME']=os.path.join(env['HOME'],'missing-home')
os.execve('/bin/sh',['sh','-c',sys.argv[-1]],env)
`, { mode: 0o700 })
  const spawnProcess = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, { ...options, env: { ...options?.env, EXPECTED_SHA256: createHash('sha256').update(password).digest('hex'), REMOTE_HOME: home, FIXTURE_MODE: mode, PRELOAD_PATH: preload } })) as typeof spawn
  const workspace = new SshWorkspace((event) => events.push(event), () => {}, spawnProcess, undefined, async () => shim)
  const profile = { id: randomUUID(), name: 'Fixture', host: 'fixture.invalid', authMethod: 'password' as const, cwd: '/', piPath: 'pi', nodePath: mode === 'exit-wrapper' ? wrapper : process.execPath }
  try {
    const pending = workspace.connect(profile, undefined, { password }, { hostMode: true, remoteCommand: hostBootstrap(profile, source) })
    if (mode === 'pipe') {
      await pending
      expect(workspace.getHostState()?.home).toBe(home)
      expect(await workspace.requestHost('browse', { path: home })).toMatchObject({ path: home })
    } else await expect(pending).rejects.toThrow(mode === 'null-stdin' ? 'standard input closed' : mode === 'bad-home' ? 'remote HOME directory' : 'could not report a valid Node version')
    expect(JSON.stringify(events)).not.toContain(password)
  } finally { workspace.disconnect(); rmSync(home, { recursive: true, force: true }) }
}, 20000)
