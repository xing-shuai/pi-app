import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityInfo } from '@shared/capabilities'
import { ipcClient } from '@renderer/lib/ipc-client'
import { capabilityKey, useSessionCapabilitiesStore } from '@renderer/lib/session-capabilities'
import { useUIStore } from '@renderer/stores/ui-store'
import i18n from '@renderer/lib/i18n'
import { ComposerToolsMenu } from './composer-tools-menu'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))
const catalog: CapabilityInfo[] = [
  { id: 'pi-ui', available: true, promptTokens: 2300, tools: 0 },
  { id: 'browser', available: true, promptTokens: 1200, tools: 12, coreTools: 3 },
  { id: 'chrome', available: false, reason: 'chrome-off', promptTokens: 1400, tools: 15 },
]
const invoke = vi.mocked(ipcClient.invoke)
beforeEach(async () => {
  await i18n.changeLanguage('en')
  invoke.mockReset().mockImplementation(async (method) => {
    if (method === 'capabilities.catalog') return { capabilities: catalog }
    if (method === 'pi.settings.get') return { settings: { cacheWarming: 'idle' } }
    return { ok: true, settings: {} }
  })
  useUIStore.setState({ historySessionFile: '/a.jsonl' })
  useSessionCapabilitiesStore.setState({ loaded: true, byKey: {} })
})
async function open(props: { disabled?: boolean; running?: boolean } = {}) {
  render(<ComposerToolsMenu {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
  await screen.findByRole('switch', { name: 'pi-ui visuals' })
  return screen.getByRole('dialog', { name: 'On for this chat' })
}

describe('compact composer capabilities', () => {
  it('preserves the actual per-session switch, token cost and browser mutual exclusion', async () => {
    await open({ running: true })
    expect(screen.getByText('~2.3k more tokens per request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'pi-ui visuals' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).toEqual(['pi-ui'])
    expect(invoke).toHaveBeenCalledWith('settings.set', { key: 'sessionCapabilities', value: { '/a.jsonl': ['pi-ui'] } })
    const browser = within(screen.getByRole('radiogroup', { name: 'Browser' }))
    fireEvent.click(browser.getByRole('radio', { name: 'Built-in' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).toEqual(['pi-ui', 'browser'])
    expect(screen.getByText('12 tools (3 always loaded, rest on demand) · ~1.2k more tokens per request')).toBeInTheDocument()
    expect(browser.getByRole('radio', { name: 'My Chrome' })).toBeDisabled()
    fireEvent.click(browser.getByRole('radio', { name: 'My Chrome' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).not.toContain('chrome')
    fireEvent.click(browser.getByRole('radio', { name: 'Off' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).toEqual(['pi-ui'])
    expect(screen.queryByText(/current turn is unaffected/)).not.toBeVisible()
    fireEvent.click(screen.getAllByText('More info').at(-1)!)
    expect(screen.getByText(/current turn is unaffected/)).toBeVisible()
    expect(invoke.mock.calls.every(([method]) => !/approval|permission/.test(method))).toBe(true)
  })

  it('uses the existing settings dispatch for setup, retains the disabled reason without native titles', async () => {
    const listener = vi.fn()
    window.addEventListener('pi-desktop:open-capability-settings', listener)
    const dialog = await open()
    expect(dialog.querySelector('[title]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('data-app-tooltip', 'Tools')
    const browser = within(screen.getByRole('radiogroup', { name: 'Browser' }))
    expect(browser.getByRole('radio', { name: 'My Chrome' })).toHaveAttribute('data-app-tooltip', 'Turn on My Chrome in Settings → Browser and pair the extension first')
    fireEvent.click(screen.getByRole('button', { name: 'Settings…' }))
    expect(listener).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('pi.settings.set', expect.anything())
    window.removeEventListener('pi-desktop:open-capability-settings', listener)
  })

  it('writes the global cache setting, locks pending updates, and rolls back failures', async () => {
    await open()
    const group = within(screen.getByRole('radiogroup', { name: 'Cache warming' }))
    await waitFor(() => expect(group.getByRole('radio', { name: 'Also idle' })).toHaveAttribute('aria-checked', 'true'))
    let finish!: (value: { ok: boolean }) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(group.getByRole('radio', { name: 'Off' }))
    expect(invoke).toHaveBeenLastCalledWith('pi.settings.set', { patch: { cacheWarming: 'off' } })
    expect(group.getByRole('radio', { name: 'Running' })).toBeDisabled()
    const calls = invoke.mock.calls.length
    fireEvent.click(group.getByRole('radio', { name: 'Running' }))
    expect(invoke).toHaveBeenCalledTimes(calls)
    await act(async () => finish({ ok: false }))
    expect(group.getByRole('radio', { name: 'Also idle' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/Could not update cache warming/)).toBeInTheDocument()
    expect(useSessionCapabilitiesStore.getState().byKey).toEqual({})
  })

  it('does not enable missing Chrome, refreshes preferences on open and ignores closed catalog requests', async () => {
    let oldResolve!: (value: { capabilities: CapabilityInfo[] }) => void
    invoke.mockImplementation(async (method) => {
      if (method === 'capabilities.catalog') return new Promise((resolve) => { oldResolve = resolve })
      return { settings: {} }
    })
    render(<ComposerToolsMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(screen.getByText('Loading capabilities…')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    invoke.mockImplementation(async (method) => method === 'capabilities.catalog' ? { capabilities: [catalog[0], { ...catalog[1], available: false, reason: 'browser-panel-off' }] } : { settings: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    await screen.findByRole('switch', { name: 'pi-ui visuals' })
    await act(async () => oldResolve({ capabilities: catalog }))
    expect(screen.getByRole('radio', { name: 'Built-in' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'My Chrome' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([method]) => method === 'capabilities.catalog')).toHaveLength(2)
  })

  it('keeps supported Chrome and built-in modes mutually exclusive without enabling unavailable visuals', async () => {
    invoke.mockImplementation(async (method) => method === 'capabilities.catalog' ? { capabilities: [{ ...catalog[0], available: false }, catalog[1], { ...catalog[2], available: true, reason: undefined }] } : { settings: { cacheWarming: 'streaming' } })
    await open()
    const visuals = screen.getByRole('switch', { name: 'pi-ui visuals' })
    expect(visuals).toBeDisabled()
    fireEvent.click(visuals)
    expect(useSessionCapabilitiesStore.getState().byKey).toEqual({})
    fireEvent.click(screen.getByRole('radio', { name: 'My Chrome' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).toEqual(['chrome'])
    expect(screen.getByText('15 tools · ~1.4k more tokens per request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Built-in' }))
    expect(useSessionCapabilitiesStore.getState().byKey[capabilityKey('/a.jsonl')]).toEqual(['browser'])
    expect(screen.getByRole('radio', { name: 'My Chrome' })).toHaveAttribute('aria-checked', 'false')
  })

  it('does not claim a selected global cache mode after a failed settings read and can retry', async () => {
    invoke.mockImplementation(async (method) => {
      if (method === 'capabilities.catalog') return { capabilities: catalog }
      if (method === 'pi.settings.get') throw new Error('unavailable')
      return { settings: {} }
    })
    await open()
    await screen.findByText(/Could not update cache warming/)
    const group = within(screen.getByRole('radiogroup', { name: 'Cache warming' }))
    expect(group.getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false' && radio.hasAttribute('disabled'))).toBe(true)
    invoke.mockResolvedValue({ settings: { cacheWarming: 'off' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(group.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true'))
  })

  it('keeps sessions independent and the disabled composer trigger locked', async () => {
    const { rerender } = render(<ComposerToolsMenu disabled />)
    const trigger = screen.getByRole('button', { name: 'Tools' })
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<ComposerToolsMenu />)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('switch', { name: 'pi-ui visuals' }))
    act(() => useUIStore.setState({ historySessionFile: '/b.jsonl' }))
    expect(screen.getByRole('switch', { name: 'pi-ui visuals' })).not.toBeChecked()
    act(() => useUIStore.setState({ historySessionFile: '/a.jsonl' }))
    expect(screen.getByRole('switch', { name: 'pi-ui visuals' })).toBeChecked()
  })
})
