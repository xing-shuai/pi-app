import { PanelRightOpen } from '@renderer/components/icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { useRightPanelHidden } from '@renderer/lib/use-right-panel-hidden'

/** One edge control; feature tabs live inside the drawer, never above the conversation. */
export function MainColRightPanelToggle({ disabled = false, panelIds }: { disabled?: boolean; panelIds?: string[] }) {
  const hidden = useRightPanelHidden()
  if (!hidden) return null
  return <button type="button" className="workspace-panel-edge-toggle electron-no-drag" aria-label="Open workspace panel" aria-controls="workspace-panel-drawer" aria-expanded={false} data-app-tooltip="Open workspace panel" disabled={disabled} onClick={() => {
    const store = useUIStore.getState()
    const available = panelIds ?? store.rightPanelCatalog.filter((item) => store.rightPanelPrefs[item.id]).map((item) => item.id)
    if (!available.includes(store.activePanel) && available[0]) store.setActivePanel(available[0])
    store.revealRightPanel()
  }}><PanelRightOpen size={18} /></button>
}
