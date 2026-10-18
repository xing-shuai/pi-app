import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ handlers: new Map<string, (req: unknown) => Promise<unknown>>(), service: { snapshot: { targetId: 'local', connections: [], workspaces: [] }, connect: vi.fn(), local: vi.fn(), select: vi.fn(), browse: vi.fn(), prepareWorkspace: vi.fn(), openWorkspace: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../registry', () => ({ registerHandler: (channel: string, handler: (req: unknown) => Promise<unknown>) => f.handlers.set(channel, handler) }))
vi.mock('../../remote-code', () => ({ getRemoteCodeService: () => f.service }))
import { registerRemoteCodeHandlers } from './remote-code'
beforeEach(() => { f.handlers.clear(); vi.clearAllMocks(); registerRemoteCodeHandlers() })
describe('remote Code root IPC', () => {
  it('registers exactly eight narrow environment endpoints, never a raw host operation', async () => {
    expect([...f.handlers.keys()].sort()).toEqual(['ipc:code.environment.get', 'ipc:code.environment.local', 'ipc:code.ssh.connect', 'ipc:code.ssh.select', 'ipc:code.ssh.browse', 'ipc:code.ssh.prepareWorkspace', 'ipc:code.ssh.openWorkspace', 'ipc:code.ssh.disconnect'].sort())
    expect(await f.handlers.get('ipc:code.environment.get')!({})).toBe(f.service.snapshot)
  })
  it('rejects credential-bearing invalid inputs with a static error', async () => {
    const secret = 'do-not-log-this-password'
    for (const payload of [{ profileId: 'not-uuid', password: secret }, { profileId: '175a1f7f-75bd-47f0-8188-788282755caf', password: secret, arbitraryCommand: secret }]) {
      await expect(f.handlers.get('ipc:code.ssh.connect')!(payload)).rejects.toThrow('Invalid remote Code environment request')
    }
    expect(f.service.connect).not.toHaveBeenCalled()
  })
  it('passes draft profiles and transient credentials with explicit no-activation; rejects saved passwords', async () => {
    const profile = { id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Draft', host: 'test.invalid', cwd: '/', authMethod: 'password' }
    await f.handlers.get('ipc:code.ssh.connect')!({ profile, password: 'transient', activate: false })
    expect(f.service.connect).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining(profile), password: 'transient', activate: false }))
    await expect(f.handlers.get('ipc:code.ssh.connect')!({ profile: { ...profile, password: 'not-persistable' } })).rejects.toThrow('Invalid remote Code')
  })
})
