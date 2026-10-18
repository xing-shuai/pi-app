import { expect, it, vi } from 'vitest'
import type { EventBus } from '@earendil-works/pi-coding-agent'
import { createDesktopUIBridge } from './desktop-ui-bridge'

it('cancels the optional agent-name wizard without emitting a modal or approving anything', async () => {
  const emit = vi.fn(), bus = { on: () => () => {} } as unknown as EventBus
  const bridge = createDesktopUIBridge(bus, emit)
  const input = bridge.uiContext.input as (title: string, value?: unknown) => Promise<string | undefined>
  expect(await input('Agent name: (default: video_3d)', { defaultValue: 'video_3d' })).toBeUndefined()
  expect(emit).not.toHaveBeenCalled()
  const confirm = bridge.uiContext.confirm as (title: string, message: string) => Promise<boolean>
  const pending = confirm('Allow command?', 'Changes files')
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ method: 'confirm', title: 'Allow command?' }))
  bridge.handleExtensionUIResponse({ id: emit.mock.calls[0][0].id, confirmed: false })
  expect(await pending).toBe(false)
  bridge.dispose()
})
it('normalizes ordinary legacy input defaults instead of rendering [object Object]', async () => {
  const emit = vi.fn(), bus = { on: () => () => {} } as unknown as EventBus
  const bridge = createDesktopUIBridge(bus, emit)
  const input = bridge.uiContext.input as (title: string, value?: unknown) => Promise<string | undefined>
  const pending = input('Branch?', { defaultValue: 'main' })
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ method: 'input', defaultValue: 'main' }))
  expect(emit.mock.calls[0][0].placeholder).toBeUndefined()
  bridge.handleExtensionUIResponse({ id: emit.mock.calls[0][0].id, value: 'main' })
  expect(await pending).toBe('main'); bridge.dispose()
})

it('should_reject_unknown_custom_tui_when_no_interaction_protocol_is_declared', async () => {
  const emit = vi.fn()
  const bus = { on: () => () => {} } as unknown as EventBus
  const bridge = createDesktopUIBridge(bus, emit)
  const custom = bridge.uiContext.custom as (factory: unknown) => Promise<unknown>
  const pending = custom(() => ({}))
  const result = await Promise.race([pending.then(() => 'resolved', (error: Error) => error.message), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 10))])
  bridge.dispose()
  expect(result).toBe('UNSUPPORTED_DESKTOP_UI: custom TUI requires an adapter interaction protocol')
  expect(emit).not.toHaveBeenCalled()
})
