import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import App from './app'

const mocks = vi.hoisted(() => ({ blank: vi.fn(), invoke: vi.fn<(method: string, request?: unknown) => Promise<unknown>>(async () => ({})) }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: mocks.invoke }, onAppEvent: () => () => {}, onWorkerExit: () => () => {}, onNotificationOpenSession: () => () => {} }))
vi.mock('@renderer/lib/blank-session-transition', () => ({ enterBlankSession: mocks.blank }))
vi.mock('@renderer/lib/ensure-workspace-worker', () => ({ ensureWorkspaceWorkerOnBoot: vi.fn() }))
vi.mock('@renderer/lib/composer-run-display', () => ({ refreshComposerRunDisplay: vi.fn() }))
vi.mock('@renderer/lib/adapter-catalog', () => ({ activateAdapterWorkspace: vi.fn(), invalidateAdapterSnapshots: vi.fn(), revalidateActiveAdapterCatalog: vi.fn(async () => {}) }))
vi.mock('@renderer/lib/right-panel-runtime', () => ({ loadNormalizedRightPanelPrefs: vi.fn(async () => ({ catalog: [], prefs: {}, order: [] })), invalidateRightPanelCatalog: vi.fn() }))
vi.mock('@renderer/lib/available-models-cache', () => ({ prefetchAvailableModels: vi.fn() }))
vi.mock('@renderer/lib/extension-notify-policy', () => ({ markExtensionNotifyAppReady: vi.fn() }))
vi.mock('@renderer/lib/theme/background-layer', () => ({ hydrateBackgroundFromSettings: vi.fn(async () => {}) }))
vi.mock('@renderer/features/settings/settings-draft', () => ({ hydrateThemeFromSettings: vi.fn(async () => {}), hydrateCustomThemeFromSettings: vi.fn(async () => {}), hydrateCustomCssOverrideFromSettings: vi.fn(async () => {}), watchSystemTheme: () => () => {} }))
vi.mock('@renderer/lib/ui-zoom', () => ({ applyUiZoom: vi.fn(), readUiZoom: () => 1 }))
vi.mock('@renderer/features/browser/use-help-attention', () => ({ useBrowserHelpAttention: vi.fn() }))
vi.mock('@renderer/features/review/use-review-git-data', () => ({ useReviewGitData: () => ({ gitData: { isRepo: true } }) }))
vi.mock('@renderer/hooks/use-double-escape-tree', () => ({ useDoubleEscapeTree: () => ({ treeOpen: false, forkOpen: false, setTreeOpen: vi.fn(), setForkOpen: vi.fn() }) }))
vi.mock('@renderer/features/terminal/terminal-drawer', () => ({ TerminalDrawer: () => null, openTerminalTab: vi.fn(), useTerminalShortcut: vi.fn() }))
vi.mock('@renderer/features/git/branch-status', () => ({ BranchStatusTrigger: () => <button>Branches</button> }))
vi.mock('@renderer/features/split/split-view', () => ({ SplitView: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@renderer/features/timeline/timeline', () => ({ Timeline: () => <div>Actual session timeline</div> }))
vi.mock('@renderer/features/timeline/timeline-scrubber', () => ({ TimelineScrubber: () => null }))
vi.mock('@renderer/features/composer/model-picker', () => ({ ModelPicker: () => null }))
vi.mock('@renderer/features/composer/thinking-picker', () => ({ ThinkingPicker: () => null }))
vi.mock('@renderer/features/composer/composer', () => ({ Composer: ({ referenceLayout }: { referenceLayout?: boolean }) => <div data-testid="composer" data-reference={String(referenceLayout)} /> }))
vi.mock('@renderer/features/workspace/reference-code-sidebar', () => ({ ReferenceCodeSidebar: ({ onNewSession }: { onNewSession: () => void }) => <button onClick={onNewSession}>New Code session</button> }))
vi.mock('@renderer/features/extension-ui/extension-ui-host', () => ({ ExtensionUIHost: () => null }))
vi.mock('@renderer/features/side-panels/side-panel-host', () => ({ SidePanelHost: () => null }))
vi.mock('@renderer/features/shell/right-panel-tabs', () => ({ RightPanelTabs: () => <div role="tablist" aria-label="Workspace functions"><button role="tab">Files</button></div> }))
vi.mock('@renderer/features/shell/command-palette', () => ({ CommandPalette: () => null, ShortcutsHelpSheet: () => null }))
vi.mock('@renderer/features/browser/help-bar', () => ({ HelpBar: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockImplementation(async () => ({}))
  useUIStore.setState({ currentWorkspace: '/work/actual-project', currentSessionId: null, historySessionFile: null, timelineItems: [],
    historyLoading: false, ephemeralSandboxDraft: false, pendingNewSessionPlaceholder: false,
    sidebarCollapsed: false, rightPanelCollapsed: true, rightPanelRailIcons: false,
    modelPickerOpen: false, thinkingPickerOpen: false, pendingExtensionConfig: null,
  })
})

describe('reference Code workspace integration', () => {
  it('cancels delayed picker preloads when the workspace unmounts', async () => {
    const schedule = vi.spyOn(window, 'setTimeout'), clear = vi.spyOn(window, 'clearTimeout')
    const view = render(<App />)
    try {
      await waitFor(() => expect(schedule.mock.calls.some((call) => call[1] === 1500)).toBe(true))
      const index = schedule.mock.calls.findIndex((call) => call[1] === 1500)
      const timer = schedule.mock.results[index].value
      view.unmount()
      expect(clear).toHaveBeenCalledWith(timer)
    } finally { view.unmount(); schedule.mockRestore(); clear.mockRestore() }
  })
  it('hydrates real native recents without relying on the removed project tree', async () => {
    mocks.invoke.mockImplementation(async (method, request) => method === 'settings.get' && (request as { key?: string })?.key === 'recentProjects' ? { settings: { recentProjects: ['/work/known', '/__pi_ssh__/other/root'] } } : {})
    render(<App />)
    await waitFor(() => expect(useUIStore.getState().recentProjects).toEqual(['/work/known']))
  })
  it('ignores a late native recent response after SSH is selected', async () => {
    let finish!: (value: unknown) => void
    mocks.invoke.mockImplementation(async (method, request) => method === 'settings.get' && (request as { key?: string })?.key === 'recentProjects' ? new Promise((resolve) => { finish = resolve }) : {})
    const view = render(<App active />)
    view.rerender(<App active={false} executionLocked />)
    useUIStore.setState({ recentProjects: ['/__pi_ssh__/host/root'] })
    await act(async () => { finish({ settings: { recentProjects: ['/work/old'] } }); await Promise.resolve() })
    expect(useUIStore.getState().recentProjects).toEqual(['/__pi_ssh__/host/root'])
  })
  it('keeps the greeting top-level and environment beside the bottom composer without duplicate chrome/footer', () => {
    const { container } = render(<App userName="Local User" environmentControl={<button>Local environment</button>} sidebarFooter={<div>Shared account</div>} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("What's up next, Local User?")
    expect(screen.getByTestId('composer')).toHaveAttribute('data-reference', 'true')
    expect(screen.getByRole('button', { name: 'Local environment' }).closest('.composer-dock-host')).toBeTruthy()
    expect(container.querySelector('.composer-dock-hero')).toBeNull()
    expect(container.querySelector('.shell-three-col')).toBeTruthy()
    expect(container.querySelector('.immersive-chrome')).toBeNull()
    expect(container.querySelector('.status-bar')).toBeNull()
    expect(screen.getAllByText('Shared account')).toHaveLength(1)
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('uses the current project blank-session flow from both the sidebar and root event only while active', () => {
    const registered = vi.fn()
    const view = render(<App active onNewSessionReady={registered} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Code session' }))
    act(() => window.dispatchEvent(new CustomEvent('pi-desktop:code-new-session')))
    expect(mocks.blank.mock.calls).toEqual([['pending-project'], ['pending-project']])
    act(() => registered.mock.calls.at(-1)![0]())
    expect(mocks.blank).toHaveBeenCalledTimes(3)
    view.rerender(<App active={false} onNewSessionReady={registered} />)
    act(() => window.dispatchEvent(new CustomEvent('pi-desktop:code-new-session')))
    expect(registered.mock.calls.at(-1)![0]).toBeNull()
    expect(mocks.blank).toHaveBeenCalledTimes(3)
    expect(mocks.invoke.mock.calls.some(([method]) => String(method).includes('prompt'))).toBe(false)
  })

  it('moves feature controls into a side drawer, with no toolbar above the chat', () => {
    useUIStore.setState({ currentSessionId: 'real-session' })
    const { container } = render(<App />)
    expect(screen.getByText('Actual session timeline')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Branches' })).toBeInTheDocument()
    expect(container.querySelector('.reference-code-session-controls')).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Workspace functions' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }))
    expect(screen.getByRole('complementary', { name: 'Workspace panel' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Toggle terminal' })).toHaveLength(1)
    expect(screen.getByRole('tablist', { name: 'Workspace functions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace panel' }))
    expect(screen.queryByRole('complementary', { name: 'Workspace panel' })).not.toBeInTheDocument()
    expect(container.querySelector('.workbench-statusbar')).toBeNull()
    expect(screen.getByTestId('composer').closest('.composer-dock-hero')).toBeNull()
  })

  it('does not present remote HOME as a project branch/worktree when No project is selected', () => {
    useUIStore.setState({ currentWorkspace: '/__pi_ssh__/host/fingerprint/home', currentSessionId: '__pending_new__', pendingNewSessionPlaceholder: true })
    render(<App noProject workspaceLabel="No project" workspacePathLabel="Remote home" />)
    expect(screen.getByText('No project').closest('button')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Branches' })).toBeNull()
    expect(screen.queryByText('Worktree')).toBeNull()
  })
  it('does not make a local sandbox while an SSH location is awaiting a trusted folder', () => {
    useUIStore.setState({ currentWorkspace: null, ephemeralSandboxDraft: false })
    const chooseFolder = vi.fn()
    render(<App executionLocked onChooseFolder={chooseFolder} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Code session' }))
    expect(chooseFolder).toHaveBeenCalledOnce()
    expect(mocks.blank).not.toHaveBeenCalled()
  })

  it('shows the home layout for a pending project draft, and creates a sandbox draft without a project', () => {
    useUIStore.setState({ currentSessionId: '__pending_new__', pendingNewSessionPlaceholder: true })
    const view = render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("What's up next?")
    act(() => useUIStore.setState({ currentWorkspace: null, currentSessionId: null, pendingNewSessionPlaceholder: false }))
    fireEvent.click(screen.getByRole('button', { name: 'New Code session' }))
    expect(mocks.blank).toHaveBeenCalledWith('ephemeral-sandbox')
    view.unmount()
    act(() => window.dispatchEvent(new CustomEvent('pi-desktop:code-new-session')))
    expect(mocks.blank).toHaveBeenCalledOnce()
  })
})
