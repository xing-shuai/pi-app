import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import {
  bindAppTooltipDismissals,
  createAppTooltipBinding,
  hideAllAppTooltips,
} from '@renderer/components/ui/app-tooltip-host'

export function hideAllDelayedTooltips() { hideAllAppTooltips() }

/** Keeps the existing inline-flex wrapper geometry; the bubble lives in document.body. */
export function DelayedTooltip({
  content,
  children,
  delayMs = 500,
  className,
}: {
  content: string
  children: ReactNode
  delayMs?: number
  className?: string
}) {
  const hostRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (hostRef.current) return wireDelayedTooltip(hostRef.current, content, delayMs)
    return undefined
  }, [content, delayMs])
  return <span ref={hostRef} className={cn('delayed-tooltip-host inline-flex max-w-full', className)}>{children}</span>
}

/** Returns an optional disposer; existing callers may continue ignoring the return value.
 * Removal of the chip OR any containing editor disposes every handler and observer. */
export function wireDelayedTooltip(el: HTMLElement, content: string, delayMs = 500) {
  if (!content.trim()) return undefined
  const binding = createAppTooltipBinding(event => {
    const origin = event.target instanceof Element ? event.target : el
    const explicit = origin.closest('[data-app-tooltip]')
    // An explicit descendant marker (even empty) takes precedence over the chip.
    if (explicit && el.contains(explicit)) return null
    const target = event.type === 'focusin' && origin instanceof HTMLElement ? origin : el
    return { target, content }
  }, delayMs)
  const pointer = (event: Event) => binding.enter(event)
  const focus = (event: Event) => binding.enter(event, true)
  el.addEventListener('pointerover', pointer)
  el.addEventListener('pointerout', binding.leave)
  el.addEventListener('mouseenter', pointer)
  el.addEventListener('mouseleave', binding.leave)
  el.addEventListener('focusin', focus)
  el.addEventListener('focusout', binding.leave)
  const dismiss = bindAppTooltipDismissals(binding.hide)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    binding.hide()
    dismiss()
    observer.disconnect()
    el.removeEventListener('pointerover', pointer)
    el.removeEventListener('pointerout', binding.leave)
    el.removeEventListener('mouseenter', pointer)
    el.removeEventListener('mouseleave', binding.leave)
    el.removeEventListener('focusin', focus)
    el.removeEventListener('focusout', binding.leave)
  }
  const observer = new MutationObserver(() => { if (!el.isConnected) dispose() })
  observer.observe(document.body, { childList: true, subtree: true })
  return dispose
}
