import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { ReferenceCodeSidebar } from './reference-code-sidebar'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'

vi.mock('./session-context-menu', () => ({ SessionContextMenuPortal: () => null }))
const original = window.piDesktop
const invoke = vi.fn()
const rows: SessionCatalogEntry[] = [
  { key: 'local:one', sessionId: 'one', sessionFile: '/one.jsonl', workspaceId: '/work/example', nativePathDisplay: '/work/example', projectName: 'example', title: 'An actual project session', targetId: 'local', locationLabel: 'Local', status: 'idle', updatedAt: 1, disconnected: false },
  { key: 'ssh:two', sessionId: 'two', sessionFile: '/__pi_ssh__/host/hash/example/.sessions/two', workspaceId: '/__pi_ssh__/host/hash/example', nativePathDisplay: '/code/example', projectName: 'example', title: 'An actual remote conversation', targetId: 'ssh:host', profileId: 'host', locationLabel: 'Example host', status: 'idle', updatedAt: 2, disconnected: false },
]
beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ currentWorkspace: '/work/example', currentSessionId: null, sessionAttention: {}, sessions: [] })
  invoke.mockResolvedValue({ sessions: rows, locations: rows.map((row) => ({ ...row, label: row.locationLabel })) })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke } })
})
afterEach(() => { cleanup(); window.piDesktop = original })
function sidebar() {
  const callbacks = { onNewSession: vi.fn(), onRoutines: vi.fn(), onCustomize: vi.fn(), onOpenProject: vi.fn(), onOpenSession: vi.fn() }
  return { ...render(<ReferenceCodeSidebar {...callbacks} openProjectLabel="Open folder" />), ...callbacks }
}
describe('reference Code sidebar', () => {
  it('retains real navigation but replaces the worktree tree with all-location conversations', async () => {
    const view = sidebar()
    await screen.findByText('An actual project session')
    expect(screen.getByText('An actual remote conversation')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New Code session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    expect(view.onNewSession).toHaveBeenCalledOnce(); expect(view.onRoutines).toHaveBeenCalledOnce(); expect(view.onCustomize).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Projects Beta' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Artifacts' })).toBeDisabled()
    expect(view.container.querySelector('[data-workspace]')).toBeNull()
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['ipc:code.sessions.list'])
    expect(screen.queryByText(/worktree|Other/)).toBeNull()
  })
  it('offers a themed scope menu, search, and delegates the exact full session identity', async () => {
    const view = sidebar()
    await screen.findByText('An actual project session')
    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
    const search = screen.getByRole('searchbox')
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.change(search, { target: { value: 'actual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'SSH' }))
    expect(search).toHaveValue('actual')
    expect(screen.queryByText('An actual project session')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /An actual remote conversation/ }))
    expect(view.onOpenSession).toHaveBeenCalledWith(rows[1])
    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
  it('keeps optional routes disabled without callbacks', () => {
    render(<ReferenceCodeSidebar onNewSession={() => {}} onOpenProject={() => {}} openProjectLabel="Open folder" />)
    expect(screen.getByRole('button', { name: 'Routines' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Customize' })).toBeDisabled()
  })
})
