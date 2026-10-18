import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sshProfileSchema } from '@shared/ssh-workspace'

const mocks = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  ipc: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
  set: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), capabilities: vi.fn(),
  status: vi.fn(() => ({ phase: 'disconnected' })),
  probe: vi.fn(),
}))
vi.mock('electron', () => ({ app: { once: vi.fn() }, ipcMain: {
  handle: (channel: string, fn: (event: unknown, request: unknown) => Promise<unknown>) => mocks.ipc.set(channel, fn),
  removeHandler: vi.fn(),
} }))
vi.mock('../../config-store', () => ({ configStore: {
  get: (key: string) => mocks.data[key],
  set: (key: string, value: unknown) => { mocks.set(key, value); mocks.data[key] = value },
} }))
vi.mock('../../window', () => ({ getMainWindow: () => null }))
vi.mock('../../window-close-guard', () => ({ setRemoteActivityProbe: mocks.probe }))
vi.mock('../../ssh/auth', () => ({ detectSshAuthCapabilities: mocks.capabilities }))
vi.mock('../../ssh/ssh-workspace', () => ({ SshWorkspace: class {
  getStatus = mocks.status
  connect = mocks.connect
  disconnect = mocks.disconnect
  hasActiveWork = true
} }))
import { registerSshHandlers } from './ssh'

const profile = sshProfileSchema.parse({ id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Dev', host: 'dev', cwd: '/code', authMethod: 'password' })
const invoke = (name: string, req: unknown = {}) => mocks.ipc.get('ipc:ssh.' + name)!(null, req)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ipc.clear()
  mocks.data = { sshProfiles: [profile], sshSessions: { [profile.id]: '/remote/session' } }
  mocks.capabilities.mockResolvedValue({ password: false, passwordUnavailableReason: 'Install sshpass' })
  mocks.connect.mockResolvedValue({ phase: 'connected' })
  registerSshHandlers()
})
describe('SSH password IPC', () => {
  it('returns truthful async auth capabilities and wires authentication activity to the close guard', async () => {
    expect(await invoke('profiles')).toMatchObject({ profiles: [profile], authCapabilities: { password: false, passwordUnavailableReason: 'Install sshpass' } })
    expect(mocks.capabilities).toHaveBeenCalledOnce()
    expect(mocks.probe.mock.calls[0][0]()).toBe(true)
  })
  it('passes a password only as transient credentials and never writes the store', async () => {
    await invoke('connect', { id: profile.id, password: 'transient-secret' })
    expect(mocks.connect).toHaveBeenCalledWith(profile, '/remote/session', { password: 'transient-secret' })
    expect(mocks.set).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.data)).not.toContain('transient-secret')
    await invoke('connect', { id: profile.id, resume: false })
    expect(mocks.connect).toHaveBeenLastCalledWith(profile, undefined, { password: undefined })
  })
  it('keeps password values out of registry error logs for malformed IPC input', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const password of ['secret-value\nnext', 'secret-value\rnext', 'secret-value\0next', 'secret-value'.repeat(500), { nested: 'secret-value' }]) {
        await expect(invoke('connect', { id: profile.id, password })).rejects.toThrow('Invalid IPC input')
      }
      expect(mocks.connect).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalled()
      const errors = log.mock.calls.flat().map(String).join('\n')
      expect(errors).not.toContain('secret-value')
    } finally { log.mockRestore() }
  })
  it('rejects saving a password with a static error and retains the session pointer on a display-name-only rename', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(invoke('saveProfile', { ...profile, password: 'never-store-this' })).rejects.toThrow('credentials must not be saved')
      expect(log.mock.calls.flat().map(String).join('\n')).not.toContain('never-store-this')
      expect(mocks.set).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
    await invoke('saveProfile', { ...profile, name: 'Renamed' })
    expect(mocks.data.sshSessions).toEqual({ [profile.id]: '/remote/session' })
    expect(mocks.set).toHaveBeenCalledOnce()
    await invoke('saveProfile', { ...profile, host: 'different' })
    expect(mocks.data.sshSessions).toEqual({})
  })
})
