import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHost } from '../../ssh-host/host'
import { sshProfileSchema } from '@shared/ssh-workspace'
import { RemoteCodeService, type HostTransport } from './service'

/** Contract test against the actual helper: all roots/home/metadata are temporary. No SSH or Pi. */
describe('main/host unified contract', () => {
  it('browses, trusts, lists, reads and mutates only the remote workspace without spawning Pi', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'main-host-contract-'))
    const root = join(temp, 'project'); mkdirSync(root)
    writeFileSync(join(root, 'hello.txt'), 'remote text')
    writeFileSync(join(temp, 'private.txt'), 'outside')
    symlinkSync(join(temp, 'private.txt'), join(root, 'escape'))
    const spawned = vi.fn(() => { throw new Error('No subprocess should start during browse or files') })
    const host = await createHost({ home: temp, pty: false, spawn: spawned })
    const profile = sshProfileSchema.parse({ id: randomUUID(), name: 'Temporary host', host: 'test.invalid', cwd: '/' })
    const transport: HostTransport = {
      hasActiveWork: false,
      connect: async () => {}, disconnect: () => {}, getHostState: () => host.state(),
      requestHost: (op, args) => host.operation(op, args),
    }
    const service = new RemoteCodeService({ metadataDirectory: join(temp, 'client-metadata'), profiles: () => [profile], transport: () => transport, bootstrap: async () => '', emit: () => {}, localSettings: () => ({ recentProjects: ['/local'], currentProject: '/local' }) })
    try {
      await service.connect({ profile })
      expect((await service.browse(profile.id, root)).path).toBe(root)
      const prep = await service.prepareWorkspace(profile.id, root)
      const { workspace } = await service.openWorkspace(profile.id, root, prep.trustToken)
      const invoke = async (channel: string, args: Record<string, unknown>) => {
        const result = await service.route(channel, { workspaceRoot: workspace.workspaceId, ...args })
        if (!result.handled) throw new Error('Remote helper result fell through to local')
        return result.value
      }
      expect(await invoke('ipc:workspace.fs.listDir', {})).toMatchObject({ ok: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'hello.txt', path: 'hello.txt' })]) })
      expect(await invoke('ipc:workspace.fs.readText', { path: workspace.workspaceId + '/hello.txt' })).toMatchObject({ ok: true, text: 'remote text' })
      expect(await invoke('ipc:workspace.fs.readText', { path: 'escape' })).toMatchObject({ ok: false })
      expect(await invoke('ipc:workspace.fs.create', { relativePath: 'created.txt', isDirectory: false })).toMatchObject({ ok: true })
      expect(await invoke('ipc:workspace.fs.rename', { relativePath: 'created.txt', newName: 'renamed.txt' })).toMatchObject({ ok: true })
      const list = await service.route('ipc:session.list', { workspaceId: workspace.workspaceId })
      expect(list).toEqual({ handled: true, value: { sessions: [] } })
      expect(spawned).not.toHaveBeenCalled()
    } finally { await service.shutdown(); await host.dispose(); rmSync(temp, { recursive: true, force: true }) }
  })
})
