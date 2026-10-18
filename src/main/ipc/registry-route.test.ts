import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => mocks.handlers.set(channel, handler), removeHandler: (channel: string) => mocks.handlers.delete(channel) } }))
import { invokeHandler, registerHandler, setIpcInvokeRouter } from './registry'
const channel = 'ipc:workspace.fs.readText'
beforeEach(() => { setIpcInvokeRouter(async () => ({ handled: false })); mocks.handlers.clear() })
describe('execution routing precedes local IO', () => {
  it('never invokes a local file handler after a remote routing rejection', async () => {
    const local = vi.fn(async () => 'client secret')
    registerHandler(channel, local)
    setIpcInvokeRouter(async () => { throw new Error('Unknown remote workspace') })
    const request = { workspaceRoot: '/__pi_ssh__/unknown', path: '/etc/passwd' }
    await expect(mocks.handlers.get(channel)!(null, request)).rejects.toThrow('Unknown remote workspace')
    await expect(invokeHandler(channel, request)).rejects.toThrow('Unknown remote workspace')
    expect(local).not.toHaveBeenCalled()
  })
  it('returns remote falsy results without falling back to local', async () => {
    const local = vi.fn(async () => 'local')
    registerHandler(channel, local)
    setIpcInvokeRouter(async () => ({ handled: true, value: false }))
    await expect(invokeHandler(channel, {})).resolves.toBe(false)
    expect(local).not.toHaveBeenCalled()
  })
  it('preserves the existing local handler when routing explicitly declines', async () => {
    const local = vi.fn(async (request: unknown) => request)
    registerHandler(channel, local)
    await expect(invokeHandler(channel, { path: 'local.txt' })).resolves.toEqual({ path: 'local.txt' })
    expect(local).toHaveBeenCalledOnce()
  })
})
