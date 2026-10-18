import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { sshProfileSchema } from '@shared/ssh-workspace'
import { REMOTE_STARTUP_MARKERS, remoteStartupCommand } from './command'
import { SshStartupSignals, stripStartupMarkers } from './startup'
import { resolveLocalOpenSsh } from './executable'

const base = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Fixture', host: 'no-network.invalid', cwd: '/tmp' })
describe('remote startup phase classification', () => {
  it('recognizes fixed stage markers split at every byte without retaining raw diagnostics', () => {
    const marker = REMOTE_STARTUP_MARKERS.piMissing
    for (let split = 1; split < marker.length; split++) {
      const state = new SshStartupSignals()
      state.push('ignored-private-banner\n' + marker.slice(0, split)); state.push(marker.slice(split) + '\n')
      expect(state.failure(127, false, true)).toContain('Pi was not found on the remote machine')
      expect(JSON.stringify(state)).not.toContain('ignored-private-banner')
    }
  })
  it('does not turn a remote 127 or remote 5 into missing-local-SSH or wrong-password claims', () => {
    const state = new SshStartupSignals()
    state.push(REMOTE_STARTUP_MARKERS.shell + '\n' + REMOTE_STARTUP_MARKERS.starting)
    expect(state.failure(127, false, true)).toContain('Remote Pi could not start')
    expect(state.failure(5, false, true)).toContain('Remote Pi exited (5)')
    expect(state.failure(127, true, true)).toContain('SSH connection closed')
    expect(new SshStartupSignals().failure(127, false, true)).toContain('does not prove that local ssh is missing')
  })
  it('filters internal signals from key-auth diagnostic output', () => {
    expect(stripStartupMarkers(REMOTE_STARTUP_MARKERS.shell)).toBe('')
    expect(stripStartupMarkers('normal warning')).toBe('normal warning')
  })
})
describe('remote POSIX startup probe (local fixtures only)', () => {
  it('keeps stdout protocol-clean and safely quotes executable/cwd/session paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-remote-probe-'))
    try {
      const cwd = join(root, "work's 雪"); mkdirSync(cwd)
      const pi = join(root, "pi's script"); writeFileSync(pi, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 })
      const session = "/remote/a'b;$(touch not-created).jsonl"
      const result = spawnSync('sh', ['-c', remoteStartupCommand({ ...base, cwd, piPath: pi }, session)], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout.split('\n')).toEqual(['--mode', 'rpc', '--session', session, ''])
      expect(result.stderr).toContain(REMOTE_STARTUP_MARKERS.shell)
      expect(result.stderr).toContain(REMOTE_STARTUP_MARKERS.starting)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('finds the standard remote Pi shim and puts configured Node on its PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-remote-path-'))
    try {
      const shim = join(root, '.pi/agent/bin'); mkdirSync(shim, { recursive: true })
      writeFileSync(join(shim, 'pi'), '#!/bin/sh\ncommand -v node\n', { mode: 0o700 })
      const nodeDir = join(root, 'node runtime'); mkdirSync(nodeDir)
      const node = join(nodeDir, 'node'); writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      const result = spawnSync('sh', ['-c', remoteStartupCommand({ ...base, cwd: root, nodePath: node })], { encoding: 'utf8', env: { ...process.env, HOME: root, PATH: '/usr/bin:/bin' } })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(node)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['cwd', 'pi', 'node'] as const)('distinguishes missing remote %s before RPC', (part) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-remote-missing-'))
    try {
      const result = spawnSync('sh', ['-c', remoteStartupCommand({ ...base, cwd: part === 'cwd' ? join(root, 'absent') : root, piPath: join(root, 'absent-pi'), nodePath: part === 'node' ? join(root, 'absent-node') : 'node' })], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(part === 'cwd' ? REMOTE_STARTUP_MARKERS.cwdMissing : part === 'node' ? REMOTE_STARTUP_MARKERS.nodeMissing : REMOTE_STARTUP_MARKERS.piMissing)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
describe('verified local OpenSSH executable', () => {
  it('finds only executable files and returns an absolute client path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-local-ssh-path-'))
    try {
      const first = join(root, 'first'), second = join(root, 'second'); mkdirSync(first); mkdirSync(second)
      writeFileSync(join(first, 'ssh'), 'not executable', { mode: 0o600 })
      writeFileSync(join(second, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      expect(await resolveLocalOpenSsh(first + delimiter + second)).toBe(join(second, 'ssh'))
      chmodSync(join(second, 'ssh'), 0o600)
      expect(await resolveLocalOpenSsh(first + delimiter + second)).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
