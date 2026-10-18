import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen } from '@renderer/components/icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { virtualWorkspaceDisplayName, virtualWorkspaceDisplayPath, isVirtualWorkspacePath } from '@shared/remote-code'
import { useCodeLocation } from './code-location-context'

export function ReferenceFolderControl() {
  const location = useCodeLocation()
  const current = useUIStore((state) => state.currentWorkspace)
  const recentProjects = useUIStore((state) => state.recentProjects)
  const draft = useUIStore((state) => state.ephemeralSandboxDraft)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const remote = !!location.selectedProfile || location.snapshot.targetId.startsWith('ssh:')
  const recent = (remote ? location.snapshot.workspaces.filter((item) => item.profileId === location.selectedProfile?.id && !(location.noProject && item.workspaceId === current)).map((item) => item.workspaceId) : recentProjects.filter((path) => !isVirtualWorkspacePath(path) && !path.includes('sandbox-workspaces/'))).slice(0, 8)
  const selected = !draft && current && !current.includes('sandbox-workspaces/') ? current : null
  const workspace = location.snapshot.workspaces.find((item) => item.workspaceId === selected)
  const noProject = location.noProject || (!remote && draft)
  const label = noProject ? 'No project' : workspace?.name || (selected ? virtualWorkspaceDisplayName(selected) : 'Select folder')
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div ref={root} className="reference-folder-control"><button type="button" className="reference-code-folder" aria-label="Select project folder" aria-haspopup="menu" aria-expanded={open} data-app-tooltip={noProject ? remote ? 'No project · Remote home. Tools use your remote account permissions.' : 'No project · Private local scratch draft' : selected ? virtualWorkspaceDisplayPath(selected, location.snapshot.workspaces) : remote ? 'Select a folder on the SSH host' : 'Select a local folder'} onClick={() => setOpen((value) => !value)}><FolderOpen size={16} /><span>{label}</span></button>{open && <div className="reference-environment-menu" role="menu" aria-label="Project folders"><button role="menuitem" onClick={() => { setOpen(false); void location.chooseNoProject() }}><span>{remote ? 'No project · Remote home' : 'No project'}</span>{noProject && <Check size={15} />}</button>{recent.length > 0 && <><div className="reference-menu-separator" /><span className="reference-folder-menu-label">Recent</span></>}{recent.map((path) => <button role="menuitem" key={path} title={virtualWorkspaceDisplayPath(path, location.snapshot.workspaces)} onClick={() => { setOpen(false); void location.chooseWorkspace(path) }}><span>{location.snapshot.workspaces.find((item) => item.workspaceId === path)?.name || virtualWorkspaceDisplayName(path)}</span>{!noProject && path === selected && <Check size={15} />}</button>)}<div className="reference-menu-separator" /><button role="menuitem" onClick={() => { setOpen(false); void location.chooseFolder() }}>{remote ? 'Browse remote folder…' : 'Browse local folder…'}</button></div>}</div>
}
