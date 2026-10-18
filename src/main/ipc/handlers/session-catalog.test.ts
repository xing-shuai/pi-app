import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCatalog, registerSessionCatalogHandlers } from './session-catalog'
const f = vi.hoisted(() => ({ list: vi.fn(), invalidate: vi.fn<(workspaceId: string) => Promise<void>>(async () => {}), sandbox: vi.fn(), register: vi.fn(), remoteList: vi.fn(), locations: [] as unknown[], config: { recentProjects: ['/native', '/missing', '/__pi_ssh__/do-not-query'], currentProject: '/native' } }))
vi.mock('../../config-store', () => ({ configStore: { get: (key: keyof typeof f.config) => f.config[key] } }))
vi.mock('../../session-preview-process', () => ({ sessionPreviewProcess: { listSessions: f.list, invalidateListSessions: f.invalidate } }))
vi.mock('../../sandbox-workspaces', () => ({ listSandboxWorkspaces: f.sandbox }))
vi.mock('../../remote-code', () => ({ getRemoteCodeService: () => ({ sessionCatalogLocations: f.locations, listSessionCatalog: f.remoteList }) }))
vi.mock('../../session-display-names', () => ({ resolveSessionListTitle: (_file: string, fallback: string, name?: string) => name || fallback }))
vi.mock('../../worker-manager', () => ({ workerManager: { listSessionRuntime: () => [] } }))
vi.mock('../../wsl/runtime-config', () => ({ getAgentRuntimeConfig: () => ({ mode: 'native' }) }))
vi.mock('../registry', () => ({ registerHandler: f.register }))
beforeEach(() => {
  vi.clearAllMocks(); f.locations = []
  f.sandbox.mockResolvedValue([{ path: '/sandbox' }])
  f.list.mockImplementation(async (path: string) => {
    if (path === '/missing') throw new Error('missing')
    return [{ id: path, path: `${path}.jsonl`, cwd: path, name: 'Real conversation', modified: new Date(42), messageCount: 1 }]
  })
})
describe('session catalog IPC', () => {
  it('uses only known explicit native workspace queries and preserves partial results', async () => {
    const result = await createSessionCatalog().list()
    expect(f.list.mock.calls.map(([path]) => path).sort()).toEqual(['/missing', '/native', '/sandbox'])
    expect(f.invalidate.mock.calls.map(([path]) => path).sort()).toEqual(['/missing', '/native', '/sandbox'])
    for (const [index, [path]] of f.list.mock.calls.entries()) {
      const invalidation = f.invalidate.mock.calls.findIndex(([item]) => item === path)
      expect(f.invalidate.mock.invocationCallOrder[invalidation]).toBeLessThan(f.list.mock.invocationCallOrder[index])
    }
    expect(result.sessions.map((row) => row.workspaceId).sort()).toEqual(['/native', '/sandbox'])
    expect(result.locations.find((location) => location.workspaceId === '/missing')?.error).toBeDefined()
    expect(f.remoteList).not.toHaveBeenCalled()
    expect(f.config.currentProject).toBe('/native')
  })
  it('registers the literal channel and validates inputs', async () => {
    registerSessionCatalogHandlers()
    expect(f.register).toHaveBeenCalledWith('ipc:code.sessions.list', expect.any(Function))
    const handler = f.register.mock.calls[0][1]
    await expect(handler({ password: 'not allowed' })).rejects.toThrow('Invalid session catalog request')
    expect(f.list).not.toHaveBeenCalled()
    await expect(handler({ filter: 'local', search: 'conversation' })).resolves.toMatchObject({ sessions: expect.any(Array) })
  })
})
