import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sshArgs, REMOTE_STARTUP_MARKERS } from '../ssh/command'
import { SshStartupSignals } from '../ssh/startup'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('uses the real OpenSSH parser to override config that discards RPC stdin or forks', () => {
  const home = mkdtempSync(join(tmpdir(), 'ssh-stdin-config-')); dirs.push(home)
  const config = join(home, 'config')
  writeFileSync(config, 'Host *\n  StdinNull yes\n  ForkAfterAuthentication yes\n  RemoteCommand exit 0\n', { mode: 0o600 })
  const profile = { id: randomUUID(), name: 'Fixture', host: 'fixture.invalid', cwd: '/', piPath: 'pi', nodePath: 'node' }
  const args = sshArgs(profile, undefined, 'exec /bin/sh -c true')
  expect(args.at(-1)).not.toContain(' -lc ')
  const result = execFileSync('ssh', ['-G', '-F', config, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  expect(result).toMatch(/^stdinnull no$/m)
  expect(result).toMatch(/^forkafterauthentication no$/m)
  const remoteCommand = result.split('\n').find((line) => line.startsWith('remotecommand '))?.slice('remotecommand '.length)
  expect([undefined, 'none']).toContain(remoteCommand)
})
it('distinguishes clean EOF, invalid framing, and an executable that ignored JavaScript', () => {
  const eof = new SshStartupSignals(); eof.push(REMOTE_STARTUP_MARKERS.hostStarting + REMOTE_STARTUP_MARKERS.hostRuntime + REMOTE_STARTUP_MARKERS.hostInputClosed)
  expect(eof.failure(0, false, true)).toContain('standard input closed')
  const invalid = new SshStartupSignals(); invalid.push(REMOTE_STARTUP_MARKERS.hostStarting + REMOTE_STARTUP_MARKERS.hostInputInvalid)
  expect(invalid.failure(0, false, true)).toContain('invalid RPC input')
  const launcher = new SshStartupSignals(); launcher.push(REMOTE_STARTUP_MARKERS.hostStarting)
  expect(launcher.failure(0, false, true)).toContain('before running JavaScript')
  expect(eof.failure(0, true, true)).toContain('outcomes may be unknown')
})
