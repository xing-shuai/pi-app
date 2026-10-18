import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from '@renderer/components/icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { ComposerPopover } from './composer-popover'
import { ProviderUsagePanel } from './provider-usage-panel'
import type { useComposerMetrics } from './use-composer-metrics'
import '@renderer/styles/compact-composer-popovers.css'

type ContextMetrics = Pick<ReturnType<typeof useComposerMetrics>, 'estContextTokens' | 'contextWindow' | 'ctxPct'>
export interface CodeUsagePopoverProps {
  metrics: ContextMetrics
  onOpenUsage?: () => void
}

/** Local cap complements ComposerPopover placement without changing other composer menus. */
export function useCompactPopoverHeight(open: boolean, anchorSelector: string): number {
  const [height, setHeight] = useState(418)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const zoom = Number(document.documentElement.style.zoom) || 1
      const anchor = document.querySelector(anchorSelector)
      const available = anchor ? anchor.getBoundingClientRect().top - 14 : window.innerHeight - 168
      setHeight(Math.max(0, Math.min(418, available / zoom - 2)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, anchorSelector])
  return height
}

/** Local text estimates and remote Pi context estimates are not subscription allowance. */
export function CodeUsagePopover({ metrics, onOpenUsage }: CodeUsagePopoverProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const id = useId()
  const maxHeight = useCompactPopoverHeight(open, `[data-code-usage-id="${id}"]`)
  const usage = useUIStore((state) => state.runState.usage)
  const workspaceId = useUIStore((state) => state.currentWorkspace)
  const sessionFile = useUIStore((state) => state.historySessionFile)
  const modelKey = useUIStore((state) => state.runState.model)
  const sessionId = useUIStore((state) => state.currentSessionId)
  const remote = workspaceId?.startsWith('/__pi_ssh__/') === true
  const close = useCallback(() => setOpen(false), [])
  const used = metrics.estContextTokens != null && Number.isFinite(metrics.estContextTokens) && metrics.estContextTokens >= 0 ? metrics.estContextTokens : null
  const max = metrics.contextWindow != null && Number.isFinite(metrics.contextWindow) && metrics.contextWindow > 0 ? metrics.contextWindow : null
  const percent = used != null && max != null ? used / max * 100 : null
  const filled = Math.max(0, Math.min(100, percent ?? 0))
  const contextLabel = used != null ? `~${formatTokens(used)} / ${max != null ? formatTokens(max) : 'unknown'}${percent != null ? ` (${percent.toFixed(1)}%)` : ''}` : `Unavailable${max != null ? ` / ${formatTokens(max)}` : ''}`

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => content.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (document.activeElement === document.body || content.current?.contains(document.activeElement)) trigger.current?.focus()
    }
  }, [open])

  const details = () => {
    setOpen(false)
    if (onOpenUsage) onOpenUsage()
    else window.dispatchEvent(new CustomEvent('pi-desktop:open-usage-settings'))
  }

  return <>
    <button ref={trigger} type="button" className="code-usage-trigger" data-code-usage-id={id} aria-label="Context window and usage" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-popover` : undefined} data-app-tooltip={`Context window: ${contextLabel}`} onClick={() => setOpen((value) => !value)}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className={filled >= 80 ? 'is-high' : undefined}>
        <circle className="track" cx="10" cy="10" r="7.5" />
        <circle className="value" cx="10" cy="10" r="7.5" pathLength="100" strokeDasharray={`${filled} 100`} transform="rotate(-90 10 10)" />
      </svg>
    </button>
    {open && <ComposerPopover anchorSelector={`[data-code-usage-id="${id}"]`} width={360} label="Context window and usage" onClose={close} className="code-usage-popover compact-composer-popover">
      <div ref={content} id={`${id}-popover`} tabIndex={-1} className="code-usage-content" style={{ maxHeight }} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close()
      }}>
        <div className="code-usage-heading"><h2>Context window</h2><span>{contextLabel}</span></div>
        <div className="code-usage-progress" role={percent != null ? 'progressbar' : undefined} aria-label="Estimated context window usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent != null ? Math.round(filled) : undefined} aria-valuetext={percent != null ? contextLabel : undefined}><span style={{ width: `${filled}%` }} /></div>
        <ProviderUsagePanel workspaceId={workspaceId ?? undefined} sessionFile={sessionFile ?? undefined} modelKey={`${sessionId ?? ''}:${modelKey ?? ''}`} details={<>
          <p className="code-usage-note">{used != null ? remote ? 'Context estimate reported by this remote Pi session, not provider-exact occupancy or subscription allowance.' : 'Estimated from the current session text. Provider-reported context occupancy is unavailable.' : 'Context usage is unavailable until session context data is loaded.'}</p>
          {usage && <section aria-label="Recorded usage" className="code-usage-recorded">
            <h3>{remote ? 'Recorded session usage' : 'Recorded usage'}</h3>
            <dl>
              <div><dt>Input / output tokens</dt><dd>{formatTokens(usage.input)} / {formatTokens(usage.output)}</dd></div>
              <div><dt>Cache read / write</dt><dd>{formatTokens(usage.cacheRead)} / {formatTokens(usage.cacheWrite)}</dd></div>
              <div><dt>Reported cost</dt><dd>{Number.isFinite(usage.cost) ? `$${usage.cost.toFixed(4)}` : 'Unavailable'}</dd></div>
            </dl>
          </section>}
          <button type="button" className="code-usage-details" onClick={details}>See detailed breakdown<ChevronRight size={15} /></button>
        </>} />
      </div>
    </ComposerPopover>}
  </>
}
