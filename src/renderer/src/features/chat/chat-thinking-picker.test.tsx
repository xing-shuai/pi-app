import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatThinkingPicker } from './chat-thinking-picker'

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)

describe('Chat thinking picker', () => {
  it('lists only model-supported levels, checks the effective selection and explains provider support', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatThinkingPicker value="high" levels={['off', 'low', 'high', 'xhigh']} provider="example" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Chat thinking intensity' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat thinking intensity' })
    expect(container.contains(dialog)).toBe(false)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Off', 'Low', 'High', 'Extra high'])
    expect(screen.getByRole('option', { name: 'High' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'High' })).toHaveFocus()
    expect(screen.queryByRole('option', { name: 'Max' })).not.toBeInTheDocument()
    expect(dialog).toHaveTextContent('example')
    expect(dialog).toHaveAccessibleDescription(/Only levels supported by Pi SDK/)
  })

  it('supports arrows, Home, End, Enter, Escape and focus restoration', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ChatThinkingPicker value="low" levels={['off', 'low', 'high']} onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Chat thinking intensity' })
    trigger.focus(); await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Low' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('option', { name: 'High' })).toHaveFocus()
    await user.keyboard('{Home}{ArrowDown}{ArrowUp}')
    expect(screen.getByRole('option', { name: 'Off' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('off')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(trigger); await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports click-away and Tab/Shift+Tab without trapping focus in the portal', async () => {
    const user = userEvent.setup()
    render(<><button>Before</button><ChatThinkingPicker value="off" levels={['off', 'high']} onChange={vi.fn()} /><button>After</button></>)
    const trigger = screen.getByRole('button', { name: 'Chat thinking intensity' })
    await user.click(trigger); await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(trigger); await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus()
    await user.click(trigger); await user.click(screen.getByRole('button', { name: 'After' }))
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows off-only models and explains restored requested/effective differences', async () => {
    const user = userEvent.setup()
    render(<ChatThinkingPicker value="off" requested="high" levels={['off']} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Chat thinking intensity' })
    expect(trigger).toHaveTextContent('Off')
    await user.click(trigger)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toHaveTextContent('no configurable reasoning')
    expect(screen.getByRole('dialog')).toHaveTextContent('Requested High; SDK restored Off.')
  })

  it('disables while busy and closes an already-open picker without submitting a change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<ChatThinkingPicker value="off" levels={['off', 'high']} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Chat thinking intensity' }))
    rerender(<ChatThinkingPicker value="off" levels={['off', 'high']} onChange={onChange} busy />)
    expect(screen.getByRole('button', { name: 'Chat thinking intensity' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Chat thinking intensity' })).toHaveAccessibleDescription(/while a response is running/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    rerender(<ChatThinkingPicker value="off" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Chat thinking intensity' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Chat thinking intensity' })).toHaveAccessibleDescription(/Load the conversation/)
  })
})
