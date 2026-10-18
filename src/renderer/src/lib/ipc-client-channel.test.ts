import { afterEach, expect, it, vi } from 'vitest'
import { ipcClient } from './ipc-client'
const original = window.piDesktop
afterEach(() => { window.piDesktop = original })
it('forwards canonical and shorthand method names with exactly one ipc prefix', async () => {
  const invoke = vi.fn(async () => ({ state: null }))
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke } })
  await ipcClient.invoke('runtime.getState', { workspaceId: '/local' })
  await ipcClient.invoke('ipc:runtime.getState', { workspaceId: '/__pi_ssh__/host/hash/project' })
  expect(invoke.mock.calls).toEqual([
    ['ipc:runtime.getState', { workspaceId: '/local' }],
    ['ipc:runtime.getState', { workspaceId: '/__pi_ssh__/host/hash/project' }],
  ])
})
