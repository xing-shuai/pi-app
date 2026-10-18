import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThinkingPicker } from './thinking-picker'
import { applyThinkingLevel } from './thinking-level-actions'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc-client'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() }, onAppEvent: vi.fn(() => () => {}) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@renderer/lib/model-thinking-bindings', () => ({ boundThinkingLevelFor: () => undefined, loadModelThinkingBindings: () => Promise.resolve({}), subscribeModelThinkingBindings: () => () => {}, setModelThinkingBinding: vi.fn() }))
const invoke = vi.mocked(ipcClient.invoke)
beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (_method, request) => ({ level: (request as { level?: string }).level }))
  useUIStore.setState({ thinkingPickerOpen: true, historySessionFile: '/session.jsonl', runState: { ...useUIStore.getState().runState, model: 'provider/actual', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'] } })
})
const slider = () => screen.getByRole('slider', { name: 'Effort' })

describe('Code effort slider', () => {
  it('commits the effective accepted level, not the requested max, and ignores late replies for another view', async () => {
    invoke.mockResolvedValueOnce({ level: 'high' })
    await applyThinkingLevel('max')
    expect(useUIStore.getState().runState.thinkingLevel).toBe('high')
    let resolve!: (value: any) => void
    invoke.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = applyThinkingLevel('low')
    useUIStore.setState({ historySessionFile: '/other.jsonl', runState: { ...useUIStore.getState().runState, thinkingLevel: 'off' } })
    useUIStore.setState({ historySessionFile: '/session.jsonl' }) // Returning to the same identity does not revive an old request.
    resolve({ level: 'low' })
    await pending
    expect(useUIStore.getState().runState.thinkingLevel).toBe('off')
  })
  it('only commits supported levels, skips unsupported stops and locks pending requests', async () => {
    let resolve: () => void = () => {}
    invoke.mockImplementation((_method, request) => new Promise((done) => { resolve = () => done({ level: (request as { level?: string }).level }) }))
    render(<ThinkingPicker />)
    fireEvent.keyDown(slider(), { key: 'ArrowRight' })
    expect(invoke).toHaveBeenCalledWith('thinkingLevel.set', expect.objectContaining({ level: 'high', sessionFile: '/session.jsonl' }))
    expect(slider()).toHaveAttribute('aria-busy', 'true')
    fireEvent.keyDown(slider(), { key: 'Home' })
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => resolve())
    fireEvent.keyDown(slider(), { key: 'Home' })
    expect(invoke).toHaveBeenLastCalledWith('thinkingLevel.set', expect.objectContaining({ level: 'off' }))
    await act(async () => resolve())
    fireEvent.keyDown(slider(), { key: 'End' })
    expect(invoke).toHaveBeenLastCalledWith('thinkingLevel.set', expect.objectContaining({ level: 'high' }))
    await act(async () => resolve())
  })
  it('previews with pointer capture, commits once on release, cancels without committing', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    render(<ThinkingPicker />)
    const control = slider()
    const track = document.querySelector('.reference-effort-track')!
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 240 } as DOMRect)
    control.setPointerCapture = vi.fn()
    fireEvent.pointerDown(control, { button: 0, clientX: 240 })
    expect(control.setPointerCapture).toHaveBeenCalled()
    expect(control).toHaveAttribute('aria-valuetext', 'High')
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.pointerUp(control, { button: 0, clientX: 240 })
    expect(invoke).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(control).toHaveAttribute('aria-busy', 'false'))
    fireEvent.pointerDown(control, { button: 0, clientX: 0 })
    fireEvent.pointerCancel(control)
    fireEvent.pointerUp(control)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(control).toHaveAttribute('aria-valuetext', 'High')
    vi.unstubAllGlobals()
  })
  it('rolls back failed commits through the existing action', async () => {
    invoke.mockRejectedValue(new Error('rejected'))
    render(<ThinkingPicker />)
    fireEvent.keyDown(slider(), { key: 'End' })
    await waitFor(() => expect(useUIStore.getState().runState.thinkingLevel).toBe('low'))
    expect(slider()).toHaveAttribute('aria-valuetext', 'Low')
  })
  it('does not claim supported levels when capabilities are unknown', () => {
    useUIStore.setState({ runState: { ...useUIStore.getState().runState, availableThinkingLevels: undefined } })
    render(<ThinkingPicker />)
    expect(slider()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(slider(), { key: 'End' })
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.getByText('Model thinking capabilities have not loaded.')).toBeTruthy()
    expect(screen.queryByText('Recommended')).toBeNull()
  })
})
