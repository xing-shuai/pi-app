import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Monitor, Pencil, Terminal } from '@renderer/components/icons'
import type { EnvironmentList } from '@shared/execution-target'
import type { SshProfile } from '@shared/ssh-workspace'

export function ReferenceEnvironmentControl({ environments, profiles, selectedProfileId, selectedName, onLocal, onSsh, onEdit, onDisconnect }: {
  environments?: EnvironmentList | null
  profiles?: SshProfile[]
  selectedProfileId?: string
  selectedName?: string
  onLocal?: () => void
  onSsh: (id?: string) => void
  onEdit?: (id: string) => void
  onDisconnect?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [sshOpen, setSshOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const hostName = selectedName || environments?.targets.find((target) => target.id === environments.activeCodeTargetId)?.name || 'Local'
  const targets = profiles?.map((profile) => ({ id: profile.id, name: profile.name })) || environments?.targets.filter((target) => target.kind === 'ssh').map((target) => ({ id: target.id.slice(4), name: target.name })) || []
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setSshOpen(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setSshOpen(false) } }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="reference-environment-control" ref={root}>
    <div className="reference-environment-anchor"><button className="reference-context-chip" aria-label="Code execution environment" data-app-tooltip="Choose where Code runs" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((value) => !value); setSshOpen(false) }}>{selectedProfileId ? <Terminal size={15} /> : <Monitor size={15} />}{hostName}</button>
      {open && <div className="reference-environment-menu" role="menu" aria-label="Execution environments">
        {!sshOpen ? <><button role="menuitem" onClick={() => { setOpen(false); onLocal?.() }}><span>Local</span>{!selectedProfileId && <Check size={16} />}</button><button role="menuitem" disabled title="Cloud execution is not implemented"><span>Cloud</span><ChevronRight size={15} /></button><button role="menuitem" disabled title="Remote Control execution is not implemented"><span>Remote Control</span><ChevronRight size={15} /></button><button role="menuitem" onClick={() => setSshOpen(true)}><span>SSH</span><ChevronRight size={15} /></button></> : <><button role="menuitem" className="reference-menu-back" onClick={() => setSshOpen(false)}>‹ Environments</button>{targets.map((target) => <div className="reference-environment-profile" key={target.id}><button role="menuitem" onClick={() => { setOpen(false); onSsh(target.id) }}><span>{target.name}</span>{selectedProfileId === target.id && <Check size={15} />}</button>{onEdit && <button role="menuitem" aria-label={`Edit ${target.name}`} onClick={() => { setOpen(false); onEdit(target.id) }}><Pencil size={14} /></button>}</div>)}<div className="reference-menu-separator" /><button role="menuitem" onClick={() => { setOpen(false); onSsh() }}>Add SSH connection…</button>{selectedProfileId && onDisconnect && <button role="menuitem" onClick={() => { setOpen(false); onDisconnect(selectedProfileId) }}>Disconnect current host</button>}</>}
      </div>}
    </div>
  </div>
}
