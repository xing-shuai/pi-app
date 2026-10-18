import { Archive, Boxes, Clock, Plus, Puzzle } from '@renderer/components/icons'
import { UnifiedSessionSidebar, type UnifiedSessionSidebarProps } from './unified-session-sidebar'

export type ReferenceCodeSidebarProps = UnifiedSessionSidebarProps & {
  onRoutines?: () => void
  onCustomize?: () => void
}

/** Flat metadata catalog. Legacy native ProjectSidebar remains a separate surface. */
export function ReferenceCodeSidebar({ onNewSession, onRoutines, onCustomize, ...projects }: ReferenceCodeSidebarProps) {
  return (
    <div className="reference-code-sidebar">
      <nav className="reference-code-nav" aria-label="Code navigation">
        <button type="button" className="reference-code-new" aria-label="New Code session" onClick={onNewSession}><Plus aria-hidden /><span>New</span></button>
        <button type="button" disabled title="Knowledge projects are not available"><Archive aria-hidden /><span>Projects</span><small>Beta</small></button>
        <button type="button" disabled title="Artifacts are not implemented yet"><Boxes aria-hidden /><span>Artifacts</span></button>
        <button type="button" onClick={onRoutines} disabled={!onRoutines}><Clock aria-hidden /><span>Routines</span></button>
        <button type="button" onClick={onCustomize} disabled={!onCustomize}><Puzzle aria-hidden /><span>Customize</span></button>
      </nav>
      <UnifiedSessionSidebar {...projects} onNewSession={onNewSession} />
    </div>
  )
}
