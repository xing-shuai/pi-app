import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, PanelLeft, Settings } from '@renderer/components/icons'
import type { ProductSurface } from '@shared/execution-target'
import { useTranslation } from 'react-i18next'
import type { SettingsPageKey } from '@renderer/features/settings/settings-page'
import { CodeLocationProvider, useCodeLocation } from '@renderer/features/code-location/code-location-context'
import { CodeLocationModal } from '@renderer/features/code-location/code-location-modal'
import { ReferenceFolderControl } from '@renderer/features/code-location/reference-folder-control'
import { REFERENCE_DESKTOP_THEME } from '@shared/reference-desktop-theme'
import { ErrorBoundary } from '@renderer/components/app/error-boundary'
import { WindowControls } from '@renderer/components/app/window-controls'
import { ReferenceAccountFooter } from '@renderer/components/app/reference-sidebar'
import { ReferenceEnvironmentControl } from '@renderer/components/app/reference-environment-control'
import { CloseDecisionDialog } from '@renderer/components/ui/close-decision-dialog'
import { AppTooltipHost } from '@renderer/components/ui/app-tooltip-host'
import { AppToaster } from '@renderer/components/app/app-toaster'
import { AppUpdateHost } from '@renderer/lib/app-update-notify'
import { hydrateThemeFromSettings, hydrateCustomThemeFromSettings, hydrateCustomCssOverrideFromSettings, watchSystemTheme } from '@renderer/features/settings/settings-draft'
import { hydrateBackgroundFromSettings } from '@renderer/lib/theme/background-layer'
import { applyUiZoom, readUiZoom, referenceUiZoom } from '@renderer/lib/ui-zoom'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAnimatedVisibility } from '@renderer/hooks/use-ui-motion'
import './product-shell.css'
import './reference-layout.css'
import '@renderer/styles/product-typography.css'
import '@renderer/styles/desktop-detail-overlays.css'
import '@renderer/styles/compact-scroll-wrap.css'
import '@renderer/styles/ui-transitions.css'

const CodeWorkspace = lazy(() => import('./app'))
const SettingsPage = lazy(() => import('@renderer/features/settings/settings-page').then((m) => ({ default: m.SettingsPage })))
const ChatPage = lazy(() => import('@renderer/features/chat/chat-page').then((m) => ({ default: m.ChatPage })))
const RoutinesPage = lazy(() => import('@renderer/features/routines/routines-page').then((m) => ({ default: m.RoutinesPage })))
const SURFACE_KEY = 'pi-desktop-product-surface-v1'
const REFERENCE_KEY = 'pi-desktop-reference-layout-20261017-matched'
export function readProductSurface(): ProductSurface {
  try { return localStorage.getItem(SURFACE_KEY) === 'code' ? 'code' : 'chat' } catch { return 'chat' }
}
function storedSurfaceExists(): boolean { try { return ['chat', 'code'].includes(localStorage.getItem(SURFACE_KEY) || '') } catch { return false } }
type Route = { surface: ProductSurface; page: 'workspace' | 'routines' | 'settings' | 'customize' }
export default function ProductShell() { return <CodeLocationProvider><ProductShellContents /></CodeLocationProvider> }
function ProductShellContents() {
  const location = useCodeLocation()
  const { i18n } = useTranslation()
  const initial = useRef<Route>({ surface: readProductSurface(), page: 'workspace' })
  const [route, setRoute] = useState<Route>(initial.current)
  const [history, setHistory] = useState({ entries: [initial.current], index: 0 })
  const { surface, page } = route
  const [codeVisited, setCodeVisited] = useState(() => readProductSurface() === 'code')
  const [routinesVisited, setRoutinesVisited] = useState(false)
  const [settingsStart, setSettingsStart] = useState<SettingsPageKey>('general')
  const settingsReturnPage = useRef<'workspace' | 'routines'>('workspace')
  const [menuOpen, setMenuOpen] = useState(false)
  const chromeLeft = useRef<HTMLDivElement>(null)
  const mainMenu = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const codeNewHandler = useRef<(() => void) | null>(null)
  const pendingCodeNew = useRef(false)
  const [chatNavigation, setChatNavigation] = useState({ back: false, forward: false })
  const [userName, setUserName] = useState('Local user')
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const visiblePage = useRef(route)
  visiblePage.current = route
  const settingsOpen = page === 'settings' || page === 'customize'
  const workbenchVisible = page === 'workspace' || (settingsOpen && settingsReturnPage.current === 'workspace')
  const codeVisible = workbenchVisible && surface === 'code'
  const codeActive = page === 'workspace' && surface === 'code' && !location.busy
  const chatActive = page === 'workspace' && surface === 'chat'
  const chatVisible = workbenchVisible && surface === 'chat'
  const routinesVisible = page === 'routines' || (settingsOpen && settingsReturnPage.current === 'routines')
  const chatMotion = useAnimatedVisibility(chatVisible)
  const codeMotion = useAnimatedVisibility(codeVisible)
  const routinesMotion = useAnimatedVisibility(routinesVisible)
  const applyRoute = (next: Route) => {
    setRoute(next); setMenuOpen(false)
    if (next.surface === 'code') setCodeVisited(true)
    if (next.page === 'routines') setRoutinesVisited(true)
    try { localStorage.setItem(SURFACE_KEY, next.surface) } catch { /* storage unavailable */ }
  }
  const navigate = (next: Route) => {
    setHistory((old) => {
      if (JSON.stringify(old.entries[old.index]) === JSON.stringify(next)) return old
      const entries = [...old.entries.slice(0, old.index + 1), next].slice(-100)
      return { entries, index: entries.length - 1 }
    })
    applyRoute(next)
  }
  useEffect(() => {
    let live = true
    void (async () => {
      await Promise.allSettled([hydrateThemeFromSettings(), hydrateCustomThemeFromSettings(), hydrateCustomCssOverrideFromSettings(), hydrateBackgroundFromSettings()])
      let migrated = false
      try { migrated = localStorage.getItem(REFERENCE_KEY) === '1' } catch { /* no cache */ }
      // The supplied reference is dark. Install it once; subsequent appearance changes remain user-controlled.
      if (!migrated && window.piDesktop && live) {
        try {
          await window.piDesktop.invoke('ipc:settings.set', { key: 'theme', value: 'dark' })
          await window.piDesktop.invoke('ipc:settings.set', { key: 'customTheme', value: REFERENCE_DESKTOP_THEME })
          if (!live) return
          useUIStore.getState().setSidebarWidth(290)
          useUIStore.setState({ sidebarCollapsed: false })
          applyUiZoom(referenceUiZoom(window.devicePixelRatio))
          await Promise.all([hydrateThemeFromSettings(), hydrateCustomThemeFromSettings()])
          localStorage.setItem(REFERENCE_KEY, '1')
        } catch { /* Read-only settings do not prevent using the app. */ }
      }
    })()
    applyUiZoom(readUiZoom())
    const stop = watchSystemTheme()
    if (!storedSurfaceExists()) void window.piDesktop?.invoke('ipc:settings.get', { key: 'currentProject' }).then((result) => {
      if (live && !storedSurfaceExists() && result?.settings?.currentProject) {
        const next: Route = { surface: 'code', page: 'workspace' }
        setRoute(next); setCodeVisited(true); setHistory({ entries: [next], index: 0 })
      }
    }).catch(() => {})
    void window.piDesktop?.invoke('ipc:desktop.identity').then((result) => { if (live && typeof result?.userName === 'string') setUserName(result.userName) }).catch(() => {})
    const navState = (event: Event) => {
      const detail = (event as CustomEvent<{ back: boolean; forward: boolean }>).detail
      if (detail) setChatNavigation({ back: !!detail.back, forward: !!detail.forward })
    }
    window.addEventListener('pi-desktop:chat-navigation-state', navState)
    return () => { live = false; stop(); window.removeEventListener('pi-desktop:chat-navigation-state', navState) }
  }, [])
  useEffect(() => {
    const runningChats = new Set<string>()
    const completedRuns = new Set<string>()
    const offChat = window.piDesktop?.onChatEvent?.((event) => {
      if (event.kind !== 'session') return
      if (event.session.status === 'running') { runningChats.add(event.session.id); return }
      if (!runningChats.delete(event.session.id)) return
      if (visiblePage.current.page === 'workspace' && visiblePage.current.surface === 'chat') return
      if (event.session.status === 'failed') toast.error(event.session.title)
      else toast.success(event.session.title)
    })
    const offRoutine = window.piDesktop?.onRoutineEvent?.((event) => {
      if (event.kind !== 'run' || !['succeeded', 'failed'].includes(event.run.status) || completedRuns.has(event.run.id)) return
      completedRuns.add(event.run.id)
      if (completedRuns.size > 1000) completedRuns.delete(completedRuns.values().next().value!)
      if (visiblePage.current.page === 'routines') return
      if (event.run.status === 'failed') toast.error('Routine failed')
      else toast.success('Routine completed')
    })
    return () => { offChat?.(); offRoutine?.() }
  }, [])
  useEffect(() => {
    if (!menuOpen) return
    const away = (event: MouseEvent) => { if (event.target instanceof Node && !chromeLeft.current?.contains(event.target)) setMenuOpen(false) }
    const frame = requestAnimationFrame(() => mainMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuTrigger.current?.focus() } }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', escape)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  const chooseSurface = (value: ProductSurface) => { if (!location.busy) navigate({ surface: value, page: 'workspace' }) }
  const openSettingsAt = (start: SettingsPageKey) => {
    if (!settingsOpen) settingsReturnPage.current = page === 'routines' ? 'routines' : 'workspace'
    setSettingsStart(start); navigate({ ...route, page: 'settings' })
  }
  const openSettings = () => openSettingsAt('general')
  const openCustomize = () => { if (!settingsOpen) settingsReturnPage.current = page === 'routines' ? 'routines' : 'workspace'; setSettingsStart('skills'); navigate({ ...route, page: 'customize' }) }
  useEffect(() => {
    const openUsage = () => openSettingsAt('usage')
    const openCapabilities = () => openSettingsAt('rightPanels')
    window.addEventListener('pi-desktop:open-usage-settings', openUsage)
    window.addEventListener('pi-desktop:open-capability-settings', openCapabilities)
    return () => { window.removeEventListener('pi-desktop:open-usage-settings', openUsage); window.removeEventListener('pi-desktop:open-capability-settings', openCapabilities) }
  })
  const openRoutines = () => navigate({ ...route, page: 'routines' })
  const registerCodeNew = useCallback((handler: (() => void) | null) => {
    codeNewHandler.current = handler
    const current = visiblePage.current
    if (handler && pendingCodeNew.current && current.surface === 'code' && current.page === 'workspace') { pendingCodeNew.current = false; handler() }
  }, [])
  const newSession = () => {
    if (location.busy) return
    if (surface === 'code') {
      navigate({ surface: 'code', page: 'workspace' })
      if (codeActive && codeNewHandler.current) codeNewHandler.current()
      else pendingCodeNew.current = true
    } else {
      navigate({ ...route, page: 'workspace' })
      window.dispatchEvent(new CustomEvent('pi-desktop:chat-new'))
    }
  }
  const go = (direction: -1 | 1) => {
    if (location.busy) return
    if (chatActive && (direction < 0 ? chatNavigation.back : chatNavigation.forward)) { window.dispatchEvent(new CustomEvent(direction < 0 ? 'pi-desktop:chat-back' : 'pi-desktop:chat-forward')); return }
    const index = history.index + direction
    if (index < 0 || index >= history.entries.length) return
    setHistory((old) => ({ ...old, index })); applyRoute(history.entries[index])
  }
  const footerEnvironment = routinesVisible ? 'Local · Routines' : surface === 'code' && (location.selectedProfile || location.snapshot.targetId.startsWith('ssh:')) ? `SSH · ${location.selectedProfile?.name || location.snapshot.connections.find((item) => `ssh:${item.profileId}` === location.snapshot.targetId)?.name || 'Remote'}` : 'Local'
  const footer = <ReferenceAccountFooter name={userName} environmentLabel={footerEnvironment} onSettings={openSettings} onRoutines={openRoutines} onUsage={() => openSettingsAt('usage')} onModels={() => openSettingsAt('models')} onLanguage={(language) => { void window.piDesktop?.invoke('ipc:settings.set', { key: 'language', value: language }).then(() => i18n.changeLanguage(language)).catch(() => toast.error('Could not change language')) }} onQuit={() => { void window.piDesktop?.invoke('ipc:app.quit').catch(() => toast.error('Could not quit')) }} />
  const selectedProfileId = location.selectedProfile?.id || (location.snapshot.targetId.startsWith('ssh:') ? location.snapshot.targetId.slice(4) : undefined)
  const environmentControl = <ReferenceEnvironmentControl profiles={location.profiles} selectedProfileId={selectedProfileId} selectedName={location.selectedProfile?.name || (selectedProfileId ? location.snapshot.connections.find((item) => item.profileId === selectedProfileId)?.name || 'SSH' : 'Local')} onLocal={() => void location.chooseLocal()} onSsh={(id) => id ? void location.chooseSsh(id) : location.addConnection()} onEdit={location.editConnection} onDisconnect={(id) => void location.disconnect(id)} />
  const sessionCatalogRefreshKey = JSON.stringify([location.snapshot.targetId, location.snapshot.connections.map((item) => [item.profileId, item.status]), location.snapshot.workspaces.map((item) => item.workspaceId), location.profiles.map((item) => [item.id, item.name, item.host, item.port, item.user, item.authMethod, item.identityFile, item.nodePath, item.piPath])])
  const environmentError = location.error ? <div className="reference-code-environment-error" role="alert">{location.error}{selectedProfileId && <button onClick={() => location.editConnection(selectedProfileId)}>Edit connection</button>}<button onClick={location.clearError}>Dismiss</button></div> : undefined
  const style = { '--reference-sidebar-width': `${sidebarWidth}px` } as CSSProperties

  return <ErrorBoundary><div className={`product-shell reference-shell app-viewport text-foreground ${collapsed ? 'reference-sidebar-collapsed' : ''}`} style={style}>
    <header className="reference-chrome electron-drag">
      <div ref={chromeLeft} className="reference-chrome-left electron-no-drag">
        <div className="reference-window-navigation"><button ref={menuTrigger} data-app-tooltip="Main menu" aria-label="Main menu" aria-haspopup="menu" aria-controls={menuOpen ? 'product-main-menu' : undefined} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 4h14M3 10h10M3 16h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button data-app-tooltip={collapsed ? 'Show sidebar' : 'Hide sidebar'} aria-label="Toggle sidebar" onClick={() => useUIStore.getState().toggleSidebar()}><PanelLeft size={18} /></button><button data-app-tooltip="Back" aria-label="Back" disabled={!(chatActive && chatNavigation.back) && history.index === 0} onClick={() => go(-1)}><ArrowLeft size={19} /></button><button data-app-tooltip="Forward" aria-label="Forward" disabled={!(chatActive && chatNavigation.forward) && history.index >= history.entries.length - 1} onClick={() => go(1)}><ArrowRight size={19} /></button></div>
        <nav className="reference-mode-switch" aria-label="Workspace type"><button aria-label="Chat" data-app-tooltip="Chat" disabled={location.busy} aria-current={surface === 'chat' ? 'page' : undefined} className={surface === 'chat' ? 'selected' : ''} onClick={() => chooseSurface('chat')}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.5 15a7.5 7.5 0 1 0-9.3.2L4 19l4.1-1.4a7.5 7.5 0 0 0 6.4-2.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M17.5 8.5a6.1 6.1 0 0 1 1 10L20 22l-4.4-1.4a6 6 0 0 1-5-1" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg></button><button aria-label="Code" data-app-tooltip="Code" disabled={location.busy} aria-current={surface === 'code' ? 'page' : undefined} className={surface === 'code' ? 'selected' : ''} onClick={() => chooseSurface('code')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button></nav>
        {menuOpen && <div ref={mainMenu} id="product-main-menu" className="reference-app-menu" role="menu" aria-label="Main menu actions" onKeyDown={(event) => {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          } else if (event.key === 'Tab') {
            event.preventDefault(); setMenuOpen(false)
            const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex="0"]')].filter((element) => !element.matches(':disabled') && !element.closest('[hidden], [inert]') && !mainMenu.current?.contains(element) && element.getClientRects().length > 0)
            const anchor = controls.indexOf(menuTrigger.current!)
            controls[(anchor + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
          }
        }}><button role="menuitem" onClick={newSession}>New {surface === 'chat' ? 'chat' : 'session'}</button><button role="menuitem" onClick={openRoutines}>New routine</button><button role="menuitem" onClick={openCustomize}>Customize</button><button role="menuitem" onClick={openSettings}><Settings size={14} />Settings</button></div>}
      </div>
      <div className="reference-chrome-main">{surface === 'chat' && <button className="reference-incognito" disabled data-app-tooltip="Temporary Chat is not implemented" aria-label="Temporary Chat unavailable"><svg width="21" height="23" viewBox="0 0 24 26" fill="none" aria-hidden="true"><path d="M3 23V11a9 9 0 0 1 18 0v12l-4-3-5 3-5-3-4 3Z" stroke="currentColor" strokeWidth="1.5" /><circle cx="9" cy="11" r="1" fill="currentColor" /><circle cx="15" cy="11" r="1" fill="currentColor" /></svg></button>}<WindowControls /></div>
    </header>
    <div className="product-workspaces">
      <section hidden={chatMotion.hidden} aria-hidden={!chatVisible} data-workspace-visibility={chatMotion.phase} ref={(node) => node?.toggleAttribute('inert', settingsOpen || !chatVisible)} className="product-workspace" aria-label="Chat workspace"><ErrorBoundary label="Chat"><Suspense fallback={<ProductLoading />}><ChatPage onSettings={openSettings} onRoutines={openRoutines} onCustomize={openCustomize} sidebarFooter={footer} /></Suspense></ErrorBoundary></section>
      {codeVisited && location.ready && <section hidden={codeMotion.hidden} aria-hidden={!codeVisible} data-workspace-visibility={codeMotion.phase} ref={(node) => node?.toggleAttribute('inert', settingsOpen || location.busy || !codeVisible)} className="product-workspace" aria-label="Code workspace" data-execution-target={selectedProfileId ? 'ssh' : 'local'}><ErrorBoundary label="Code"><Suspense fallback={<ProductLoading />}><CodeWorkspace active={codeActive} executionLocked={location.locked} executionError={environmentError} onChooseFolder={location.chooseFolder} folderControl={<ReferenceFolderControl />} noProject={location.noProject} workspaceLabel={location.noProject ? 'No project' : location.workspace?.name} workspacePathLabel={location.noProject && location.workspace ? `Remote home · ${location.workspace.nativePath}` : location.workspace?.nativePath} onSettingsClosed={() => navigate({ ...route, page: 'workspace' })} onRoutines={openRoutines} onCustomize={openCustomize} userName={userName} environmentControl={environmentControl} sidebarFooter={footer} onOpenSession={location.openUnifiedSession} sessionCatalogRefreshKey={sessionCatalogRefreshKey} onNewSessionReady={registerCodeNew} /></Suspense></ErrorBoundary></section>}
      {settingsOpen && <CodeLocationModal title={page === 'customize' ? 'Customize' : 'Settings'} className="reference-settings-dialog" onClose={() => navigate({ ...route, page: settingsReturnPage.current })} initialFocus="input"><section aria-label="App settings"><ErrorBoundary label="Settings"><Suspense fallback={<ProductLoading />}><SettingsPage referenceLayout initialPage={settingsStart} /></Suspense></ErrorBoundary></section></CodeLocationModal>}
      {routinesVisited && <section hidden={routinesMotion.hidden} aria-hidden={!routinesVisible} data-workspace-visibility={routinesMotion.phase} ref={(node) => node?.toggleAttribute('inert', settingsOpen || !routinesVisible)} className="product-workspace" aria-label="Routines workspace"><ErrorBoundary label="Routines"><Suspense fallback={<ProductLoading />}><RoutinesPage surface={surface} sidebarFooter={footer} onNewWorkspace={newSession} onCustomize={openCustomize} onSelectLocalFolder={location.selectLocalFolder} /></Suspense></ErrorBoundary></section>}
    </div>
  </div><AppTooltipHost /><AppToaster /><AppUpdateHost /><CloseDecisionDialog /></ErrorBoundary>
}
function ProductLoading() { return <div className="product-loading" role="status">Loading…</div> }
