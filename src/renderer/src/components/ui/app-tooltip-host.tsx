import { useEffect, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const PAD = 8
const GAP = 8
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], .overlay-backdrop, .composer-popover'
let nextId = 0
let activeHide: (() => void) | undefined

/** Also cancels pending tooltips, including imperative composer chips. */
export function hideAllAppTooltips() { activeHide?.() }

/** Rects and viewport are browser CSS pixels; fixed offsets are unzoomed CSS units.
 * DPR must NOT be applied: getBoundingClientRect already accounts for CSS zoom. */
export function computeAppTooltipPosition(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  zoom = 1,
) {
  const z = zoom > 0 ? zoom : 1
  const pad = PAD * z
  const gap = GAP * z
  const left = Math.max(pad, Math.min((anchor.left + anchor.right - size.width) / 2, viewport.width - size.width - pad))
  const above = anchor.top - size.height - gap
  const top = Math.max(pad, Math.min(above >= pad ? above : anchor.bottom + gap, viewport.height - size.height - pad))
  return { left: left / z, top: top / z }
}

function uiZoom() {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).zoom)
  return Number.isFinite(value) && value > 0 ? value : 1
}

function intersects(a: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, b: DOMRect) {
  return b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Shared by React and imperative tooltips; measures only after text has rendered. */
export function placeAppTooltip(anchor: HTMLElement, bubble: HTMLElement): boolean {
  const zoom = uiZoom()
  bubble.style.maxWidth = `${Math.max(0, Math.min(320, window.innerWidth / zoom - PAD * 2))}px`
  bubble.style.maxHeight = `${Math.max(0, window.innerHeight / zoom - PAD * 2)}px`
  const size = bubble.getBoundingClientRect()
  const pos = computeAppTooltipPosition(anchor.getBoundingClientRect(), size, { width: window.innerWidth, height: window.innerHeight }, zoom)
  bubble.style.left = `${pos.left}px`
  bubble.style.top = `${pos.top}px`
  // Native WebContentsViews paint above the renderer, regardless of z-index.
  // Do not spoof dialog/menu roles to hide a native view for a passive tooltip.
  const rect = { left: pos.left * zoom, top: pos.top * zoom, right: pos.left * zoom + size.width, bottom: pos.top * zoom + size.height }
  const covered = [...document.querySelectorAll('[data-browser-viewport]')].some(view => intersects(rect, view.getBoundingClientRect()))
  bubble.style.visibility = covered ? 'hidden' : 'visible'
  return !covered
}

function addDescription(target: HTMLElement, id: string) {
  const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean))
  ids.add(id)
  target.setAttribute('aria-describedby', [...ids].join(' '))
  return () => {
    const remaining = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id)
    if (remaining.length) target.setAttribute('aria-describedby', remaining.join(' '))
    else target.removeAttribute('aria-describedby')
  }
}

function TooltipBubble({ anchor, content, id, hide }: { anchor: HTMLElement; content: string; id: string; hide: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const bubble = ref.current
    if (!bubble || !anchor.isConnected || !placeAppTooltip(anchor, bubble)) { hide(); return }
    const removeDescription = addDescription(anchor, id)
    const observer = new ResizeObserver(() => { if (!anchor.isConnected || !placeAppTooltip(anchor, bubble)) hide() })
    observer.observe(bubble)
    observer.observe(anchor)
    return () => { observer.disconnect(); removeDescription() }
  }, [anchor, content, id, hide])
  return <span ref={ref} id={id} role="tooltip" className="app-tooltip-bubble">{content}</span>
}

function visibleOverlays(): Element[] {
  return [...document.querySelectorAll(OVERLAYS)].filter(el => {
    const style = getComputedStyle(el)
    return !el.closest('[hidden], [aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden'
  })
}

function allowed(target: HTMLElement, overlays = visibleOverlays()) {
  if (!target.isConnected || target.closest('[inert], [data-tooltip-editing="true"]')) return false
  if (overlays.some(el => el.matches('[aria-modal="true"], [role="alertdialog"], .overlay-backdrop'))) return false
  if (overlays.length && !overlays.some(el => el.contains(target))) return false
  const editable = document.activeElement?.closest('[contenteditable="true"], textarea, input')
  return !editable || !editable.contains(target)
}

/** A binding owns no layout and never cancels or intercepts the application's events. */
export function createAppTooltipBinding(resolve: (event: Event) => { target: HTMLElement; content: string } | null, delayMs = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let target: HTMLElement | undefined
  let content = ''
  let container: HTMLDivElement | undefined
  let root: Root | undefined
  let observer: MutationObserver | undefined
  let overlays: Element[] = []
  let describedTarget: HTMLElement | undefined
  let tooltipId: string | undefined

  const hide = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    observer?.disconnect()
    observer = undefined
    // Remove accessibility relationship synchronously, before React's deferred teardown.
    if (describedTarget && tooltipId) {
      const ids = (describedTarget.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tooltipId)
      if (ids.length) describedTarget.setAttribute('aria-describedby', ids.join(' '))
      else describedTarget.removeAttribute('aria-describedby')
    }
    describedTarget = undefined
    tooltipId = undefined
    const oldRoot = root
    const oldContainer = container
    root = undefined
    container = undefined
    oldContainer?.remove()
    // May be called by the bubble's layout effect: don't unmount during a React commit.
    if (oldRoot) queueMicrotask(() => oldRoot.unmount())
    target = undefined
    content = ''
    if (activeHide === hide) activeHide = undefined
  }
  const enter = (event: Event, keyboard = false) => {
    const match = resolve(event)
    if (!match) { hide(); return }
    if (!match.content.trim()) { hideAllAppTooltips(); return }
    if (target === match.target && content === match.content && (!keyboard || timer === undefined)) return
    hideAllAppTooltips()
    if (!allowed(match.target)) return
    target = match.target
    content = match.content
    const explicitMarker = target.hasAttribute('data-app-tooltip')
    activeHide = hide
    overlays = visibleOverlays()
    observer = new MutationObserver(() => {
      if (!target || !allowed(target)) { hide(); return }
      const current = visibleOverlays()
      if (current.length !== overlays.length || current.some((el, i) => el !== overlays[i])) { hide(); return }
      if (explicitMarker && target.getAttribute('data-app-tooltip') !== content) hide()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-app-tooltip', 'role', 'aria-modal', 'hidden', 'aria-hidden', 'data-state', 'class', 'contenteditable', 'data-tooltip-editing'] })
    timer = setTimeout(() => {
      timer = undefined
      if (!target || !allowed(target)) { hide(); return }
      container = document.createElement('div')
      container.className = 'app-tooltip-portal'
      document.body.appendChild(container)
      root = createRoot(container)
      tooltipId = `app-tooltip-${++nextId}`
      describedTarget = target
      root.render(<TooltipBubble anchor={target} content={content} id={tooltipId} hide={hide} />)
    }, keyboard ? Math.min(80, delayMs) : delayMs)
  }
  const leave = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget
    if (target && related instanceof Node && target.contains(related)) {
      // Crossing into a nested explicit (including empty) marker must resolve afresh.
      if (related instanceof Element && related.closest('[data-app-tooltip]') !== target && target.hasAttribute('data-app-tooltip')) hide()
      return
    }
    hide()
  }
  return { enter, leave, hide }
}

/** Global dismissal also covers pending timers. Capture observes but never consumes events. */
export function bindAppTooltipDismissals(hide: () => void) {
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide() }
  const editing = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.closest('[contenteditable="true"], textarea, input')) hide()
  }
  document.addEventListener('focusin', editing, true)
  const events = ['pointerdown', 'click', 'scroll', 'input', 'beforeinput', 'compositionstart'] as const
  for (const event of events) document.addEventListener(event, hide, true)
  document.addEventListener('keydown', key, true)
  window.addEventListener('resize', hide)
  window.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
  return () => {
    for (const event of events) document.removeEventListener(event, hide, true)
    document.removeEventListener('keydown', key, true)
    document.removeEventListener('focusin', editing, true)
    window.removeEventListener('resize', hide)
    window.removeEventListener('scroll', hide, true)
    window.removeEventListener('blur', hide)
  }
}

/** Mount once at the application root; only explicit markers opt in. No title/label rewriting. */
export function AppTooltipHost({ delayMs = 500 }: { delayMs?: number }) {
  useEffect(() => {
    const binding = createAppTooltipBinding(event => {
      const origin = event.target instanceof Element ? event.target : null
      const target = origin?.closest<HTMLElement>('[data-app-tooltip]')
      return target ? { target, content: target.getAttribute('data-app-tooltip') || '' } : null
    }, delayMs)
    const pointer = (event: Event) => binding.enter(event)
    const focus = (event: Event) => binding.enter(event, true)
    document.addEventListener('pointerover', pointer, true)
    document.addEventListener('pointerout', binding.leave, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', binding.leave, true)
    const dismiss = bindAppTooltipDismissals(binding.hide)
    return () => {
      binding.hide()
      dismiss()
      document.removeEventListener('pointerover', pointer, true)
      document.removeEventListener('pointerout', binding.leave, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', binding.leave, true)
    }
  }, [delayMs])
  return null
}
