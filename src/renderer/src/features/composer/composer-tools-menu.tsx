import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityId, CapabilityInfo } from '@shared/capabilities'
import { Clock, Globe, Monitor, SlidersHorizontal, Sparkles, type AppIconComponent } from '@renderer/components/icons'
import { Switch } from '@renderer/components/ui/switch'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  capabilityKey,
  loadSessionCapabilities,
  onCapabilityKeyChange,
  setSessionCapability,
  useSessionCapabilitiesStore,
} from '@renderer/lib/session-capabilities'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { ComposerPopover } from './composer-popover'
import { useCompactPopoverHeight } from './code-usage-popover'
import '@renderer/styles/compact-composer-popovers.css'

const ICONS: Record<CapabilityId, AppIconComponent> = { 'pi-ui': Sparkles, browser: Globe, chrome: Monitor }
const EMPTY: CapabilityId[] = []
type CacheWarming = 'off' | 'streaming' | 'idle'
const CACHE_MODES: CacheWarming[] = ['off', 'streaming', 'idle']

/** Global pi setting, not a per-chat capability or an assertion of model support. */
function CacheWarmingRow() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<CacheWarming | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    let current = true
    setBusy(true)
    setError(false)
    void ipcClient.invoke('pi.settings.get').then((res: { settings?: { cacheWarming?: string } | null }) => {
      if (!current) return
      const value = res?.settings?.cacheWarming
      setMode(CACHE_MODES.includes(value as CacheWarming) ? value as CacheWarming : 'streaming')
    }).catch(() => { if (current) setError(true) }).finally(() => { if (current) setBusy(false) })
    return () => { current = false; alive.current = false }
  }, [retry])
  const choose = (next: CacheWarming) => {
    if (busy || mode === null) return
    const prev = mode
    setMode(next)
    setBusy(true)
    setError(false)
    void ipcClient.invoke('pi.settings.set', { patch: { cacheWarming: next } }).then((res: { ok?: boolean }) => {
      if (alive.current && res?.ok === false) { setMode(prev); setError(true) }
    }).catch(() => { if (alive.current) { setMode(prev); setError(true) } }).finally(() => { if (alive.current) setBusy(false) })
  }
  return <section className="compact-tools-global" data-cache-warming={mode ?? ''} aria-busy={busy}>
    <h3 className="compact-section-caption">{t('composer:tools.cacheWarming.group')}</h3>
    <div className="compact-capability-heading"><Clock size={18} /><span data-app-tooltip={t('composer:tools.cacheWarming.desc')}>{t('composer:tools.cacheWarming.name')}</span></div>
    <div role="radiogroup" aria-label={t('composer:tools.cacheWarming.name')} className="compact-segments">
      {CACHE_MODES.map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy || mode === null} onClick={() => choose(value)}>{t(`composer:tools.cacheWarming.${value}`)}</button>)}
    </div>
    {error && <p role="status" className="compact-help">Could not update cache warming. <button type="button" className="compact-text-action" disabled={busy} onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
  </section>
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

type BrowserMode = 'off' | 'builtin' | 'chrome'
function BrowserModeRow({ builtin, chrome, enabled, sessionFile, onSetup }: { builtin: CapabilityInfo; chrome?: CapabilityInfo; enabled: CapabilityId[]; sessionFile: string | null; onSetup: () => void }) {
  const { t } = useTranslation()
  const mode: BrowserMode = enabled.includes('chrome') ? 'chrome' : enabled.includes('browser') ? 'builtin' : 'off'
  const pick = (next: BrowserMode) => {
    if (next === 'builtin' && !builtin.available || next === 'chrome' && !chrome?.available) return
    setSessionCapability(sessionFile, 'browser', next === 'builtin')
    setSessionCapability(sessionFile, 'chrome', next === 'chrome')
  }
  const options: { id: BrowserMode; info?: CapabilityInfo }[] = [{ id: 'off' }, { id: 'builtin', info: builtin }, { id: 'chrome', info: chrome }]
  const active = mode === 'chrome' ? chrome : mode === 'builtin' ? builtin : undefined
  const unavailable = options.filter((option) => option.id !== 'off' && !option.info?.available)
  const needsSetup = unavailable.some((option) => option.info?.reason === 'browser-panel-off' || option.info?.reason === 'chrome-off')
  const cost = active
    ? [active.tools > 0 ? (active.coreTools ? t('composer:tools.toolCountDeferred', { count: active.tools, core: active.coreTools }) : t('composer:tools.toolCount', { count: active.tools })) : '', active.promptTokens > 0 ? t('composer:tools.tokens', { n: formatTokens(active.promptTokens) }) : ''].filter(Boolean).join(' · ')
    : ''
  return <section className="compact-capability-card">
    <div className="compact-capability-heading"><Globe size={18} /><span>{t('composer:tools.browserMode.label')}</span></div>
    <div role="radiogroup" aria-label={t('composer:tools.browserMode.label')} className="compact-segments">
      {options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={mode === option.id} disabled={option.id !== 'off' && !option.info?.available} data-app-tooltip={option.info?.reason ? t(`composer:tools.reasons.${option.info.reason}`) : undefined} onClick={() => pick(option.id)}>{t(`composer:tools.browserMode.${option.id}`)}</button>)}
    </div>
    {cost && <p className="compact-help compact-capability-cost">{cost}</p>}
    {unavailable.length > 0 && <>
      <div className="compact-setup-row"><span className="compact-help" data-app-tooltip={unavailable.map((option) => `${t(`composer:tools.browserMode.${option.id}`)}: ${option.info?.reason ? t(`composer:tools.reasons.${option.info.reason}`) : 'Unavailable in this runtime'}`).join('\n')}>{needsSetup ? 'Setup required' : 'Unavailable in this runtime'}</span>{needsSetup && <button type="button" className="compact-text-action" data-app-tooltip="Open Settings → Capabilities → Right panels" onClick={onSetup}>Settings…</button>}</div>
    </>}
  </section>
}

/** Real per-session switches; none of these change approval or tool execution policies. */
export function ComposerToolsMenu({ disabled, running }: { disabled?: boolean; running?: boolean }) {
  const { t } = useTranslation()
  const sessionFile = useUIStore((state) => state.historySessionFile)
  const key = capabilityKey(sessionFile)
  const enabled = useSessionCapabilitiesStore((state) => state.byKey[key]) ?? EMPTY
  const [open, setOpen] = useState(false)
  const maxHeight = useCompactPopoverHeight(open, '[data-composer-tools]')
  const [catalog, setCatalog] = useState<CapabilityInfo[] | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const prevKey = useRef(key)
  useEffect(() => { void loadSessionCapabilities() }, [])
  useEffect(() => {
    onCapabilityKeyChange(prevKey.current, key)
    prevKey.current = key
  }, [key])
  useEffect(() => {
    // Never expose stale availability while a newly opened menu checks current preferences.
    if (!open) return
    let alive = true
    setCatalog(null)
    setCatalogError(false)
    void ipcClient.invoke('capabilities.catalog').then((res: { capabilities?: CapabilityInfo[] }) => {
      if (alive) setCatalog(res?.capabilities ?? [])
    }).catch(() => { if (alive) { setCatalog([]); setCatalogError(true) } })
    return () => { alive = false }
  }, [open])
  const label = (id: CapabilityId) => t(`composer:tools.items.${id}.name`)
  const names = enabled.map(label).join('、')
  const openSetup = () => {
    setOpen(false)
    // Dedicated shell deep-link. Opening setup must not enable any preference.
    window.dispatchEvent(new CustomEvent('pi-desktop:open-capability-settings'))
  }
  return <div className="flex min-w-0 items-center">
    <button type="button" data-composer-tools="" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={enabled.length ? t('composer:tools.enabledTitle', { names }) : t('composer:tools.button')} data-app-tooltip={enabled.length ? t('composer:tools.enabledTitle', { names }) : t('composer:tools.button')} onClick={() => setOpen((value) => !value)} className={cn('composer-toolbar-btn flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-foreground-secondary/75 disabled:opacity-30', open && 'bg-[var(--bg-active)] text-foreground', enabled.length > 0 && 'text-primary')}>
      <SlidersHorizontal className="h-[14px] w-[14px]" />
      {enabled.map((id) => <span key={id} className="composer-capability-chip hidden" data-capability={id} />)}
      {enabled.length > 0 && <span className="text-[11px] tabular-nums">{enabled.length}</span>}
    </button>
    {open && <ComposerPopover anchorSelector="[data-composer-tools]" align="start" width={360} label={t('composer:tools.title')} onClose={() => setOpen(false)} className="compact-composer-popover compact-tools-popover">
      <div className="compact-tools-content" style={{ maxHeight }}>
        <h2 className="compact-section-caption">{t('composer:tools.title')}</h2>
        {catalog === null && <p role="status" className="compact-help">Loading capabilities…</p>}
        {catalogError && <p role="status" className="compact-help">Could not load capabilities. Reopen to retry.</p>}
        {(catalog ?? []).map((cap) => {
          if (cap.id === 'chrome' && catalog?.some((item) => item.id === 'browser')) return null
          if (cap.id === 'browser') return <BrowserModeRow key="browser" builtin={cap} chrome={catalog?.find((item) => item.id === 'chrome')} enabled={enabled} sessionFile={sessionFile} onSetup={openSetup} />
          const Icon = ICONS[cap.id]
          const cost = !cap.available
            ? t(cap.reason ? `composer:tools.reasons.${cap.reason}` : 'composer:tools.comingSoon')
            : [cap.tools > 0 ? (cap.coreTools ? t('composer:tools.toolCountDeferred', { count: cap.tools, core: cap.coreTools }) : t('composer:tools.toolCount', { count: cap.tools })) : '', cap.promptTokens > 0 ? t('composer:tools.tokens', { n: formatTokens(cap.promptTokens) }) : ''].filter(Boolean).join(' · ')
          return <section key={cap.id} className="compact-capability-card">
            <div className="compact-capability-heading"><Icon size={18} /><span>{label(cap.id)}</span><Switch checked={enabled.includes(cap.id)} disabled={!cap.available} aria-label={label(cap.id)} onCheckedChange={(next) => setSessionCapability(sessionFile, cap.id, next)} /></div>
            {cost && <p className="compact-help compact-capability-cost">{cost}</p>}
          </section>
        })}
        <CacheWarmingRow />
        <details className="compact-more-info compact-tools-note"><summary>More info</summary>
          {(catalog ?? []).map((cap) => <p key={cap.id} className="compact-help"><strong>{label(cap.id)}:</strong> {t(`composer:tools.items.${cap.id}.desc`)}{!cap.available && <> · {cap.reason ? t(`composer:tools.reasons.${cap.reason}`) : t('composer:tools.comingSoon')}</>}</p>)}
          <p className="compact-help"><strong>{t('composer:tools.cacheWarming.name')}:</strong> {t('composer:tools.cacheWarming.desc')}</p>
          <p className="compact-help">{running ? t('composer:tools.noteRunning') : t('composer:tools.note')}</p>
        </details>
      </div>
    </ComposerPopover>}
  </div>
}
