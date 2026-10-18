import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Folder, Monitor } from '@renderer/components/icons'
import type { LocalFolderBrowseRequest, LocalFolderBrowseResult, LocalFolderResolveResult } from '@shared/local-folder-types'
import { CodeLocationModal } from './code-location-modal'

type Props = {
  initialPath?: string
  recentPaths?: string[]
  browse: (request: LocalFolderBrowseRequest) => Promise<LocalFolderBrowseResult>
  resolve: (path: string) => Promise<LocalFolderResolveResult>
  onSelect: (path: string) => void
  onClose: () => void
}
/** Display native path components without translating them into SSH/virtual paths. */
export function localFolderBreadcrumbs(path: string): { name: string; path: string }[] {
  const drive = /^[a-z]:[\\/]/i.exec(path)
  const separator = drive ? (path.includes('\\') ? '\\' : '/') : '/'
  const root = drive ? drive[0] : '/'
  const parts = path.slice(root.length).split(drive ? /[\\/]/ : /\//).filter(Boolean)
  return [{ name: root, path: root }, ...parts.map((name, index) => ({ name, path: root + parts.slice(0, index + 1).join(separator) }))]
}
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Could not read this local folder.'

export function LocalFolderDialog({ initialPath, recentPaths = [], browse, resolve, onSelect, onClose }: Props) {
  const [draft, setDraft] = useState(initialPath || '~')
  const [request, setRequest] = useState({ path: initialPath || '~', includeHidden: false, version: 0 })
  const draftRef = useRef(draft)
  const [directory, setDirectory] = useState<LocalFolderBrowseResult | null>(null)
  const [busy, setBusy] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const alive = useRef(true)
  const browseRef = useRef(browse); browseRef.current = browse
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current } }, [])
  useEffect(() => {
    const token = ++generation.current
    setBusy(true); setError('')
    void browseRef.current({ path: request.path, includeHidden: request.includeHidden }).then((value) => {
      if (alive.current && generation.current === token) {
        setDirectory(value)
        if (draftRef.current === request.path) { draftRef.current = value.path; setDraft(value.path) }
      }
    }).catch((reason) => {
      if (alive.current && generation.current === token) { setDirectory(null); setError(message(reason)) }
    }).finally(() => { if (alive.current && generation.current === token) setBusy(false) })
  }, [request])
  const close = () => { ++generation.current; alive.current = false; onClose() }
  const go = (path: string, includeHidden = request.includeHidden) => {
    if (resolving) return
    ++generation.current; setBusy(true); draftRef.current = path; setDraft(path)
    setRequest((prior) => ({ path, includeHidden, version: prior.version + 1 }))
  }
  const select = async () => {
    if (busy || resolving || !directory || draft !== directory.path) return
    const token = ++generation.current
    setResolving(true); setError('')
    try {
      // Revalidate and canonicalize at confirmation, before any trust/activation flow.
      const value = await resolve(directory.path)
      if (alive.current && generation.current === token) onSelect(value.path)
    } catch (reason) { if (alive.current && generation.current === token) setError(message(reason)) }
    finally { if (alive.current && generation.current === token) setResolving(false) }
  }
  const pending = busy || resolving
  const parent = directory?.parent
  const recent = [...new Set(recentPaths)].filter((path) => !path.replace(/\\/g, '/').match(/^\/__pi_ssh__(?:\/|$)/)).slice(0, 5)
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  return <CodeLocationModal title="Select local folder" className="local-folder-dialog" onClose={close} footer={<><button type="button" onClick={close}>Cancel</button><button type="button" className="code-location-primary" disabled={pending || !directory || draft !== directory.path} onClick={() => void select()}>{resolving ? 'Checking folder…' : 'Select folder'}</button></>}>
    <div className="local-folder-content" onKeyDown={(event) => { if (event.altKey && event.key === 'ArrowUp' && parent && !pending) { event.preventDefault(); go(parent) } }}>
      <p className="local-folder-machine"><Monitor size={17} />Local · On this computer</p>
      <p className="code-location-help">Choose a directory. Browsing does not start an agent or change your project.</p>
      <nav className="local-folder-shortcuts" aria-label="Local folder shortcuts">
        <button type="button" disabled={pending} onClick={() => go(directory?.home || '~')}>Home</button>
        {directory?.roots.map((root) => <button type="button" key={root.path} disabled={pending} title={root.path} onClick={() => go(root.path)}>{root.name}</button>)}
      </nav>
      {recent.length > 0 && <nav className="local-folder-recents" aria-label="Recent local folders"><span>Recent</span>{recent.map((path) => <button type="button" key={path} title={path} disabled={pending} onClick={() => go(path)}>{path}</button>)}</nav>}
      <form className="local-folder-path" onSubmit={(event) => { event.preventDefault(); if (!resolving && draft) go(draft) }}>
        <input aria-label="Local folder path" value={draft} disabled={resolving} spellCheck={false} autoComplete="off" maxLength={4096} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value) }} />
        <button type="submit" disabled={resolving || !draft}>Go</button>
      </form>
      {directory && <nav className="local-folder-breadcrumb" aria-label="Local folder breadcrumb">{localFolderBreadcrumbs(directory.path).map((part, index) => <span key={part.path}>{index > 0 && <ChevronRight size={13} />}<button type="button" title={part.path} disabled={pending} aria-current={part.path === directory.path ? 'location' : undefined} onClick={() => go(part.path)}>{part.name}</button></span>)}</nav>}
      <div className="local-folder-tools"><button type="button" disabled={pending || !parent} onClick={() => { if (parent) go(parent) }}>Parent</button><label><input type="checkbox" checked={request.includeHidden} disabled={pending} onChange={(event) => go(directory?.path || request.path, event.target.checked)} />Show hidden folders</label></div>
      {error && <p className="code-location-error" role="alert">{error}</p>}
      <div className="local-folder-list" aria-label="Local directories" aria-busy={pending} onKeyDown={listKeys}>
        {busy ? <p role="status">Reading local folders…</p> : directory?.entries.map((entry) => <button type="button" key={entry.path} disabled={resolving} title={entry.path} onClick={() => go(entry.path)}><Folder size={18} /><span>{entry.name}</span>{entry.symlink && <small>Link</small>}</button>)}
        {!busy && directory?.entries.length === 0 && <p>No subfolders{request.includeHidden ? '' : ' (hidden folders are off)'}.</p>}
        {resolving && <p role="status">Checking local folder…</p>}
      </div>
      {directory?.truncated && <p className="code-location-help">Showing the first 500 folders. Enter a path to reach another folder.</p>}
    </div>
  </CodeLocationModal>
}
