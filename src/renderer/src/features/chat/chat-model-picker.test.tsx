import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatModelPicker, placeChatModelPicker } from './chat-model-picker'

const models = [
  { provider: 'provider-b', id: 'beta-id', name: 'Beta' },
  { provider: 'provider-a', id: 'alpha-id', name: 'Alpha' },
  { provider: 'provider-a', id: 'gamma-id', name: 'Gamma' },
]
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); document.documentElement.style.zoom = '' })

describe('Chat model popover', () => {
  it('uses a portaled, grouped listbox, real model data and selected check instead of a native select', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatModelPicker models={models} value="provider-b/beta-id" onChange={vi.fn()} />)
    expect(container.querySelector('select')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'New chat model' }))
    const dialog = screen.getByRole('dialog', { name: 'New chat model' })
    expect(container.contains(dialog)).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Search models' })).toHaveFocus()
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-labelledby'))).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: 'provider-a' })).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('option', { name: 'Beta beta-id' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Alphaalpha-id', 'Gammagamma-id', 'Betabeta-id'])
  })

  it('searches names, IDs and providers, including empty results', async () => {
    const user = userEvent.setup()
    render(<ChatModelPicker models={models} value="provider-b/beta-id" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'New chat model' }))
    const search = screen.getByRole('combobox')
    await user.type(search, 'provider-a')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await user.clear(search); await user.type(search, 'beta-id')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.clear(search); await user.type(search, 'nonexistent')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('status')).toHaveTextContent('No matching models')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('supports arrows, Home, End, Enter and restores chip focus on selection and Escape', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ChatModelPicker models={models} value="provider-b/beta-id" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'New chat model' })
    trigger.focus(); await user.keyboard('{ArrowDown}')
    const search = screen.getByRole('combobox')
    const active = () => document.getElementById(search.getAttribute('aria-activedescendant')!)?.textContent
    expect(active()).toBe('Betabeta-id')
    await user.keyboard('{Home}'); expect(active()).toBe('Alphaalpha-id')
    await user.keyboard('{ArrowDown}'); expect(active()).toBe('Gammagamma-id')
    await user.keyboard('{ArrowUp}'); expect(active()).toBe('Alphaalpha-id')
    await user.keyboard('{End}'); expect(active()).toBe('Betabeta-id')
    await user.keyboard('{Home}{Enter}')
    expect(onChange).toHaveBeenCalledWith('provider-a/alpha-id')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger); await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('allows Tab to leave the picker, Shift+Tab to go back, and click-away without stealing focus', async () => {
    const user = userEvent.setup()
    render(<><button>Before</button><ChatModelPicker models={models} value="provider-b/beta-id" onChange={vi.fn()} /><button>After</button></>)
    const trigger = screen.getByRole('button', { name: 'New chat model' })
    await user.click(trigger); await user.tab()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    await user.click(trigger); await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus()
    await user.click(trigger); await user.click(screen.getByRole('button', { name: 'After' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('selects a clicked option and disables with an accessible explanation when no models exist', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<ChatModelPicker models={models} value="provider-b/beta-id" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat model' }))
    fireEvent.click(screen.getByRole('option', { name: 'Gamma gamma-id' }))
    expect(onChange).toHaveBeenCalledWith('provider-a/gamma-id')
    rerender(<ChatModelPicker models={[]} value="" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'New chat model' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription('No models available. Configure host Pi models and sign-in first.')
  })

  it.each([0.8333333333333334, 1, 1.25])('anchors above the chip and clamps to the viewport at zoom %s', (zoom) => {
    const position = placeChatModelPicker({ right: 900, top: 600 }, { width: 1000, height: 800 }, zoom)
    expect((position.left + position.width) * zoom).toBeCloseTo(900)
    expect(800 - position.bottom * zoom).toBeCloseTo(592)
    expect(position.maxHeight).toBeLessThanOrEqual(360)
    const narrow = placeChatModelPicker({ right: 300, top: 200 }, { width: 320, height: 600 }, zoom)
    expect(narrow.left * zoom).toBeGreaterThanOrEqual(8)
    expect((narrow.left + narrow.width) * zoom).toBeLessThanOrEqual(312.001)
    expect(narrow.maxHeight * zoom).toBeLessThanOrEqual(184.001)
  })
})
