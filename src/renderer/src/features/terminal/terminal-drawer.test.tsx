import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc-client'
import { openTerminalTab, TerminalDrawer } from './terminal-drawer'
import { terminalActions, useTerminalStore, type ShellProfile, type TerminalPaneState } from './terminal-store'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@renderer/features/browser/browser-composer', () => ({ sendToComposer: vi.fn() }))
vi.mock('./terminal-pane', () => ({
  TerminalPane: ({ pane, visible }: { pane: TerminalPaneState; visible: boolean }) => <div data-testid={pane.ptyId} data-visible={String(visible)}>{pane.profile.name} output</div>,
  useClosePane: () => terminalActions.closePane,
  disposeTerminalInstance: vi.fn(),
  onTerminalSelection: () => () => {},
  terminalSelection: () => '',
}))

const local = '/project'
const ssh0 = '/__pi_ssh__/host0/project'
const ssh1 = '/__pi_ssh__/host1/project'
const profile = (id: string): ShellProfile => ({ id, name: id, path: '/bin/bash', args: [], kind: 'bash' })
const switchTo = (workspaceId: string) => act(() => useUIStore.setState({ currentWorkspace: workspaceId }))
const add = (id: string, workspaceId: string, name: string) => act(() => {
  terminalActions.addTab({ ptyId: id, workspaceId, profile: profile(name) })
})

beforeEach(() => {
  useUIStore.setState({ currentWorkspace: local })
  useTerminalStore.setState({ tabs: [], activeTab: null, open: false, inputEnabled: true, workspaceId: local, profiles: null, profilesByWorkspace: {}, activeTabByWorkspace: {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useUIStore.setState({ currentWorkspace: null })
})

describe('same TerminalDrawer across execution locations', () => {
  it('shows only current-host tabs while keeping background panes mounted, hidden, and inert', () => {
    add('local-pty', local, 'Local')
    render(<TerminalDrawer />)
    expect(screen.getByRole('tab')).toHaveTextContent('Local')
    switchTo(ssh0)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByTestId('local-pty')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByTestId('local-pty').closest('[aria-hidden="true"]')).toHaveAttribute('inert')
    add('ssh-term-0', ssh0, 'SSH0')
    switchTo(ssh1)
    add('ssh-term-1', ssh1, 'SSH1')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab')).toHaveTextContent('SSH1')
    expect(screen.getByTestId('ssh-term-0')).toHaveAttribute('data-visible', 'false')
    switchTo(local)
    expect(screen.getByRole('tab')).toHaveTextContent('Local')
    expect(screen.getByTestId('local-pty')).toHaveAttribute('data-visible', 'true')
  })

  it('does not show or focus a tab whose create completed after switching hosts', async () => {
    let resolve!: (value: unknown) => void
    vi.spyOn(ipcClient, 'invoke').mockReturnValue(new Promise((done) => { resolve = done }))
    render(<TerminalDrawer />)
    const pending = openTerminalTab()
    switchTo(ssh0)
    add('ssh-term-0', ssh0, 'SSH0')
    const focused = useTerminalStore.getState().activeTab
    await act(async () => {
      resolve({ ok: true, id: 'late-local', profile: profile('Late local') })
      await pending
    })
    expect(useTerminalStore.getState().activeTab).toBe(focused)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab')).toHaveTextContent('SSH0')
    expect(screen.getByTestId('late-local')).toHaveAttribute('data-visible', 'false')
  })

  it('closes stale profile menus and never offers local IDs to SSH0 or SSH0 IDs to SSH1', async () => {
    vi.spyOn(ipcClient, 'invoke').mockImplementation(async (method, request) => {
      if (method === 'terminal.profiles') return { profiles: [profile(request.workspaceId === local ? 'Local profile' : request.workspaceId === ssh0 ? 'SSH0 profile' : 'SSH1 profile')] }
      return {}
    })
    terminalActions.setOpen(true)
    render(<TerminalDrawer />)
    fireEvent.click(screen.getByRole('button', { name: 'common:terminal.new' }))
    expect(await screen.findByRole('menuitem', { name: 'Local profile' })).toBeInTheDocument()
    switchTo(ssh0)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'common:terminal.new' }))
    expect(await screen.findByRole('menuitem', { name: 'SSH0 profile' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Local profile' })).toBeNull()
    switchTo(ssh1)
    fireEvent.click(screen.getByRole('button', { name: 'common:terminal.new' }))
    expect(await screen.findByRole('menuitem', { name: 'SSH1 profile' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'SSH0 profile' })).toBeNull()
  })

  it('rejects a pending split after switching hosts and kills only the pinned unused PTY', async () => {
    let resolve!: (value: unknown) => void
    const invoke = vi.spyOn(ipcClient, 'invoke').mockImplementation(async (method) => {
      if (method === 'terminal.profiles') return { profiles: [profile('Local profile')] }
      if (method === 'terminal.create') return new Promise((done) => { resolve = done })
      return { ok: true }
    })
    add('local-pty', local, 'Local')
    render(<TerminalDrawer />)
    fireEvent.click(screen.getByRole('button', { name: 'common:terminal.split' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Local profile' }))
    expect(invoke).toHaveBeenCalledWith('terminal.create', expect.objectContaining({ cwd: local, workspaceId: local }))
    switchTo(ssh0)
    add('ssh-term-0', ssh0, 'SSH0')
    await act(async () => resolve({ ok: true, id: 'late-local-split', profile: profile('Local profile') }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('terminal.kill', { id: 'late-local-split', workspaceId: local }))
    expect(useTerminalStore.getState().tabs.map((t) => t.panes.length)).toEqual([1, 1])
    expect(screen.getByRole('tab')).toHaveTextContent('SSH0')
  })

  it('locks legacy local-null panes and blocks creation during a parent location transition', async () => {
    useUIStore.setState({ currentWorkspace: null })
    terminalActions.addTab({ ptyId: 'legacy-local', profile: profile('Legacy local') })
    const invoke = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({})
    const { rerender } = render(<TerminalDrawer enabled={false} />)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByTestId('legacy-local')).toHaveAttribute('data-visible', 'false')
    expect(useTerminalStore.getState().inputEnabled).toBe(false)
    await act(async () => expect(await openTerminalTab()).toBeNull())
    expect(invoke).not.toHaveBeenCalled()
    rerender(<TerminalDrawer enabled />)
    expect(screen.getByRole('tab')).toHaveTextContent('Legacy local')
    expect(useTerminalStore.getState().inputEnabled).toBe(true)
  })

  it('pins a pending restart to its old slot without taking the new host focus', async () => {
    let resolve!: (value: unknown) => void
    const invoke = vi.spyOn(ipcClient, 'invoke').mockReturnValue(new Promise((done) => { resolve = done }))
    add('old-local', local, 'Local')
    terminalActions.markExited('old-local', 0)
    render(<TerminalDrawer />)
    act(() => window.dispatchEvent(new CustomEvent('pi-desktop:terminal-restart', { detail: 'old-local' })))
    expect(invoke).toHaveBeenCalledWith('terminal.create', expect.objectContaining({ cwd: local, workspaceId: local, profileId: 'Local' }))
    switchTo(ssh0)
    add('ssh-term-0', ssh0, 'SSH0')
    const focused = useTerminalStore.getState().activeTab
    await act(async () => resolve({ ok: true, id: 'restarted-local', profile: profile('Local') }))
    expect(screen.getByTestId('restarted-local')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByRole('tab')).toHaveTextContent('SSH0')
    expect(useTerminalStore.getState().activeTab).toBe(focused)
  })

  it('ignores a restart event from a hidden old workspace', () => {
    const invoke = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({})
    add('local-pty', local, 'Local')
    terminalActions.markExited('local-pty', 0)
    render(<TerminalDrawer />)
    switchTo(ssh0)
    act(() => window.dispatchEvent(new CustomEvent('pi-desktop:terminal-restart', { detail: 'local-pty' })))
    expect(invoke).not.toHaveBeenCalled()
  })
})
