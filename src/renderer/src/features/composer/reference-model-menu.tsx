import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Loader2, Search } from '@renderer/components/icons'
import '../../styles/reference-model-effort.css'

export type ReferenceModel = { id: string; provider: string; name?: string; available?: boolean }
export const referenceModelKey = (model: ReferenceModel) => `${model.provider}/${model.id}`
const PAGE = 60

/** Current first, then genuine recents, then catalog order. Never invent SDK defaults. */
export function quickModels(models: ReferenceModel[], current: string, recents: readonly string[], limit = 4): ReferenceModel[] {
  const byKey = new Map(models.map((model) => [referenceModelKey(model), model]))
  const result: ReferenceModel[] = []
  const add = (model: ReferenceModel | undefined) => {
    if (result.length < limit && model && !result.some((row) => referenceModelKey(row) === referenceModelKey(model))) result.push(model)
  }
  if (current) {
    const slash = current.indexOf('/')
    add(byKey.get(current) ?? { provider: slash < 0 ? '' : current.slice(0, slash), id: slash < 0 ? current : current.slice(slash + 1), available: false })
  }
  for (const key of recents) if (byKey.get(key)?.available !== false) add(byKey.get(key))
  for (const model of models) {
    if (result.length >= limit) break
    if (model.available !== false) add(model)
  }
  return result.slice(0, limit)
}

/** All rects/viewport dimensions are visual CSS pixels, not physical device pixels. */
export function placeModelMenus(anchor: Pick<DOMRect, 'right' | 'top'> & Partial<Pick<DOMRect, 'bottom'>>, viewport: { width: number; height: number }, zoom = 1) {
  const width = Math.min(288, Math.max(0, (viewport.width - 16) / zoom))
  const above = Math.max(0, anchor.top - 14)
  const belowTop = Math.max(8, (anchor.bottom ?? anchor.top) + 6)
  const below = Math.max(0, viewport.height - belowTop - 8)
  const useAbove = above >= 160 * zoom || above >= below
  return {
    width,
    left: Math.max(8, Math.min(anchor.right - width * zoom, viewport.width - 8 - width * zoom)) / zoom,
    bottom: useAbove ? Math.max(8, Math.min(viewport.height - anchor.top + 6, viewport.height - 8)) / zoom : undefined,
    top: useAbove ? undefined : belowTop / zoom,
    maxHeight: Math.min(400, (useAbove ? above : below) / zoom),
  }
}

export function placeModelSubmenu(root: Pick<DOMRect, 'left' | 'right' | 'bottom'>, viewport: { width: number; height: number }, zoom = 1) {
  const width = Math.min(312, Math.max(0, (viewport.width - 16) / zoom))
  const visualWidth = width * zoom
  const rightFits = root.right + 2 * zoom + visualWidth <= viewport.width - 8
  const leftFits = root.left - 2 * zoom - visualWidth >= 8
  const side = rightFits ? 'right' : leftFits ? 'left' : root.left > viewport.width - root.right ? 'left' : 'right'
  const left = side === 'right' ? root.right + 2 * zoom : root.left - 2 * zoom - visualWidth
  return {
    width,
    left: Math.max(8, Math.min(left, viewport.width - 8 - visualWidth)) / zoom,
    bottom: Math.max(8, Math.min(viewport.height - root.bottom, viewport.height - 8)) / zoom,
    maxHeight: Math.min(440, Math.max(0, root.bottom - 8) / zoom),
    side,
  }
}

type Entry = { kind: 'model'; model: ReferenceModel } | { kind: 'provider'; provider: string; count: number } | { kind: 'more'; provider?: string }

/** UI-only menu: no Code IPC/store, so it can also be used by Chat without runtime coupling. */
export function ReferenceModelMenu({ models, current, recents, pending, loading, error, onRetry, anchorSelector, label, onPick, onClose }: {
  models: ReferenceModel[]
  current: string
  recents: readonly string[]
  pending: string | null
  loading: boolean
  error?: string | null
  onRetry?: () => void
  anchorSelector: string
  label: string
  onPick: (model: ReferenceModel) => void
  onClose: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const child = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const focusChild = useRef(false)
  const [placement, setPlacement] = useState<ReturnType<typeof placeModelMenus> | null>(null)
  const [childPlacement, setChildPlacement] = useState<ReturnType<typeof placeModelSubmenu> | null>(null)
  const [childOpen, setChildOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [searchLimit, setSearchLimit] = useState(PAGE)
  const [active, setActive] = useState(0)
  const quick = useMemo(() => quickModels(models, current, recents), [models, current, recents])
  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = models.filter((model) => `${model.name || ''} ${referenceModelKey(model)}`.toLowerCase().includes(needle))
    const grouped = new Map<string, ReferenceModel[]>()
    for (const model of needle ? filtered.slice(0, searchLimit) : filtered) {
      const rows = grouped.get(model.provider) ?? []
      rows.push(model)
      grouped.set(model.provider, rows)
    }
    const result: Entry[] = []
    for (const [provider, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
      result.push({ kind: 'provider', provider, count: rows.length })
      if (needle || expanded[provider]) {
        for (const model of needle ? rows : rows.slice(0, limits[provider] ?? PAGE)) result.push({ kind: 'model', model })
        if (!needle && rows.length > (limits[provider] ?? PAGE)) result.push({ kind: 'more', provider })
      }
    }
    if (needle && filtered.length > searchLimit) result.push({ kind: 'more' })
    return result
  }, [models, query, expanded, limits, searchLimit])

  const closeChild = () => { setChildOpen(false); more.current?.focus() }
  const restore = () => { (document.querySelector(anchorSelector) as HTMLElement | null)?.focus(); onClose() }
  const openChild = (focus = true) => {
    clearTimeout(hoverTimer.current)
    focusChild.current = focus
    setChildOpen(true)
    if (focus && childPlacement) requestAnimationFrame(() => search.current?.focus())
  }

  useLayoutEffect(() => {
    const place = () => {
      const anchor = document.querySelector(anchorSelector) ?? document.querySelector('[data-composer-shell]')
      const zoom = Number(document.documentElement.style.zoom) || 1
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      setPlacement(placeModelMenus(anchor?.getBoundingClientRect() ?? { right: viewport.width - 8, top: viewport.height - 80 }, viewport, zoom))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchorSelector])

  useLayoutEffect(() => {
    if (!childOpen || !root.current) return
    const zoom = Number(document.documentElement.style.zoom) || 1
    setChildPlacement(placeModelSubmenu(root.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, zoom))
  }, [childOpen, placement, quick.length])

  useEffect(() => {
    if (childOpen && childPlacement && focusChild.current) search.current?.focus()
  }, [childOpen, childPlacement])

  const placed = placement !== null
  useEffect(() => {
    if (placed) root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [placed])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      if (childOpen) closeChild()
      else restore()
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || root.current?.contains(target) || child.current?.contains(target)) return
      if (target instanceof Element && target.closest(anchorSelector)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  })
  useEffect(() => () => { clearTimeout(hoverTimer.current) }, [])
  useEffect(() => { child.current?.querySelector('[data-nav-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const choose = (model: ReferenceModel) => { if (!pending && model.available !== false) onPick(model) }
  const activate = (entry: Entry | undefined) => {
    if (!entry) return
    if (entry.kind === 'model') choose(entry.model)
    else if (entry.kind === 'provider') setExpanded((old) => ({ ...old, [entry.provider]: !old[entry.provider] }))
    else if (entry.provider) setLimits((old) => ({ ...old, [entry.provider!]: (old[entry.provider!] ?? PAGE) + PAGE }))
    else setSearchLimit((old) => old + PAGE)
  }
  const rootKeys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowRight') { event.preventDefault(); openChild(); return }
    if (event.key === 'Tab') { restore(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  const childKeys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowLeft' && (event.target !== search.current || !query || search.current.selectionStart === 0)) {
      event.preventDefault(); closeChild(); return
    }
    if (event.key === 'Tab') { event.preventDefault(); closeChild(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setActive((index) => event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % Math.max(1, entries.length))
    } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
      event.preventDefault()
      const entry = entries[active]
      if (event.key === 'Enter' || entry?.kind === 'provider' && !expanded[entry.provider]) activate(entry)
    }
  }
  const renderModel = (model: ReferenceModel, index?: number) => {
    const key = referenceModelKey(model)
    const selected = key === current || !model.provider && model.id === current
    return <button key={key} type="button" className="picker-row reference-model-row" aria-pressed={selected} disabled={pending !== null || model.available === false} aria-busy={pending === key} data-nav-active={index === undefined ? undefined : active === index} data-app-tooltip={key} aria-label={`${model.name || model.id} — ${model.provider}${selected ? ' (current)' : ''}`} onPointerMove={() => { if (index !== undefined) setActive(index) }} onClick={() => choose(model)}>
      <span className="reference-model-name">{model.name || model.id}</span>
      {pending === key ? <Loader2 className="animate-spin" size={16} /> : selected ? <Check size={16} className="reference-model-check" /> : null}
    </button>
  }

  if (!placement) return null
  return createPortal(<>
    <div ref={root} role="dialog" aria-label={label} className="composer-popover reference-model-menu" style={placement} onKeyDown={rootKeys}>
      {error && <div className="reference-model-error" role="status"><p>{error}</p>{onRetry && <button type="button" disabled={loading} onClick={onRetry}>{loading ? 'Retrying…' : 'Retry model loading'}</button>}</div>}
      <div className="reference-model-scroll">
        {quick.map((model) => renderModel(model))}
        {!error && !quick.length && <p className="reference-model-note" role="status">{loading ? 'Loading models…' : 'No models available'}</p>}
      </div>
      <button ref={more} type="button" className="reference-model-more reference-model-row" aria-haspopup="dialog" aria-expanded={childOpen} onClick={() => childOpen ? closeChild() : openChild()} onPointerEnter={() => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => openChild(false), 120) }} onPointerLeave={() => clearTimeout(hoverTimer.current)}>
        <span>More models</span><ChevronRight size={16} />
      </button>
    </div>
    {childOpen && childPlacement && <div ref={child} role="dialog" aria-label="All models" className="composer-popover reference-model-menu reference-model-submenu" data-side={childPlacement.side} style={childPlacement} onKeyDown={childKeys}>
      <label className="reference-model-search"><Search size={16} /><input ref={search} value={query} aria-label="Search models" placeholder="Search models…" onChange={(event) => { setQuery(event.target.value); setActive(0); setSearchLimit(PAGE) }} /></label>
      <div className="reference-model-scroll">
        {entries.map((entry, index) => entry.kind === 'model' ? renderModel(entry.model, index) : <button key={entry.kind === 'provider' ? entry.provider : `more-${entry.provider || 'search'}`} type="button" className={`reference-model-row ${entry.kind === 'provider' ? 'model-picker-provider-header' : 'reference-model-load-more'}`} data-nav-active={active === index} aria-expanded={entry.kind === 'provider' ? !!query || !!expanded[entry.provider] : undefined} onPointerMove={() => setActive(index)} onClick={() => activate(entry)}>
          {entry.kind === 'provider' ? <><ChevronRight size={14} data-open={!!query || !!expanded[entry.provider]} /><span className="reference-model-name">{entry.provider}</span><span className="reference-model-count">{entry.count}</span></> : 'Show more results'}
        </button>)}
        {!entries.length && <p className="reference-model-note" role="status">{error ? 'Model loading failed. Retry in the main menu.' : loading ? 'Loading models…' : 'No matching models'}</p>}
      </div>
    </div>}
  </>, document.body)
}
