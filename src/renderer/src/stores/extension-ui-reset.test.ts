import { afterEach, expect, it, vi } from 'vitest'
import { extensionDialogIds } from '@renderer/lib/extension-ui-dialog-dedupe'
import { useExtensionUIStore } from './extension-ui-store'
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async () => ({})) } }))
vi.mock('@renderer/stores/ui-store', () => ({ useUIStore: { getState: () => ({ historySessionFile: null }) } }))
vi.mock('@renderer/lib/extension-ui-channel', () => { throw new Error('Reset must not asynchronously initialize the IPC channel') })
afterEach(() => { extensionDialogIds.clear(); useExtensionUIStore.setState({ activePending: null, suspended: null }) })
it('clears old dialog IDs synchronously without a channel import or a late reset of new IDs', async () => {
  extensionDialogIds.add('old-dialog')
  useExtensionUIStore.getState().resetForSessionContext()
  expect(extensionDialogIds.size).toBe(0)
  extensionDialogIds.add('new-dialog')
  await Promise.resolve()
  expect(extensionDialogIds.has('new-dialog')).toBe(true)
})
