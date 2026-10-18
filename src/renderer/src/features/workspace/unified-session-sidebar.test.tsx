import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'
import { UnifiedSessionSidebar } from './unified-session-sidebar'
vi.mock('./session-context-menu', () => ({ SessionContextMenuPortal: () => null }))
const original = window.piDesktop
const entry = (targetId: SessionCatalogEntry['targetId'], time: number): SessionCatalogEntry => ({ key: targetId, sessionId: targetId, sessionFile: `${targetId}/file`, workspaceId: `${targetId}/workspace`, nativePathDisplay: '/same/path', projectName: 'Example project', title: `Conversation ${targetId}`, targetId, locationLabel: targetId === 'local' ? 'Local' : 'Host ' + targetId.slice(4), profileId: targetId.startsWith('ssh:') ? targetId.slice(4) : undefined, status: targetId === 'local' ? 'busy' : 'idle', updatedAt: time, disconnected: targetId === 'ssh:b' })
const rows = [entry('local', 1), entry('ssh:a', 3), entry('ssh:b', 2)]
const invoke = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ currentWorkspace: null, currentSessionId: null, sessions: [], sessionAttention: {} })
  invoke.mockResolvedValue({ sessions: rows, locations: rows.map((row) => ({ targetId: row.targetId, profileId: row.profileId, label: row.locationLabel, workspaceId: row.workspaceId })) })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke } })
})
afterEach(() => { cleanup(); window.piDesktop = original })
describe('unified flat session sidebar', () => {
  it('lists real rows across locations by recency, filters and opens the full identity only on click', async () => {
    const open = vi.fn()
    render(<UnifiedSessionSidebar onOpenSession={open} onNewSession={() => {}} onOpenProject={() => {}} openProjectLabel="Open folder" />)
    await screen.findByText('Conversation ssh:a')
    expect([...document.querySelectorAll('[data-session-key]')].map((element) => element.getAttribute('data-session-key'))).toEqual(['ssh:a', 'ssh:b', 'local'])
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText(/Disconnected/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Session actions:/ })).toHaveLength(3)
    expect(open).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['ipc:code.sessions.list'])
    fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Host b' }))
    expect(screen.getByRole('button', { name: 'Filter sessions' })).toHaveFocus()
    expect(screen.queryByText('Conversation local')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Conversation ssh:b/ }))
    expect(open).toHaveBeenCalledExactlyOnceWith(rows[2])
    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no such session' } })
    expect(screen.getByText('No sessions found')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('ipc:code.sessions.list', { filter: 'ssh:b', search: '' })
    expect(invoke.mock.calls.every(([channel]) => channel === 'ipc:code.sessions.list')).toBe(true)
    expect(screen.queryByText(/worktree/i)).not.toBeInTheDocument()
  })
  it('retains previous metadata on refresh failure and offers a bounded explicit retry', async () => {
    const view = render(<UnifiedSessionSidebar onOpenSession={() => {}} onNewSession={() => {}} onOpenProject={() => {}} openProjectLabel="Open folder" catalogRefreshKey={1} />)
    await screen.findByText('Conversation local')
    invoke.mockRejectedValue(new Error('offline'))
    view.rerender(<UnifiedSessionSidebar onOpenSession={() => {}} onNewSession={() => {}} onOpenProject={() => {}} openProjectLabel="Open folder" catalogRefreshKey={2} />)
    await screen.findByText('Could not refresh sessions · Retry')
    expect(screen.getByText('Conversation local')).toBeInTheDocument()
  })
})
