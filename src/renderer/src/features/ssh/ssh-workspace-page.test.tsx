import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshWorkspaceEvent } from '@shared/ssh-workspace'
import { SshWorkspacePage } from './ssh-workspace-page'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const profile = { id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Test server', host: 'test-server', cwd: '/remote/project', piPath: 'pi', nodePath: 'node' }
let emit: (event: SshWorkspaceEvent) => void
let invoke: ReturnType<typeof vi.fn>
const original = window.piDesktop
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  invoke = vi.fn(async (channel: string, request?: { type?: string }) => {
    if (channel === 'ipc:ssh.profiles') return { profiles: [profile], status: { phase: 'disconnected' } }
    if (channel === 'ipc:ssh.connect') { emit({ kind: 'status', status: { phase: 'connected', profileId: profile.id, model: 'mock/remote' } }); return {} }
    if (channel === 'ipc:ssh.command') {
      if (request?.type === 'get_messages') return { data: { messages: [] } }
      if (request?.type === 'get_available_models') return { data: { models: [{ id: 'remote', provider: 'mock' }] } }
      return { type: 'response', success: true, data: {} }
    }
    if (channel === 'ipc:ssh.files') return { path: '', entries: [{ name: 'README.md', path: 'README.md', directory: false }] }
    return {}
  })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke, onSshEvent: (fn: typeof emit) => { emit = fn; return vi.fn() } } })
})
afterEach(() => { cleanup(); window.piDesktop = original })
async function connected() {
  render(<SshWorkspacePage onBack={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect workspace' }))
  await screen.findByPlaceholderText('Ask Pi to work in your remote workspace…')
  await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled())
}
describe('SSH workspace screen', () => {
  it('connects by profile ID and sends prompts only to the SSH service', async () => {
    await connected()
    fireEvent.change(screen.getByLabelText('Remote message'), { target: { value: 'Review remote code' } })
    fireEvent.click(screen.getByTitle('Send'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:ssh.command', { type: 'prompt', message: 'Review remote code' }))
    expect(invoke).toHaveBeenCalledWith('ipc:ssh.connect', { id: profile.id })
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('ipc:ssh.'))).toBe(true)
  })
  it('asks for a fresh password at connect time, not when saving the profile', async () => {
    const base = invoke.getMockImplementation()! as (channel: string, request?: unknown) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: unknown) => channel === 'ipc:ssh.profiles' ? Promise.resolve({ profiles: [{ ...profile, authMethod: 'password' }], status: { phase: 'disconnected' }, authCapabilities: { password: true } }) : base(channel, request))
    render(<SshWorkspacePage onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect workspace' }))
    const input = await screen.findByLabelText('Password')
    expect(invoke).not.toHaveBeenCalledWith('ipc:ssh.connect', expect.anything())
    fireEvent.change(input, { target: { value: 'temporary-ui-test-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:ssh.connect', { id: profile.id, password: 'temporary-ui-test-password' }))
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('ipc:ssh.saveProfile', expect.objectContaining({ password: expect.anything() }))
  })

  it('discards password input when the SSH page is hidden', async () => {
    const base = invoke.getMockImplementation()! as (channel: string, request?: unknown) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: unknown) => channel === 'ipc:ssh.profiles' ? Promise.resolve({ profiles: [{ ...profile, authMethod: 'password' }], status: { phase: 'disconnected' }, authCapabilities: { password: true } }) : base(channel, request))
    const { rerender } = render(<SshWorkspacePage active onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect workspace' }))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'discarded-ui-test-secret' } })
    rerender(<SshWorkspacePage active={false} onBack={vi.fn()} />)
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    rerender(<SshWorkspacePage active onBack={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect workspace' }))
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(invoke).not.toHaveBeenCalledWith('ipc:ssh.connect', expect.anything())
  })

  it('never automatically grants extension permissions', async () => {
    await connected()
    act(() => emit({ kind: 'record', record: { type: 'extension_ui_request', id: 'permission-1', method: 'confirm', title: 'Allow command?', message: 'Run dangerous command?' } }))
    expect(screen.getByRole('dialog', { name: 'Allow command?' })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('ipc:ssh.command', expect.objectContaining({ type: 'extension_ui_response' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:ssh.command', { type: 'extension_ui_response', id: 'permission-1', cancelled: true }))
  })
  it('browses files through remote RPC and clears running state on disconnect', async () => {
    await connected()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'README.md' })
    expect(invoke).toHaveBeenCalledWith('ipc:ssh.files', { action: 'list', path: '' })
    act(() => emit({ kind: 'record', record: { type: 'agent_start' } }))
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
    act(() => emit({ kind: 'status', status: { phase: 'disconnected', error: 'Network lost' } }))
    expect(screen.getByRole('alert')).toHaveTextContent('Network lost')
    expect(screen.queryByTitle('Stop')).not.toBeInTheDocument()
  })
})
