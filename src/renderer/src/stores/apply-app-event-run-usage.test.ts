import { beforeEach, expect, it, vi } from 'vitest'
import { useUIStore } from './ui-store'
import { handleRun } from './apply-app-event-run'
import type { RunEvent, StoreApi } from './apply-app-event-types'
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({ reconcileAllStaleInteractiveToolRows: vi.fn() }))
const workspaceId = '/__pi_ssh__/host/hash/project', sessionFile = workspaceId + '/.sessions/test.jsonl'
const usage = { input: 120, output: 24, cacheRead: 8, cacheWrite: 4, cost: 0.00372 }
const api: StoreApi = { get: useUIStore.getState, set: useUIStore.setState, nextItemId: () => 'test' }
beforeEach(() => { useUIStore.setState({ currentWorkspace: workspaceId, currentSessionId: 'test', historySessionFile: sessionFile, optimisticPendingUserText: null, agentTurnBootstrapping: false, runState: { status: 'idle', toolCount: 0, errorCount: 0 } }) })
it.each(['started', 'running', 'idle'] as const)('retains actual usage on %s events despite lifecycle early returns', (phase) => {
  const event: RunEvent = { type: 'run', phase, seq: 1, workspaceId, sessionFile, runId: 'test-run', timestamp: Date.now(), usage, toolStats: { total: 3, running: 0, failed: 1 } }
  expect(handleRun(event, api)).toBe(true)
  expect(useUIStore.getState().runState).toMatchObject({ usage, toolCount: 3, errorCount: 1 })
})
it('does not apply another session usage through the visible running route', () => {
  handleRun({ type: 'run', phase: 'running', seq: 1, timestamp: Date.now(), workspaceId, sessionFile: sessionFile + '-other', usage }, api)
  expect(useUIStore.getState().runState.usage).toBeUndefined()
})
