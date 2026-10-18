import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerMetrics } from './use-composer-metrics'
import { applyComposerDisplayMeta } from '@renderer/lib/session-display-meta'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc-client'
import { lookupContextWindow } from '@renderer/lib/model-context-window'

const remote = '/__pi_ssh__/synthetic/root/project'
const file = remote + '/.sessions/saved.jsonl'
const mocks = vi.hoisted(() => ({ preview: null as any }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() }, onAppEvent: vi.fn(() => () => {}) }))
vi.mock('@renderer/lib/model-context-window', () => ({ lookupContextWindow: vi.fn() }))
vi.mock('@renderer/features/context/use-session-context-preview', () => ({ useSessionContextPreview: () => ({ preview: mocks.preview, loading: false }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
beforeEach(() => {
  vi.mocked(ipcClient.invoke).mockReset()
  vi.mocked(lookupContextWindow).mockReset()
  useUIStore.setState({ currentWorkspace: remote, historySessionFile: file, historyLoading: false, runState: { ...useUIStore.getState().runState, model: 'local/stale', thinkingLevel: 'max', availableThinkingLevels: undefined, usage: undefined } })
  mocks.preview = { sessionId: 'saved', sessionFile: file, messageCount: 1, estimatedChars: 400, roleBreakdown: [], remoteContext: { model: 'deepseek/exact', contextUsage: { tokens: 12000, contextWindow: 64000 }, usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.01 } } }
})
describe('restored remote composer facts', () => {
  it('keeps an empty remote draft unknown without dereferencing a missing preview/model', () => {
    mocks.preview = null
    useUIStore.getState().setRunState({ model: undefined })
    const { result } = renderHook(() => useComposerMetrics())
    expect(result.current.estContextTokens).toBeNull()
    expect(result.current.contextWindow).toBeNull()
    expect(lookupContextWindow).not.toHaveBeenCalled()
  })
  it('loads remote draft Effort metadata without binding the previously selected history', async () => {
    useUIStore.setState({ historySessionFile: null })
    vi.mocked(ipcClient.invoke).mockResolvedValue({ state: { bound: false, sessionFile: null, sessionId: null, model: 'deepseek/exact', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'] } })
    await applyComposerDisplayMeta()
    expect(ipcClient.invoke).toHaveBeenCalledWith('ipc:runtime.getState', { workspaceId: remote, draft: true })
    expect(useUIStore.getState().runState).toMatchObject({ model: 'deepseek/exact', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'] })
    expect(useUIStore.getState().historySessionFile).toBeNull()
    expect(useUIStore.getState().runState.usage).toBeUndefined()
  })
  it('hydrates real capabilities/usage for the viewed history and selects its exact context instead of a local catalog', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue({ state: { sessionFile: file, model: 'deepseek/exact', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'], usage: mocks.preview.remoteContext.usage } })
    await applyComposerDisplayMeta()
    expect(ipcClient.invoke).toHaveBeenCalledWith('ipc:runtime.getState', { sessionFile: file })
    expect(useUIStore.getState().runState).toMatchObject({ model: 'deepseek/exact', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'], usage: { input: 10 } })
    const { result } = renderHook(() => useComposerMetrics())
    await waitFor(() => expect(result.current.estContextTokens).toBe(12000))
    expect(result.current.contextWindow).toBe(64000)
    expect(lookupContextWindow).not.toHaveBeenCalled()
    act(() => useUIStore.getState().setRunState({ model: 'other/provider' }))
    expect(result.current.estContextTokens).toBeNull()
    expect(result.current.contextWindow).toBeNull()
  })
  it('keeps post-compaction unknown context unknown and discards late metadata on a different view', async () => {
    mocks.preview.remoteContext.contextUsage.tokens = null
    useUIStore.getState().setRunState({ model: 'deepseek/exact' })
    const { result } = renderHook(() => useComposerMetrics())
    expect(result.current.estContextTokens).toBeNull()
    let resolve!: (value: any) => void
    vi.mocked(ipcClient.invoke).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = applyComposerDisplayMeta()
    act(() => useUIStore.setState({ historySessionFile: remote + '/.sessions/other.jsonl', runState: { ...useUIStore.getState().runState, model: 'deepseek/other', availableThinkingLevels: ['off'] } }))
    resolve({ state: { sessionFile: file, model: 'deepseek/exact', thinkingLevel: 'high', availableThinkingLevels: ['off', 'high'] } })
    await pending
    expect(useUIStore.getState().runState).toMatchObject({ model: 'deepseek/other', availableThinkingLevels: ['off'] })
  })
})
