import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHost } from '../../ssh-host/host'
import { sshProfileSchema } from '@shared/ssh-workspace'
import { RemoteCodeService, type HostTransport } from './service'

describe('SSH metadata-only catalog', () => {
  it('lists all saved hosts without selecting/starting Pi, caches disconnected rows, denies changed fingerprints', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'catalog-host-'))
    const root = join(temp, 'project'); mkdirSync(root)
    const spawn = vi.fn(() => { throw new Error('Unexpected Pi/auth subprocess') })
    const host = await createHost({ home: temp, pty: false, spawn })
    const profiles = [0, 1].map((n) => sshProfileSchema.parse({ id: randomUUID(), name: `Host ${n}`, host: `host-${n}.invalid`, cwd: '/' }))
    const dial = vi.fn(async () => {})
    const transport = (): HostTransport => ({ hasActiveWork: false, connect: dial, disconnect: () => {}, getHostState: () => host.state(), requestHost: (op, args) => host.operation(op, args) })
    const service = new RemoteCodeService({ metadataDirectory: join(temp, 'client'), profiles: () => profiles, transport, bootstrap: async () => '', emit: () => {}, localSettings: () => ({ recentProjects: ['/local'], currentProject: '/local' }) })
    try {
      const ws = await host.operation('workspace.register', { path: root, trusted: true }) as { id: string }
      const directory = join(temp, '.pi', 'desktop-code', 'sessions', ws.id)
      mkdirSync(directory, { recursive: true })
      const header = { type: 'session', version: 3, id: 'real', timestamp: new Date().toISOString(), cwd: root }
      writeFileSync(join(directory, 'real.jsonl'), JSON.stringify(header) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'Real message' } }) + '\n', { mode: 0o600 })
      for (const profile of profiles) {
        await service.connect({ profile, activate: false })
        const prep = await service.prepareWorkspace(profile.id, root)
        await service.openWorkspace(profile.id, root, prep.trustToken)
      }
      service.local()
      const before = dial.mock.calls.length
      const locations = service.sessionCatalogLocations
      expect(locations).toHaveLength(2)
      const a = await service.listSessionCatalog(locations[0].workspaceId)
      const b = await service.listSessionCatalog(locations[1].workspaceId)
      expect(a[0].key).not.toBe(b[0].key)
      expect(a[0]).toMatchObject({ messageCount: 1, firstMessage: 'Real message', hasUserMessages: true })
      expect(service.snapshot.targetId).toBe('local'); expect(dial).toHaveBeenCalledTimes(before); expect(spawn).not.toHaveBeenCalled()
      service.disconnect(profiles[0].id)
      expect(await service.listSessionCatalog(locations[0].workspaceId)).toMatchObject([{ disconnected: true }])
      expect(dial).toHaveBeenCalledTimes(before)
      profiles[0] = { ...profiles[0], host: 'changed.invalid' }
      expect(service.sessionCatalogLocations).toHaveLength(1)
      await expect(service.listSessionCatalog(locations[0].workspaceId)).rejects.toThrow('changed')
    } finally { await service.shutdown(); await host.dispose(); rmSync(temp, { recursive: true, force: true }) }
  })
  it('hides only confirmed empty tagged utilities; preserves explicit, renamed, message and incomplete files', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'catalog-empty-'))
    const root = join(temp, 'project'); mkdirSync(root)
    const host = await createHost({ home: temp, pty: false, spawn: () => { throw new Error('must not start') } })
    try {
      const ws = await host.operation('workspace.register', { path: root, trusted: true }) as { id: string }
      const dir = join(temp, '.pi', 'desktop-code', 'sessions', ws.id); mkdirSync(dir, { recursive: true })
      const put = (id: string, utility: boolean, extra = '') => writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: root, desktopUtility: utility }) + '\n' + extra, { mode: 0o600 })
      put('utility', true)
      put('explicit', false)
      put('renamed', true, JSON.stringify({ type: 'session_info', name: 'My named session' }) + '\n')
      put('user', true, JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }) + '\n')
      put('tool', true, JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'result' } }) + '\n')
      put('truncated', true, '{"type":"message"')
      put('custom', true, JSON.stringify({ type: 'custom', data: { content: 'Preserve unknown history' } }) + '\n')
      put('opened', true)
      writeFileSync(join(dir, 'opened.jsonl.desktop-opened'), '', { mode: 0o600 })
      const result = await host.operation('session.list', { workspaceId: ws.id }) as { sessions: { sessionId: string; messageCount?: number }[] }
      expect(result.sessions.map((row) => row.sessionId).sort()).toEqual(['custom', 'explicit', 'opened', 'renamed', 'tool', 'truncated', 'user'])
      expect(result.sessions.find((row) => row.sessionId === 'truncated')?.messageCount).toBeUndefined()
    } finally { await host.dispose(); rmSync(temp, { recursive: true, force: true }) }
  })
})
