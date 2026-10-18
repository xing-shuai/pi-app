import { useEffect, useState } from 'react'
import { ChevronRight, Folder, Monitor } from '@renderer/components/icons'
import type { HostDirectory } from '@shared/ssh-host-types'
import { CodeLocationModal } from './code-location-modal'

export function RemoteFolderDialog({ initialPath, hostLabel, browse, onSelect, onClose, onNoProject }: { initialPath: string; hostLabel: string; browse: (path: string) => Promise<HostDirectory>; onSelect: (path: string) => void; onClose: () => void; onNoProject?: () => void }) {
  const [path, setPath] = useState(initialPath || '~')
  const [directory, setDirectory] = useState<HostDirectory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sequence, setSequence] = useState(0)
  useEffect(() => {
    let live = true
    setBusy(true); setError('')
    void browse(path).then((value) => { if (live) { setDirectory(value); setPath(value.path) } }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Could not read the remote directory') }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
    // Explicit Go/directory navigation controls requests; typing never probes local files.
  }, [sequence])
  const go = (next: string) => { setPath(next); setSequence((n) => n + 1) }
  const parts = (directory?.path || '/').split('/').filter(Boolean)
  const parent = '/' + parts.slice(0, -1).join('/')
  return <CodeLocationModal title="Select remote folder" onClose={onClose} className="remote-folder-dialog" footer={<><button onClick={onClose}>Cancel</button>{onNoProject && <button onClick={onNoProject}>No project · Remote home</button>}<button className="code-location-primary" disabled={busy || !directory || path !== directory.path} onClick={() => { if (directory) onSelect(directory.path) }}>Select folder</button></>}>
    <span className="sr-only">Browsing on {hostLabel}, never on this computer.</span>
    <form className="remote-folder-path" onSubmit={(event) => { event.preventDefault(); setSequence((n) => n + 1) }}><input aria-label="Remote folder path" value={path} onChange={(event) => setPath(event.target.value)} /><button disabled={busy || !path.trim()}>Go</button></form>
    <nav className="remote-folder-breadcrumb" aria-label="Remote folder breadcrumb"><button title="Remote filesystem root" onClick={() => go('/')}><Monitor size={16} /></button>{parts.map((part, index) => <span key={index}>{index > 0 && <ChevronRight size={13} />}<button onClick={() => go('/' + parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</nav>
    {error && <p className="code-location-error" role="alert">{error}</p>}
    <div className="remote-folder-list" aria-busy={busy}><button disabled={busy || directory?.path === '/'} onClick={() => go(parent)}><Folder size={18} /><span>..</span></button>{directory?.entries.filter((entry) => entry.directory).map((entry) => <button key={entry.path} disabled={busy} onClick={() => go(entry.path)}><Folder size={18} /><span>{entry.name}</span></button>)}{busy && <p role="status">Reading remote folders…</p>}</div>
  </CodeLocationModal>
}
