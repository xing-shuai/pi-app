import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFilterMenu } from './session-filter-menu'
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.style.zoom = '' })
const options = [{ value: 'all', label: 'All sessions' }, { value: 'local', label: 'Local' }, { value: 'ssh', label: 'SSH' }]
it('supports roving focus, selection, Escape, and returning focus to the trigger', () => {
  const change = vi.fn()
  render(<SessionFilterMenu value="all" options={options} onChange={change} />)
  const trigger = screen.getByRole('button', { name: 'Filter sessions' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(screen.getByRole('menuitemradio', { name: 'All sessions' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(screen.getByRole('menuitemradio', { name: 'SSH' })).toHaveFocus()
  fireEvent.click(document.activeElement!)
  expect(change).toHaveBeenCalledWith('ssh'); expect(trigger).toHaveFocus()
  fireEvent.click(trigger); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull(); expect(trigger).toHaveFocus()
})
it('clamps to the zoomed viewport and dismisses on resize', () => {
  document.documentElement.style.zoom = String(5 / 6)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(990, 700, 120, 30))
  render(<SessionFilterMenu value="all" options={options} onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
  const menu = screen.getByRole('menu')
  expect(parseFloat(menu.style.left) * (5 / 6) + parseFloat(menu.style.width) * (5 / 6)).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(parseFloat(menu.style.top)).toBeGreaterThan(0)
  fireEvent.resize(window); expect(screen.queryByRole('menu')).toBeNull()
})
