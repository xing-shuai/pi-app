import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { rememberRemoteWorkspacePaths, remoteCodeFileTarget } from './remote-code-paths'
import { openCodeFile } from './code-file-actions'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })) }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke } }))
const root = '/__pi_ssh__/host-a/root-hash/project'
const other = '/__pi_ssh__/host-b/root-hash/project'
beforeEach(() => {
  invoke.mockClear()
  rememberRemoteWorkspacePaths([{ workspaceId: root, targetId: 'ssh:host-a', profileId: 'host-a', nativePath: '/srv/project', name: 'project', hostLabel: 'user@host-a' }, { workspaceId: other, targetId: 'ssh:host-b', profileId: 'host-b', nativePath: '/srv/project', name: 'project', hostLabel: 'user@host-b' }])
  useUIStore.setState({ currentWorkspace: root, workspaceFileToOpen: null })
})
describe('Code file actions never open remote paths on this computer', () => {
  it('maps native remote links into the same Files panel', async () => {
    await expect(openCodeFile('/srv/project/src/hello.ts', { workspaceId: root, line: 12 })).resolves.toEqual({ ok: true })
    expect(useUIStore.getState().workspaceFileToOpen).toEqual({ workspaceRoot: root, rel: 'src/hello.ts', line: 12 })
    expect(invoke).not.toHaveBeenCalled()
  })
  it.each(['/etc/passwd', '/srv/project/../private', '/srv/project2/file', `${other}/file`, `${root}/.outside/etc/passwd`, 'C:\\Users\\private.txt'])('rejects outside or cross-host path %s without local shell IO', async (path) => {
    expect((await openCodeFile(path, { workspaceId: root })).ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(useUIStore.getState().workspaceFileToOpen).toBeNull()
  })
  it('never reveals remote files in a local OS file manager', async () => {
    expect((await openCodeFile(`${root}/hello.ts`, { reveal: true })).ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('does not execute a stale local action after switching to SSH', async () => {
    expect((await openCodeFile('/local/private', { workspaceId: '/local' })).ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('does not execute a stale SSH action after switching to Local', async () => {
    useUIStore.setState({ currentWorkspace: '/local' })
    expect((await openCodeFile('/srv/project/hello.ts', { workspaceId: root })).ok).toBe(false)
    expect((await openCodeFile(`${root}/hello.ts`)).ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('preserves explicit local OS open behavior', async () => {
    useUIStore.setState({ currentWorkspace: '/local' })
    await expect(openCodeFile('/local/file.pdf', { workspaceId: '/local' })).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('shell.openPath', { path: '/local/file.pdf' })
  })
  it('does not guess native roots for unknown virtual keys', () => {
    expect(remoteCodeFileTarget('/srv/project/hello', '/__pi_ssh__/unknown/root/project')).toBeNull()
  })
})
