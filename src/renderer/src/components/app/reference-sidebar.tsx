import { useCallback, useState } from 'react'
import { ReferenceAccountMenu, type ReferenceAccountMenuProps } from './reference-account-menu'
import referenceAsterisk from '@renderer/assets/reference-asterisk.png'
import { Archive, Boxes, ChevronDown, ChevronRight, Clock, Activity, Palette, Plus, Puzzle, Settings, SlidersHorizontal } from '@renderer/components/icons'

/** Only the asterisk was isolated from the supplied reference; no history, avatar or account data is included. */
export function ReferenceAsterisk({ size = 36.8 }: { size?: number }) {
  return <img src={referenceAsterisk} width={Math.round(size)} height={Math.round(size)} style={{ width: size, height: size }} alt="" aria-hidden="true" className="reference-asterisk" />
}
export function ReferenceSidebarNavigation({ surface, onNew, onRoutines, onCustomize, newSelected = false }: {
  surface: 'chat' | 'code'
  onNew: () => void
  onRoutines: () => void
  onCustomize: () => void
  newSelected?: boolean
}) {
  const [more, setMore] = useState(false)
  return <nav className="reference-sidebar-nav" aria-label={`${surface === 'chat' ? 'Chat' : 'Code'} navigation`}>
    <button className={newSelected ? 'selected' : ''} onClick={onNew} aria-label={surface === 'chat' ? 'New chat' : 'New Code session'}><Plus size={17} /><span>New</span></button>
    <button disabled data-app-tooltip="Knowledge Projects are not implemented yet"><Archive size={17} /><span>Projects</span><small>{surface === 'code' ? 'Beta' : 'New'}</small></button>
    <button disabled data-app-tooltip="Artifacts are not implemented yet"><Boxes size={17} /><span>Artifacts</span></button>
    <button onClick={onRoutines}><Clock size={17} /><span>{surface === 'chat' ? 'Scheduled' : 'Routines'}</span></button>
    {surface === 'chat' && <button disabled data-app-tooltip="Design is not implemented yet"><Palette size={17} /><span>Design</span></button>}
    <button onClick={onCustomize}><Puzzle size={17} /><span>Customize</span></button>
    {surface === 'chat' && <><button className="reference-more" aria-expanded={more} onClick={() => setMore((value) => !value)}><ChevronRight size={16} className={more ? 'rotate-90' : ''} /><span>More</span></button>{more && <div className="reference-more-items"><button onClick={onCustomize}><Settings size={16} />Settings & tools</button></div>}</>}
  </nav>
}
export function ReferenceAccountFooter({ name, environmentLabel = 'Local', onSettings, onRoutines, onUsage, onLanguage, onModels, onQuit }: Omit<ReferenceAccountMenuProps, 'onClose'> & { onRoutines: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  return <div className="reference-account-footer"><button className="reference-account" data-reference-account-trigger data-app-tooltip={`Desktop user: ${name || 'Local user'} · Execution: ${environmentLabel}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} aria-label="Account and settings"><span className="reference-avatar">{Array.from(name || 'Local user')[0].toUpperCase()}</span><span className="reference-account-summary"><strong>{name || 'Local user'}</strong><small>{environmentLabel}</small></span><ChevronDown size={13} /></button><div className="reference-account-shortcuts" role="group" aria-label="Account shortcuts"><button type="button" data-app-tooltip="Usage overview" aria-label="Open usage overview" onClick={onUsage ?? (() => window.dispatchEvent(new CustomEvent('pi-desktop:open-usage-settings')))}><Activity size={16} /></button><button type="button" data-app-tooltip="Settings" aria-label="Open Settings" onClick={onSettings}><Settings size={16} /></button><button type="button" data-app-tooltip="Scheduled tasks" aria-label="Open routine manager" onClick={onRoutines}><Clock size={16} /></button></div>{menuOpen && <ReferenceAccountMenu name={name} environmentLabel={environmentLabel} onSettings={onSettings} onUsage={onUsage} onLanguage={onLanguage} onModels={onModels} onQuit={onQuit} onClose={closeMenu} />}</div>
}
export function ReferenceSearchTools({ onSearch, onFilter, label = 'Recents' }: { onSearch: () => void; onFilter: () => void; label?: string }) {
  return <div className="reference-list-heading"><span>{label}</span><button onClick={onSearch} aria-label="Search conversations" data-app-tooltip="Search conversations"><svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.3" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.3" /></svg></button><button onClick={onFilter} aria-label="Sort conversations" data-app-tooltip="Sort conversations"><SlidersHorizontal size={16} /></button></div>
}
