import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReferenceAccountFooter } from './reference-sidebar'
import { ipcClient } from '@renderer/lib/ipc-client'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async () => ({ ok: true })) } }))
beforeEach(() => vi.clearAllMocks())

function open(props: Partial<React.ComponentProps<typeof ReferenceAccountFooter>> = {}) {
  const settings = vi.fn()
  render(<ReferenceAccountFooter name="Local user" onSettings={settings} onRoutines={vi.fn()} {...props} />)
  const trigger = screen.getByRole('button', { name: 'Account and settings' })
  trigger.focus()
  fireEvent.click(trigger)
  return { settings, trigger }
}

describe('local reference account menu', () => {
  it('shows the real desktop user, selected SSH location and working bottom-left shortcuts', () => {
    const settings = vi.fn(), usage = vi.fn(), routines = vi.fn()
    render(<ReferenceAccountFooter name="Actual OS user" environmentLabel="SSH · Fixture host" onSettings={settings} onUsage={usage} onRoutines={routines} />)
    expect(screen.getByText('Actual OS user')).toBeInTheDocument()
    expect(screen.getByText('SSH · Fixture host')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open usage overview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open routine manager' }))
    expect(settings).toHaveBeenCalledOnce(); expect(usage).toHaveBeenCalledOnce(); expect(routines).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Account and settings' }))
    expect(screen.getByRole('menu', { name: 'Account menu' })).toHaveTextContent('Provider sign-in belongs to the selected execution host')
    expect(screen.queryByText('Local profile')).toBeNull()
  })
  it('opens a real menu rather than immediately opening settings and returns focus on Escape', async () => {
    const { settings, trigger } = open()
    expect(settings).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Settings/ })).toHaveFocus()
    expect(screen.getByRole('menuitem', { name: 'Quit' })).toBeDisabled()
    expect(screen.queryByText(/Personal Pro|Team|Log out|@gmail/)).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it('routes settings, usage and API keys through callbacks and closes', () => {
    const usage = vi.fn(), models = vi.fn(), quit = vi.fn()
    const { settings, trigger } = open({ onUsage: usage, onModels: models, onQuit: quit })
    fireEvent.click(screen.getByRole('menuitem', { name: /Settings/ }))
    expect(settings).toHaveBeenCalledOnce()
    for (const [label, callback] of [['Usage', usage], ['API keys', models], ['Quit', quit]] as const) {
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
      expect(callback).toHaveBeenCalledOnce()
      expect(screen.queryByRole('menu')).toBeNull()
    }
  })

  it('offers a keyboard-operable language submenu without closing the parent on its first Escape', () => {
    const language = vi.fn()
    open({ onLanguage: language })
    const button = screen.getByRole('menuitem', { name: 'Language' })
    button.focus()
    fireEvent.keyDown(button, { key: 'ArrowRight' })
    expect(screen.getByRole('menuitemradio', { name: 'English' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Language' })).toBeNull()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '简体中文' }))
    expect(language).toHaveBeenCalledWith('zh')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('uses safe external IPC for help and changelog, and closes on click-away', () => {
    const { trigger } = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Get help' }))
    expect(ipcClient.invoke).toHaveBeenCalledWith('shell.openExternal', { url: 'https://github.com/justhil/pi-app/blob/main/doc/guide/getting-started.md' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'View changelog' }))
    expect(ipcClient.invoke).toHaveBeenCalledWith('shell.openExternal', { url: 'https://github.com/justhil/pi-app/releases' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('toggles off using the footer and emits the shared usage event without a callback', () => {
    const listener = vi.fn()
    window.addEventListener('pi-desktop:open-usage-settings', listener)
    const { trigger } = open()
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Usage' }))
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('pi-desktop:open-usage-settings', listener)
  })
})
