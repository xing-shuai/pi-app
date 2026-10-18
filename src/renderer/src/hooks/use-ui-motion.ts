import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const UI_TRANSITION_MS = 160
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const readReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(REDUCED_MOTION)
    const change = () => setReduced(media.matches)
    change(); media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])
  return reduced
}

/** Keep only the outgoing pixels briefly, never its input/shortcut authority.
 * Callers must set inert/aria-hidden immediately from `visible`, not from `hidden`. */
export function useAnimatedVisibility(visible: boolean) {
  const reduced = useReducedMotion()
  const [retained, setRetained] = useState(visible)
  useLayoutEffect(() => {
    if (visible || reduced) { setRetained(visible); return }
    const timer = window.setTimeout(() => setRetained(false), UI_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [visible, reduced])
  return { hidden: !visible && (reduced || !retained), phase: visible ? 'enter' as const : 'exit' as const }
}

/** Session/tab fade without a React key, transform, layout shift or streaming replay. */
export function useSwapFade<T extends HTMLElement>(identity: string | null | undefined, disabled = false) {
  const ref = useRef<T>(null)
  const previous = useRef(identity)
  useLayoutEffect(() => {
    const changed = previous.current !== identity
    previous.current = identity
    const element = ref.current
    if (!changed || disabled || !element?.animate || readReducedMotion()) return
    const animation = element.animate([{ opacity: 0.72 }, { opacity: 1 }], { duration: UI_TRANSITION_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' })
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : undefined
    const stop = () => animation.cancel()
    media?.addEventListener?.('change', stop)
    return () => { media?.removeEventListener?.('change', stop); stop() }
  }, [identity, disabled])
  return ref
}
