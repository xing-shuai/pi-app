import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sshProfileSchema } from '@shared/ssh-workspace'
import { quotePosix, remoteFilesCommand, sshArgs } from './command'

const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Dev', host: 'my-server', cwd: "/home/dev/a'b;$(touch nope)" })
describe('SSH command boundaries', () => {
  it('quotes POSIX paths without evaluating metacharacters', () => {
    const value = "a'b\";$(echo INJECTED)\n雪"
    expect(execFileSync('sh', ['-c', `printf %s ${quotePosix(value)}`], { encoding: 'utf8' })).toBe(value)
  })
  it('uses noninteractive OpenSSH with strict known-host checking, no shell or forwarding', () => {
    const args = sshArgs({ ...profile, user: 'dev', port: 2222, identityFile: '/local/key' }, "/remote/session 'quoted'.jsonl")
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ForwardAgent=no')
    expect(args).toContain('ClearAllForwardings=yes')
    expect(args).toContain('PermitLocalCommand=no')
    expect(args.slice(-3, -1)).toEqual(['--', 'my-server'])
    expect(args).toContain('2222')
    expect(args.at(-1)).toContain('sh -lc ')
    expect(args.at(-1)).toContain('--mode rpc')
    expect(args.at(-1)).toContain('--session')
  })
  it.each(['-oProxyCommand=evil', 'user@server', 'host;touch pwned', 'host\nnext', '$(evil)'])('rejects invalid host %s', (host) => {
    expect(sshProfileSchema.safeParse({ ...profile, host }).success).toBe(false)
  })
  it('supports config aliases and IPv6, but rejects relative workspace paths and controls', () => {
    expect(sshProfileSchema.safeParse({ ...profile, host: '2001:db8::1' }).success).toBe(true)
    expect(sshProfileSchema.safeParse({ ...profile, cwd: '../project' }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ ...profile, piPath: 'pi\nrm -rf' }).success).toBe(false)
  })
  it('executes file helper only within remote workspace and never follows escaping symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-files-'))
    const outside = mkdtempSync(join(tmpdir(), 'ssh-outside-'))
    try {
      const p = { ...profile, cwd: root, nodePath: process.execPath }
      writeFileSync(join(root, "a'b.txt"), 'hello 雪')
      writeFileSync(join(outside, 'secret'), 'must not read')
      mkdirSync(join(root, 'folder'))
      symlinkSync(outside, join(root, 'escape'))
      const exec = (action: 'list' | 'read', path: string) => JSON.parse(execFileSync('sh', ['-c', remoteFilesCommand(p, action, path)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(exec('list', '').entries.map((e: { name: string }) => e.name)).toEqual(['folder', "a'b.txt"])
      expect(exec('read', "a'b.txt").text).toBe('hello 雪')
      expect(() => exec('read', 'escape/secret')).toThrow()
      expect(() => exec('list', '..')).toThrow()
      expect(() => exec('read', '/etc/passwd')).toThrow()
      writeFileSync(join(root, 'too-large'), 'x'.repeat(4097))
      expect(() => exec('read', 'too-large')).toThrow()
      writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]))
      expect(() => exec('read', 'binary')).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
  })
})
