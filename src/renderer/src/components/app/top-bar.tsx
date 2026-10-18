import { useTranslation } from 'react-i18next'
import { ChevronLeft, CircleDot, PanelLeft, PanelRight } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { useRightPanelHidden } from '@renderer/lib/use-right-panel-hidden'
import { isMac, MAC_TRAFFIC_LIGHTS_SPACER_CLASS } from '@renderer/lib/platform'
import { WindowControls } from '@renderer/components/app/window-controls'

interface TopBarProps {
  embedded?: boolean
  onBack?: () => void
  title?: string
  /** @deprecated ignored — running status chrome removed */
  isRunning?: boolean
  projectName?: string
}

export function TopBar({ onBack, title, projectName, embedded = false }: TopBarProps) {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const rightCollapsed = useRightPanelHidden()
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const showRightToggle = !onBack
  const isSettings = !!onBack
  return (
    <div className="electron-drag flex h-11 items-center justify-between border-b border-border/60 px-3" style={{ background: 'var(--surface-sidebar)' }}>
      <div className="electron-no-drag flex min-w-0 items-center gap-2.5">
        {isMac && !embedded && <div aria-hidden className={MAC_TRAFFIC_LIGHTS_SPACER_CLASS} />}
        {!onBack && (
          <button
            onClick={toggleSidebar}
            title={collapsed ? t('common:topbar.expandSidebar') : t('common:topbar.collapseSidebar')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-motion-fast ease-motion-ease active:scale-95"
          >
            <PanelLeft className={cn('h-3.5 w-3.5 transition-transform duration-motion-normal ease-motion-ease', collapsed && 'rotate-180')} />
          </button>
        )}
        {onBack && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onBack()
            }}
            className={cn('electron-no-drag chrome-icon-btn flex items-center gap-1 rounded-md px-2 py-1.5 text-foreground-secondary hover:text-foreground', embedded ? 'text-[14px]' : 'text-[13px]')}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('common:topbar.back')}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {!isSettings && <CircleDot className="h-3.5 w-3.5 text-primary" />}
          <span className={cn('font-semibold tracking-tight', embedded ? 'text-[16px]' : 'text-[13px]')}>{title || t('common:app.name')}</span>
        </div>
        {projectName && (
          <>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-[13px] text-muted-foreground">{projectName}</span>
          </>
        )}
      </div>
      <div className="electron-no-drag flex h-9 shrink-0 items-center gap-2">
        {showRightToggle && (
          <button
            type="button"
            onClick={toggleRightPanel}
            title={rightCollapsed ? t('common:topbar.expandRightPanel') : t('common:topbar.collapseRightPanel')}
            className="chrome-icon-btn flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground"
          >
            <PanelRight className={cn('h-3.5 w-3.5 transition-transform duration-motion-normal ease-motion-ease', rightCollapsed && 'rotate-180')} />
          </button>
        )}
        {!embedded && <WindowControls className={isSettings ? '-mr-2 border-l border-border/40 pl-0.5' : undefined} />}
      </div>
    </div>
  )
}
