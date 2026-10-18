import { afterEach, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostBootstrap } from './bootstrap'
import { SshStartupSignals } from '../ssh/startup'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(nodePath: string) {
  const home = mkdtempSync(join(tmpdir(), 'ssh-bootstrap-')); directories.push(home)
  return { home, profile: { id: randomUUID(), name: 'Fixture', host: 'fixture.invalid', cwd: '/', piPath: 'pi', nodePath } }
}
it('does not let an old PATH Node shadow the compatible Pi-managed runtime', () => {
  const f = fixture('node'), bin = join(f.home, 'bin'), managed = join(f.home, '.local/share/pi-node/current/bin')
  mkdirSync(bin); mkdirSync(managed, { recursive: true })
  writeFileSync(join(bin, 'node'), "#!/bin/sh\nprintf '%s\\n' '__PI_DESKTOP_NODE_PROBE_V1__:node:16.20.0'\n", { mode: 0o700 })
  symlinkSync(process.execPath, join(managed, 'node'))
  const result = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, 'process.stdout.write("VERIFIED_NODE_OK\\n")')], { env: { PATH: bin, HOME: f.home }, encoding: 'utf8' })
  expect(result.status).toBe(0); expect(result.stdout).toBe('VERIFIED_NODE_OK\n')
  const signals = new SshStartupSignals(); for (const char of result.stderr) signals.push(char)
  expect(signals.nodeVersion).toBe(process.versions.node)
})
it('rejects explicit incompatible Node rather than silently selecting another binary', () => {
  const f = fixture('placeholder'), binary = join(f.home, 'old-node')
  writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' '__PI_DESKTOP_NODE_PROBE_V1__:node:16.20.0'\n", { mode: 0o700 })
  f.profile.nodePath = binary
  const result = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, '')], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8' })
  const signals = new SshStartupSignals(); signals.push(result.stderr)
  expect(result.status).toBe(78); expect(signals.failure(result.status, false, true)).toContain('16.20.0')
  expect(signals.failure(result.status, false, true)).toContain('22.19+')
})
it('classifies import syntax failures without reflecting module contents', () => {
  const f = fixture(process.execPath)
  const result = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, 'const private_fixture_value = >>>;')], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8' })
  const signals = new SshStartupSignals(); signals.push(result.stderr)
  expect(result.status).toBe(70); expect(signals.failure(result.status, false, true)).toContain('could not be parsed')
  expect(result.stderr).not.toContain('private_fixture_value')
})

it('does not accept a version-looking stdout from a failing probe or wait forever on a wrapper', () => {
  const f = fixture('placeholder'), binary = join(f.home, 'probe-wrapper')
  f.profile.nodePath = binary
  writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' '__PI_DESKTOP_NODE_PROBE_V1__:node:22.23.3'\nexit 7\n", { mode: 0o700 })
  const rejected = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, '')], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8', timeout: 5000 })
  const invalid = new SshStartupSignals(); invalid.push(rejected.stderr)
  expect(invalid.failure(rejected.status, false, true)).toContain('could not report a valid Node version')
  writeFileSync(binary, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 })
  const began = Date.now()
  const bounded = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, '')], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8', timeout: 6000 })
  expect(Date.now() - began).toBeLessThan(5500)
  expect(bounded.status).toBe(78)
})

it('reports remote Node absence using fixed stage signals, without claiming missing local SSH or Pi', () => {
  const f = fixture('/definitely-missing-node')
  const result = spawnSync('/bin/sh', ['-c', hostBootstrap(f.profile, '')], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8' })
  expect(result.status).toBe(127); expect(result.stdout).toBe('')
  const signals = new SshStartupSignals(); signals.push(result.stderr)
  expect(signals.failure(result.status, false, true)).toContain('configured remote Node executable was not found')
})
it('uses an explicit POSIX wrapper and expands configured home-relative Node paths', () => {
  const f = fixture('~/runtime/node'); mkdirSync(join(f.home, 'runtime')); symlinkSync(process.execPath, join(f.home, 'runtime/node'))
  const command = hostBootstrap(f.profile, 'process.stdout.write("HOST_BOOTSTRAP_OK\\n")')
  expect(command).toMatch(/^exec \/bin\/sh -c /)
  expect(execFileSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', HOME: f.home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('HOST_BOOTSTRAP_OK\n')
})
