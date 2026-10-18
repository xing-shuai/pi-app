import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'
import { useSwapFade } from '@renderer/hooks/use-ui-motion'
import { WorkspaceActivityProvider } from '@renderer/features/shell/workspace-activity'
import '@renderer/features/ssh/ssh-workspace.css'
import { hydrateBackgroundFromSettings } from '@renderer/lib/theme/background-layer'
import { ErrorBoundary } from '@renderer/components/app/error-boundary'
import { MainLayoutShell } from '@renderer/components/app/main-layout-shell'
import { Sidebar, SidebarContent, RightPanel } from '@renderer/components/ui/sidebar'
import { ReferenceCodeSidebar } from '@renderer/features/workspace/reference-code-sidebar'
import { ReferenceCodeHome } from '@renderer/components/app/reference-code-home'
import { enterBlankSession } from '@renderer/lib/blank-session-transition'
import { isSandboxPath } from '@renderer/features/workspace/project-sidebar-types'
import '@renderer/features/shell/reference-code.css'
import '@renderer/styles/timeline-reference-stream.css'
import '@renderer/styles/compact-scroll-wrap.css'
import '@renderer/styles/workspace-drawer.css'
import { MainColRightPanelToggle } from '@renderer/components/app/main-col-right-panel-toggle'
import { MainColumnWithTimelineScroll } from '@renderer/components/app/main-column-with-timeline-scroll'
import { ComposerDock } from '@renderer/components/app/composer-dock'
import { TimelineScrubber } from '@renderer/features/timeline/timeline-scrubber'
import { SplitView } from '@renderer/features/split/split-view'
import { Timeline } from '@renderer/features/timeline/timeline'
import { Composer } from '@renderer/features/composer/composer'

import { TopBar } from '@renderer/components/app/top-bar'
import { useUIStore } from '@renderer/stores/ui-store'
import { onAppEvent, onWorkerExit, onNotificationOpenSession, ipcClient } from '@renderer/lib/ipc-client'
import { handleNotificationOpenSession } from '@renderer/lib/notification-open-session'

import { toast } from 'sonner'
import { ensureWorkspaceWorkerOnBoot } from '@renderer/lib/ensure-workspace-worker'
import { refreshComposerRunDisplay } from '@renderer/lib/composer-run-display'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderOpen, RefreshCw, Terminal, X } from '@renderer/components/icons'
import { RightPanelTabs } from '@renderer/features/shell/right-panel-tabs'
import { buildRightPanelTabs } from '@renderer/lib/right-panel-catalog'
import { useRightPanelHidden } from '@renderer/lib/use-right-panel-hidden'
import { loadNormalizedRightPanelPrefs } from '@renderer/lib/right-panel-runtime'
import { normalizeTimelineMaxAutoExpandedTools, normalizeTimelineVisibleTurns } from '@shared/timeline-settings'
import { SidePanelHost } from '@renderer/features/side-panels/side-panel-host'
import { ExtensionUIHost } from '@renderer/features/extension-ui/extension-ui-host'
import { markExtensionNotifyAppReady } from '@renderer/lib/extension-notify-policy'
import {
  hydrateCustomCssOverrideFromSettings,
  hydrateCustomThemeFromSettings,
  hydrateThemeFromSettings,
  watchSystemTheme,
} from '@renderer/features/settings/settings-draft'
import { CommandPalette, ShortcutsHelpSheet } from '@renderer/features/shell/command-palette'
import { EmptyState } from '@renderer/components/ui/empty-state'
import { clearExitedSessionRuntime } from '@renderer/lib/worker-exit-runtime'
import { handleSdkRuntimeChanged } from '@renderer/lib/sdk-runtime-changed'
import { prefetchAvailableModels } from '@renderer/lib/available-models-cache'
import { activateAdapterWorkspace, invalidateAdapterSnapshots, revalidateActiveAdapterCatalog } from '@renderer/lib/adapter-catalog'
import { invalidateRightPanelCatalog } from '@renderer/lib/right-panel-runtime'

import { useDoubleEscapeTree } from '@renderer/hooks/use-double-escape-tree'
import { useReviewGitData } from '@renderer/features/review/use-review-git-data'
import { applyUiZoom, readUiZoom } from '@renderer/lib/ui-zoom'
import { matchShortcut, readShortcutBindings } from '@renderer/lib/shortcut-bindings'
import { TerminalDrawer, openTerminalTab, useTerminalShortcut } from '@renderer/features/terminal/terminal-drawer'
import { BranchStatusTrigger } from '@renderer/features/git/branch-status'
import { useBrowserHelpAttention } from '@renderer/features/browser/use-help-attention'
import { HelpBar } from '@renderer/features/browser/help-bar'
import { terminalActions, terminalTabsForWorkspace, useTerminalStore } from '@renderer/features/terminal/terminal-store'

type View = 'main' | 'settings'

const SettingsPage = lazy(() =>
  import('@renderer/features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
)
const ModelPicker = lazy(() =>
  import('@renderer/features/composer/model-picker').then((m) => ({ default: m.ModelPicker })),
)
const ThinkingPicker = lazy(() =>
  import('@renderer/features/composer/thinking-picker').then((m) => ({ default: m.ThinkingPicker })),
)
const SessionTreeOverlay = lazy(() =>
  import('@renderer/features/rewind/session-tree-overlay').then((m) => ({ default: m.SessionTreeOverlay })),
)
const SessionForkOverlay = lazy(() =>
  import('@renderer/features/rewind/session-fork-overlay').then((m) => ({ default: m.SessionForkOverlay })),
)

function ShellSuspenseFallback({ label }: { label: string }) {
  return <EmptyState compact title={label} className="min-h-[12rem]" />
}

if ((window as unknown as { piDesktop?: { e2e?: boolean } }).piDesktop?.e2e) {
  ;(window as unknown as { __piE2E?: unknown }).__piE2E = { useUIStore, useExtensionUIStore, ipcClient }
}

performance.mark('pi:app-module')

export type CodeWorkspaceProps = {
  active?: boolean
  settingsRequest?: number
  onSettingsClosed?: () => void
  onRoutines?: () => void
  onCustomize?: () => void
  environmentControl?: ReactNode
  userName?: string
  onNewSessionReady?: (handler: (() => void) | null) => void
  sidebarFooter?: ReactNode
  onOpenSession?: (entry: SessionCatalogEntry) => Promise<void> | void
  sessionCatalogRefreshKey?: unknown
  folderControl?: ReactNode
  onChooseFolder?: () => void | Promise<void>
  workspaceLabel?: string
  workspacePathLabel?: string
  noProject?: boolean
  executionLocked?: boolean
  executionError?: ReactNode
}
export default function App(props: CodeWorkspaceProps = {}) {
  return <WorkspaceActivityProvider active={props.active !== false}><CodeWorkspaceContents {...props} /></WorkspaceActivityProvider>
}
function CodeWorkspaceContents({
  active = true, settingsRequest = 0, onSettingsClosed, onRoutines, onCustomize,
  environmentControl, userName, onNewSessionReady, sidebarFooter, onOpenSession, sessionCatalogRefreshKey,
  folderControl, onChooseFolder, workspaceLabel, workspacePathLabel, noProject = false, executionLocked = false, executionError,
}: CodeWorkspaceProps) {
  if (!performance.getEntriesByName('pi:app-render').length) performance.mark('pi:app-render')
  const { t } = useTranslation()
  const [view, setView] = useState<View>('main')
  const bootExecutionLocked = useRef(executionLocked)
  useEffect(() => { if (settingsRequest > 0) setView('settings') }, [settingsRequest])
  useEffect(() => { if (!active) { setView('main'); void ipcClient.invoke('browser.hideAll').catch(() => {}) } }, [active])
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [panelReloading, setPanelReloading] = useState(false)
  const activePanel = useUIStore((s) => s.activePanel)
  const rightPanelHidden = useRightPanelHidden()
  const modelPickerOpen = useUIStore((s) => s.modelPickerOpen)
  const thinkingPickerOpen = useUIStore((s) => s.thinkingPickerOpen)
  const setActivePanel = useUIStore((s) => s.setActivePanel)
  const rightPanelPrefs = useUIStore((s) => s.rightPanelPrefs)
  const rightPanelOrder = useUIStore((s) => s.rightPanelOrder)
  const applyRightPanelRuntime = useUIStore((s) => s.applyRightPanelRuntime)
  const browserPanelEnabled = !!rightPanelPrefs.browser
  useBrowserHelpAttention(browserPanelEnabled)
  const browserWasEnabled = useRef(browserPanelEnabled)
  useEffect(() => {
    // Turning the experimental browser panel off releases every tab in Main.
    if (browserWasEnabled.current && !browserPanelEnabled) void ipcClient.invoke('browser.shutdown').catch(() => {})
    browserWasEnabled.current = browserPanelEnabled
  }, [browserPanelEnabled])
  const rightPanelCatalog = useUIStore((s) => s.rightPanelCatalog)
  const setWorkspace = useUIStore((s) => s.setWorkspace)
  const pendingExtensionConfig = useUIStore((s) => s.pendingExtensionConfig)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)
  const terminalOpen = useTerminalStore((s) => s.open)
  const terminalHeight = useTerminalStore((s) => s.height)
  const terminalTabs = useTerminalStore((s) => terminalTabsForWorkspace(s.tabs, currentWorkspace).length)
  // Keep the old status bar's sleep protection without mounting its memory/status footer.
  const hasBusySessions = useUIStore((s) => Object.values(s.sessionAttention).some((attention) => attention === 'working' || attention === 'needs-you'))
  useEffect(() => {
    void ipcClient.invoke('desktop.setSleepBlock', { on: hasBusySessions }).catch(() => {})
  }, [hasBusySessions])
  useTerminalShortcut(active && !executionLocked && view === 'main')
  const ephemeralSandboxDraft = useUIStore((s) => s.ephemeralSandboxDraft)
  const [workspaceTitle, setWorkspaceTitle] = useState<string | undefined>()
  const canUseTree = active && view === 'main' && (!!currentWorkspace || ephemeralSandboxDraft)
  const { treeOpen, setTreeOpen, forkOpen, setForkOpen } = useDoubleEscapeTree(canUseTree)

  useEffect(() => {
    if (ephemeralSandboxDraft) {
      setWorkspaceTitle(t('common:home.newChat'))
      return
    }
    if (!currentWorkspace) {
      setWorkspaceTitle(undefined)
      return
    }
    const norm = currentWorkspace.replace(/\\/g, '/')
    if (!norm.includes('sandbox-workspaces/')) {
      setWorkspaceTitle(currentWorkspace.split(/[\\/]/).pop())
      return
    }
    ipcClient
      .invoke('workspace.sandbox.list')
      .then((r) => {
        const box = (r?.sandboxes || []).find((b: { path: string }) => b.path === currentWorkspace)
        setWorkspaceTitle(box?.label || t('common:sidebar.tempChat'))
      })
      .catch(() => setWorkspaceTitle(t('common:sidebar.tempChat')))
  }, [currentWorkspace, ephemeralSandboxDraft, t])

  const projectName = workspaceLabel || workspaceTitle
  const handleNewSession = useCallback(() => {
    if (!active) return
    if (executionLocked) { void onChooseFolder?.(); return }
    setView('main')
    const workspace = useUIStore.getState().currentWorkspace
    enterBlankSession(workspace && !isSandboxPath(workspace) ? 'pending-project' : 'ephemeral-sandbox')
    void refreshComposerRunDisplay()
  }, [active, executionLocked, onChooseFolder])

  useEffect(() => {
    if (!active) return
    window.addEventListener('pi-desktop:code-new-session', handleNewSession)
    onNewSessionReady?.(handleNewSession)
    return () => {
      window.removeEventListener('pi-desktop:code-new-session', handleNewSession)
      onNewSessionReady?.(null)
    }
  }, [active, handleNewSession, onNewSessionReady])

  useEffect(() => {
    const onOpenFork = () => setForkOpen(true)
    window.addEventListener('pi-desktop:open-fork-selector', onOpenFork)
    return () => window.removeEventListener('pi-desktop:open-fork-selector', onOpenFork)
  }, [setForkOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active) return
      const bindings = readShortcutBindings()
      if (matchShortcut(event, bindings.commandPalette)) {
        event.preventDefault()
        setCommandPaletteOpen(true)
        return
      }
      if (matchShortcut(event, bindings.shortcuts)) {
        event.preventDefault()
        setShortcutsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  useEffect(() => {
    markExtensionNotifyAppReady()
    if (!bootExecutionLocked.current && !useUIStore.getState().currentWorkspace?.startsWith('/__pi_ssh__/')) void ipcClient.invoke('app.codeReady').catch(() => {})
    useExtensionUIStore.getState().resetForSessionContext()
    void ensureWorkspaceWorkerOnBoot()
    void hydrateThemeFromSettings().catch(() => {})
    void hydrateCustomThemeFromSettings().catch(() => {})
    void hydrateCustomCssOverrideFromSettings().catch(() => {})
    void hydrateBackgroundFromSettings().catch(() => {})
    applyUiZoom(readUiZoom())
  }, [])

  // The legacy project tree used to hydrate native recents as a side effect.
  // Keep that metadata owned by the workbench now that the sidebar is target-neutral.
  useEffect(() => {
    if (!active || executionLocked || currentWorkspace?.startsWith('/__pi_ssh__/')) return
    let live = true
    void ipcClient.invoke('settings.get', { key: 'recentProjects' }).then((result) => {
      if (!live || !Array.isArray(result?.settings?.recentProjects)) return
      const recentProjects = result.settings.recentProjects.filter((path: unknown): path is string => typeof path === 'string' && !path.startsWith('/__pi_ssh__/'))
      useUIStore.setState({ recentProjects })
    }).catch(() => {})
    return () => { live = false }
  }, [active, executionLocked, currentWorkspace])

  useEffect(() => watchSystemTheme(), [])

  useEffect(() => {
    let preloadTimer: number | undefined
    const frame = requestAnimationFrame(() => {
      void loadNormalizedRightPanelPrefs()
        .then(({ catalog, prefs, order }) => applyRightPanelRuntime(catalog, prefs, order))
        .catch(() => {})
      void ipcClient
        .invoke('settings.get', { key: 'timelineMaxAutoExpandedTools' })
        .then((res) => {
          const raw = res?.settings?.timelineMaxAutoExpandedTools
          useUIStore
            .getState()
            .setTimelineMaxAutoExpandedTools(normalizeTimelineMaxAutoExpandedTools(raw))
        })
        .catch(() => {})
      void ipcClient
        .invoke('settings.get', { key: 'timelineVisibleTurns' })
        .then((res) => {
          useUIStore.getState().setTimelineVisibleTurns(normalizeTimelineVisibleTurns(res?.settings?.timelineVisibleTurns))
        })
        .catch(() => {})
      prefetchAvailableModels()
      // The composer menus open from a chip click; load their code ahead so the first open is instant.
      preloadTimer = window.setTimeout(() => {
        void import('@renderer/features/composer/model-picker').catch(() => {})
        void import('@renderer/features/composer/thinking-picker').catch(() => {})
      }, 1500)
    })
    return () => { cancelAnimationFrame(frame); if (preloadTimer !== undefined) window.clearTimeout(preloadTimer) }
  }, [applyRightPanelRuntime])

  useEffect(() => {
    activateAdapterWorkspace(currentWorkspace)
    invalidateRightPanelCatalog()
    let active = true
    void loadNormalizedRightPanelPrefs().then(({ catalog, prefs, order }) => {
      if (active) applyRightPanelRuntime(catalog, prefs, order)
    }).catch(() => {})
    return () => { active = false }
  }, [currentWorkspace, applyRightPanelRuntime])

  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') void revalidateActiveAdapterCatalog().catch(() => {}) }
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, 5000)
    return () => { window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const unsubEvents = onAppEvent((event) => {
      if (event.type === 'sdk-runtime-changed' || event.type === 'adapter-catalog-changed') {
        invalidateAdapterSnapshots()
        invalidateRightPanelCatalog()
        const workspace = useUIStore.getState().currentWorkspace
        void loadNormalizedRightPanelPrefs().then(({ catalog, prefs, order }) => {
          if (useUIStore.getState().currentWorkspace === workspace) useUIStore.getState().applyRightPanelRuntime(catalog, prefs, order)
        }).catch(() => {})
        if (event.type === 'sdk-runtime-changed') void handleSdkRuntimeChanged()
        return
      }
      if (event.type === 'remote-settings-changed') {
        if (event.key === 'capabilities') void import('@renderer/lib/session-capabilities').then((m) => m.reloadSessionCapabilities())
        if (event.key === 'rewound' && event.sessionFile) {
          // A phone rewound a session: if it is on screen, rebuild it from disk on the new branch.
          const rewound = event.sessionFile
          void import('@renderer/lib/session-file-key').then(({ sessionFilesEqual }) => {
            if (!sessionFilesEqual(useUIStore.getState().historySessionFile, rewound)) return
            void import('@renderer/lib/reload-current-session-data').then((m) => m.reloadCurrentSessionData())
          })
        }
        if (event.key === 'sessions' && event.workspaceId) {
          const workspaceIds = [event.workspaceId]
          void import('@renderer/lib/refresh-workspace-session-lists').then((m) => m.refreshWorkspaceSessionLists({ workspaceIds, afterMutation: true }))
        }
        return
      }
      useUIStore.getState().processEvent(event)
    })
    void import('@renderer/lib/session-worker-sync').then(({ fetchWorkerLiveSnapshot }) => {
      fetchWorkerLiveSnapshot()
        .then((snap) => useUIStore.getState().setWorkerLiveSnapshot(snap))
        .catch(() => {})
    })
    const unsubExit = onWorkerExit((info) => {
      console.warn('Worker exited:', info)
      const store = useUIStore.getState()
      clearExitedSessionRuntime(
        info,
        store.setSessionRuntimeRunning,
        store.setCompactingSession,
      )
    })
    const unsubNotify = onNotificationOpenSession((payload) => {
      void handleNotificationOpenSession(payload)
    })
    // Settings → Usage: a session row opens that session.
    const onOpenSession = (e: Event) => {
      const d = (e as CustomEvent<{ workspaceId?: string; sessionFile?: string }>).detail
      setView('main')
      void handleNotificationOpenSession({ ok: true, workspaceId: d?.workspaceId, sessionFile: d?.sessionFile })
    }
    window.addEventListener('pi-desktop:open-session', onOpenSession)
    return () => {
      window.removeEventListener('pi-desktop:open-session', onOpenSession)
      unsubEvents()
      unsubExit()
      unsubNotify()
    }
  }, [setWorkspace])

  useEffect(() => {
    if (active && pendingExtensionConfig) {
      setView('settings')
    }
  }, [pendingExtensionConfig, active])

  const currentSessionId = useUIStore((s) => s.currentSessionId)
  const panelMotion = useSwapFade<HTMLDivElement>(activePanel, activePanel === 'browser')
  const timelineItemCount = useUIStore((s) => s.timelineItems.length)
  const historyLoading = useUIStore((s) => s.historyLoading)
  const pendingNewSession = useUIStore((s) => s.pendingNewSessionPlaceholder)

  const handleOpenProject = async () => {
    if (onChooseFolder) { await onChooseFolder(); return }
    toast.error('The app directory picker is not available yet. Please reopen the Code workspace.')
  }

  const fileChanges = useUIStore((s) => s.fileChanges)
  const { gitData } = useReviewGitData({
    enabled: !!currentWorkspace && !noProject,
    workspace: currentWorkspace,
    worktreeChangeSignal: fileChanges,
  })
  const panelPrefs =
    noProject || gitData?.isRepo === false ? { ...rightPanelPrefs, review: false } : rightPanelPrefs
  const PANELS = buildRightPanelTabs(rightPanelCatalog, panelPrefs, t, rightPanelOrder)
  const activeCatalogItem = rightPanelCatalog.find((c) => c.id === activePanel)

  const isHomeMode =
    (!currentSessionId || pendingNewSession) && timelineItemCount === 0 && !ephemeralSandboxDraft && !historyLoading
  const showHome = (isHomeMode || ephemeralSandboxDraft) && view === 'main'

  const paletteAndShortcuts = (
    <>
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onOpenSettings={() => setView('settings')}
        onOpenSessionTree={canUseTree ? () => setTreeOpen(true) : undefined}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsHelpSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  )

  if (view === 'settings') {
    return (
      <ErrorBoundary>
        <div
          className="app-viewport product-settings-workspace flex flex-col overflow-hidden text-foreground"
          style={{ background: 'var(--surface-sidebar)' }}
        >
          <TopBar
            embedded
            onBack={() => {
              useUIStore.getState().requestExtensionConfig(null)
              setView('main')
              onSettingsClosed?.()
              void refreshComposerRunDisplay()
            }}
            title={t('settings:title')}
          />
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary label="settings">
              <Suspense fallback={<ShellSuspenseFallback label={t('common:loadingSettings')} />}>
                <SettingsPage />
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
        {active && paletteAndShortcuts}
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div
        className="app-viewport reference-code flex flex-col overflow-hidden text-foreground"
        data-reference-home={showHome ? 'true' : 'false'}
        data-reference-right-hidden={rightPanelHidden ? 'true' : 'false'}
      >
        <MainLayoutShell
          left={
            <Sidebar>
              <SidebarContent>
                <ReferenceCodeSidebar
                  onNewSession={handleNewSession}
                  onOpenSession={onOpenSession}
                  catalogRefreshKey={sessionCatalogRefreshKey}
                  onOpenProject={handleOpenProject}
                  openProjectLabel={t('sidebar.openProject')}
                  onRoutines={onRoutines}
                  onCustomize={onCustomize}
                />
              </SidebarContent>
              {sidebarFooter}
            </Sidebar>
          }
          center={
            <SplitView>
            <MainColumnWithTimelineScroll className="h-full" motionKey={JSON.stringify([currentWorkspace, currentSessionId])}>
              {executionError}
              {showHome ? (
                <ReferenceCodeHome userName={userName} />
              ) : (
                <Timeline />
              )}
              {active && <MainColRightPanelToggle disabled={executionLocked} panelIds={PANELS.map((panel) => panel.key)} />}
              <ComposerDock className="reference-code-dock">
                {/* The agent waiting on the user in their Chrome: answerable right above the composer. */}
                <HelpBar activeTabId={null} where="chrome" className="mb-2 rounded-lg border" />
                <div className="reference-code-environment">
                  {environmentControl}
                  {folderControl || <button type="button" onClick={() => void handleOpenProject()} className="reference-code-folder" title={workspacePathLabel || currentWorkspace || t('sidebar.openProject')} aria-label={t('sidebar.openProject')}>
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    <span>{currentWorkspace && !isSandboxPath(currentWorkspace) && !ephemeralSandboxDraft ? projectName || t('sidebar.openProject') : 'Select folder'}</span>
                  </button>}
                  {currentWorkspace && !ephemeralSandboxDraft && !noProject && gitData?.isRepo ? <span className="reference-code-branch-group"><BranchStatusTrigger /><label data-app-tooltip="Creating isolated session worktrees is not implemented yet. Existing worktrees can be opened as folders."><input type="checkbox" disabled checked={false} readOnly />Worktree</label></span> : <button type="button" className="reference-code-folder-add" data-app-tooltip="Open another project folder" aria-label="Open another project folder" onClick={() => void handleOpenProject()}><FilePlus size={16} /></button>}
                </div>
                <Composer referenceLayout />
              </ComposerDock>
              {!showHome ? <TimelineScrubber /> : null}
            </MainColumnWithTimelineScroll>
            </SplitView>
          }
          right={
            <RightPanel>
              {!rightPanelHidden ? <aside id="workspace-panel-drawer" className="workspace-panel-drawer" aria-label="Workspace panel">
                <header className="workspace-panel-header"><span>Workspace</span><div>
                  <button type="button" aria-label="Toggle terminal" aria-pressed={terminalOpen} data-app-tooltip="Terminal" disabled={!active || executionLocked} onClick={() => !terminalOpen && terminalTabs === 0 ? void openTerminalTab() : terminalActions.toggle()}><Terminal size={17} /></button>
                  <button type="button" aria-label="Reload session and project lists (sync with the CLI)" data-app-tooltip="Reload session and project lists" disabled={panelReloading || !active || executionLocked} onClick={() => { setPanelReloading(true); void import('@renderer/lib/reload-current-session-data').then((module) => module.reloadCurrentSessionData()).then((result) => { if (!result.ok) toast.error(result.error || 'Refresh failed') }).catch(() => toast.error('Refresh failed')).finally(() => setPanelReloading(false)) }}><RefreshCw size={16} className={panelReloading ? 'animate-spin' : undefined} /></button>
                  <button type="button" aria-label="Close workspace panel" data-app-tooltip="Close workspace panel" onClick={() => useUIStore.getState().toggleRightPanel()}><X size={17} /></button>
                </div></header>
                <RightPanelTabs panels={PANELS} activePanel={activePanel} setActivePanel={setActivePanel} />
                <div ref={panelMotion} className="flex-1 min-h-0 overflow-hidden" role="tabpanel" aria-label={PANELS.find((panel) => panel.key === activePanel)?.label || 'Workspace feature'}>
                  <ErrorBoundary label="panel">
                    <Suspense fallback={<ShellSuspenseFallback label={t('common:loading')} />}>
                      <SidePanelHost item={activeCatalogItem} />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              </aside> : null}
            </RightPanel>
          }
          bottom={<TerminalDrawer enabled={active && !executionLocked} />}
          bottomOpen={terminalOpen}
          bottomHeight={terminalHeight}
        />
      </div>
      {active && <ExtensionUIHost />}
      {active && paletteAndShortcuts}
      {active && <Suspense fallback={null}>
        {modelPickerOpen && <ModelPicker />}
        {thinkingPickerOpen && <ThinkingPicker />}
        {treeOpen && <SessionTreeOverlay open={treeOpen} onClose={() => setTreeOpen(false)} />}
        {forkOpen && <SessionForkOverlay open={forkOpen} onClose={() => setForkOpen(false)} />}
      </Suspense>}
    </ErrorBoundary>
  )
}
