import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureExtensionUIChannel, dismissExtensionDialogState } from './extension-ui-channel'
import { ipcClient, onExtensionUIRequest } from './ipc-client'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn(async () => ({})) },
  onExtensionUIRequest: vi.fn(),
  onExtensionUIDismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('@renderer/lib/desktop-alerts', () => ({ signalDesktopAlert: vi.fn() }))
vi.mock('@renderer/lib/audio-trace', () => ({ traceAudioRenderer: vi.fn() }))
vi.mock('@renderer/lib/alert-trace', () => ({ alertTrace: vi.fn() }))
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({
  linkExtensionDialogToToolRow: vi.fn(),
  reconcileAllStaleInteractiveToolRows: vi.fn(),
  reconcileStaleInteractiveToolRows: vi.fn(),
}))

beforeEach(() => {
  useExtensionUIStore.setState({ activePending: null, suspended: null })
})

describe('dismissExtensionDialogState', () => {
  it('declines the remote naming wizard without enqueueing it, keeping other inputs typed', () => {
    ensureExtensionUIChannel()
    const receive = vi.mocked(onExtensionUIRequest).mock.calls.at(-1)![0]
    receive({ id: 'ssh-ui-fixture', method: 'input', title: 'Agent name: (default: project)', placeholder: { defaultValue: 'project' }, sessionFile: '/__pi_ssh__/host/hash/project/.sessions/file' })
    expect(useExtensionUIStore.getState().activePending).toBeNull()
    expect(ipcClient.invoke).toHaveBeenCalledWith('extension.respondUI', expect.objectContaining({ id: 'ssh-ui-fixture', cancelled: true, sessionFile: '/__pi_ssh__/host/hash/project/.sessions/file' }))
    receive({ id: 'ordinary-input', method: 'input', title: 'Branch?', placeholder: { defaultValue: 'main' } })
    expect(useExtensionUIStore.getState().activePending).toMatchObject({ method: 'input', defaultValue: 'main' })
  })
  it('clears a suspended dialog when its source dismisses it', () => {
    useExtensionUIStore.setState({
      activePending: null,
      suspended: {
        requestId: 'dialog-1',
        pending: { id: 'dialog-1', method: 'confirm', title: 'Confirm', message: 'Continue?' },
        suspendedAt: 1,
      },
    })

    dismissExtensionDialogState('dialog-1')

    expect(useExtensionUIStore.getState().suspended).toBeNull()
  })

  it('keeps a different suspended dialog', () => {
    const suspended = {
      requestId: 'dialog-2',
      pending: { id: 'dialog-2', method: 'confirm' as const, title: 'Confirm', message: 'Continue?' },
      suspendedAt: 1,
    }
    useExtensionUIStore.setState({ activePending: null, suspended })

    dismissExtensionDialogState('dialog-1')

    expect(useExtensionUIStore.getState().suspended).toEqual(suspended)
  })
})
