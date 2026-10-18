import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UI_TRANSITION_MS, useAnimatedVisibility, useSwapFade } from './use-ui-motion'

const originalMedia = window.matchMedia
const originalAnimate = HTMLElement.prototype.animate
let reduced = false
let listeners: Set<() => void>
const cancel = vi.fn()
const animate = vi.fn(() => ({ cancel }))
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); reduced = false; listeners = new Set()
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => ({ get matches() { return reduced }, addEventListener: (_event: string, callback: () => void) => listeners.add(callback), removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback) })) })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate })
})
afterEach(() => {
  cleanup(); vi.useRealTimers()
  window.matchMedia = originalMedia
  if (originalAnimate) HTMLElement.prototype.animate = originalAnimate
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})
it('retains only outgoing pixels for 160ms, then hides the old workspace', () => {
  const view = renderHook(({ visible }) => useAnimatedVisibility(visible), { initialProps: { visible: true } })
  view.rerender({ visible: false })
  expect(view.result.current).toEqual({ hidden: false, phase: 'exit' })
  act(() => vi.advanceTimersByTime(UI_TRANSITION_MS - 1)); expect(view.result.current.hidden).toBe(false)
  act(() => vi.advanceTimersByTime(1)); expect(view.result.current.hidden).toBe(true)
})
it('cancels a stale hide on rapid re-entry and disposes its timer', () => {
  const view = renderHook(({ visible }) => useAnimatedVisibility(visible), { initialProps: { visible: true } })
  view.rerender({ visible: false }); view.rerender({ visible: true })
  act(() => vi.advanceTimersByTime(UI_TRANSITION_MS * 2))
  expect(view.result.current).toEqual({ hidden: false, phase: 'enter' })
  view.rerender({ visible: false }); view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('hides immediately for reduced motion, including a preference change during exit', () => {
  const view = renderHook(({ visible }) => useAnimatedVisibility(visible), { initialProps: { visible: true } })
  view.rerender({ visible: false })
  act(() => { reduced = true; listeners.forEach((callback) => callback()) })
  expect(view.result.current.hidden).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
function Swap({ id, text = '' }: { id: string; text?: string }) { const ref = useSwapFade<HTMLDivElement>(id); return <div ref={ref} data-testid="surface">{text}</div> }
it('fades identities without remounting, moving layout, or replaying on streamed text', () => {
  const view = render(<Swap id="a" />), node = view.getByTestId('surface')
  expect(animate).not.toHaveBeenCalled()
  view.rerender(<Swap id="b" text="partial" />)
  expect(view.getByTestId('surface')).toBe(node)
  expect(animate).toHaveBeenCalledExactlyOnceWith([{ opacity: .72 }, { opacity: 1 }], expect.objectContaining({ duration: 160 }))
  view.rerender(<Swap id="b" text="partial text continues" />)
  expect(animate).toHaveBeenCalledOnce()
  view.unmount(); expect(cancel).toHaveBeenCalledOnce()
})
it('does not animate session switches under reduced motion', () => {
  reduced = true
  const view = render(<Swap id="a" />); view.rerender(<Swap id="b" />)
  expect(animate).not.toHaveBeenCalled()
})
