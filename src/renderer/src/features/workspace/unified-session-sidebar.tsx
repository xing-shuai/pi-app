import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionCatalogEntry, SessionCatalogResult } from '@shared/session-catalog-types'
import { filterSessionCatalog } from '@shared/session-catalog-types'
import { useUIStore } from '@renderer/stores/ui-store'
import { Plus, Search } from '@renderer/components/icons'
import { selectSessionAttention } from '@renderer/lib/session-attention'
import { SessionAttentionDot } from './session-attention-dot'
import { useSessionContextMenu } from './use-session-context-menu'
import { SessionContextMenuPortal } from './session-context-menu'
import { SessionFilterMenu } from './session-filter-menu'
import './unified-session-sidebar.css'

export type UnifiedSessionSidebarProps = {
  onOpenSession?: (entry: SessionCatalogEntry) => Promise<void> | void
  onNewSession: () => void
  onOpenProject: () => void
  openProjectLabel: string
  /** Parent can pass environment snapshots/event revision; no new global native subscriptions. */
  catalogRefreshKey?: unknown
}
const empty: SessionCatalogResult = { sessions: [], locations: [] }
export function UnifiedSessionSidebar({ onOpenSession, onNewSession, onOpenProject, openProjectLabel, catalogRefreshKey }: UnifiedSessionSidebarProps) {
  const [catalog, setCatalog] = useState<SessionCatalogResult>(empty)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const revision = useRef(0)
  const currentWorkspace = useUIStore((state) => state.currentWorkspace)
  const currentSession = useUIStore((state) => state.currentSessionId)
  const attention = useUIStore((state) => state.sessionAttention)
  const sessions = useUIStore((state) => state.sessions)
  const refresh = useCallback(async () => {
    const token = ++revision.current
    setLoading(true)
    try {
      if (!window.piDesktop) throw new Error('Session catalog requires the desktop app')
      const result = await window.piDesktop.invoke('ipc:code.sessions.list', { filter, search: query }) as SessionCatalogResult
      if (!result || !Array.isArray(result.sessions) || !Array.isArray(result.locations)) throw new Error('Session catalog unavailable')
      if (revision.current === token) { setCatalog(result); setError('') }
    } catch { if (revision.current === token) setError('Could not refresh sessions') }
    finally { if (revision.current === token) setLoading(false) }
  }, [filter, query])
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => { void refresh(); return () => { ++revision.current } }, [refresh, catalogRefreshKey, currentWorkspace, currentSession, sessions])
  useEffect(() => { if (searchOpen) input.current?.focus() }, [searchOpen])
  useEffect(() => { if (!loading && !error && filter.startsWith('ssh:') && !catalog.locations.some((item) => item.targetId === filter)) setFilter('all') }, [catalog.locations, filter, loading, error])
  const menu = useSessionContextMenu(() => { void refresh() })
  const hosts = [...new Map(catalog.locations.filter((item) => item.profileId).map((item) => [item.targetId, item])).values()]
  const rows = filterSessionCatalog(catalog.sessions, { filter, search })
  return <section className="unified-session-sidebar" aria-label="Sessions">
    <div className="unified-session-toolbar">
      <SessionFilterMenu value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All sessions' }, { value: 'local', label: 'Local' }, { value: 'ssh', label: 'SSH' }, ...hosts.map((host) => ({ value: host.targetId, label: host.label }))]} />
      <button type="button" data-app-tooltip={openProjectLabel} aria-label={openProjectLabel} onClick={onOpenProject}><Plus aria-hidden /></button>
      <button type="button" aria-label="Search sessions" data-app-tooltip="Search sessions" aria-expanded={searchOpen} onClick={() => { if (searchOpen) { setSearch(''); setQuery('') } setSearchOpen((value) => !value) }}><Search aria-hidden /></button>
    </div>
    {searchOpen && <input ref={input} type="search" maxLength={512} aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} />}
    <div className="unified-session-list" aria-busy={loading}>
      {rows.map((entry) => {
        const state = selectSessionAttention(entry.sessionFile, attention)
        const marker = state !== 'idle' ? state : entry.status === 'busy' ? 'working' : entry.status === 'needs-attention' ? 'needs-you' : 'idle'
        const openEntry = () => { void Promise.resolve(onOpenSession?.(entry)).catch(() => setError('Could not open session')) }
        const target = { sessionId: entry.sessionId, sessionFile: entry.sessionFile, title: entry.title, workspacePath: entry.workspaceId, disconnected: entry.disconnected, onContinue: openEntry }
        return <div key={entry.key} className="unified-session-row" data-session-key={entry.key}
          aria-current={currentWorkspace === entry.workspaceId && currentSession === entry.sessionId ? 'true' : undefined}
          onContextMenu={(event) => menu.open(event, target)}>
          <button type="button" className="unified-session-open sidebar-session-hit" disabled={!onOpenSession} onClick={openEntry}>
          <span className="unified-session-title"><SessionAttentionDot attention={marker} /><span>{entry.title || 'New session'}</span>{marker !== 'idle' && <span className="sr-only">{marker === 'working' ? 'Running' : marker === 'needs-you' ? 'Needs attention' : 'Done'}</span>}</span>
          <small title={entry.nativePathDisplay}>{entry.projectName} · {entry.locationLabel}{entry.disconnected && <span className="unified-session-disconnected"> · Disconnected</span>}</small>
          </button>
          <button type="button" className="unified-session-more" aria-label={`Session actions: ${entry.title || 'New session'}`} aria-haspopup="menu" onClick={(event) => menu.open(event, target)}><span aria-hidden>⋯</span></button>
        </div>
      })}
      {!loading && rows.length === 0 && <p className="unified-session-empty">No sessions found</p>}
    </div>
    {catalog.limited && <p className="unified-session-empty">Showing up to 500 recent matches. Refine the filter or search.</p>}
    {(error || catalog.locations.some((item) => item.error)) && <button className="unified-session-retry" onClick={() => { void refresh() }}>{error || 'Some sessions unavailable'} · Retry</button>}
    <button type="button" className="unified-session-new" onClick={onNewSession}><Plus aria-hidden />New session</button>
    <SessionContextMenuPortal menu={menu.menu} onClose={menu.close} onSessionsChange={menu.onSessionsChange} />
  </section>
}
