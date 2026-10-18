// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
const register = vi.hoisted(() => vi.fn())
vi.mock('../registry', () => ({ registerHandler: register }))
import { createProviderUsageHandler, registerProviderUsageHandlers } from './provider-usage'
import * as workerBridge from '../../provider-usage/worker-bridge'

describe('providerUsage IPC', () => {
  it('registers the literal endpoint without resolving auth or loading an SDK', () => {
    const resolveViewedContext = vi.fn()
    registerProviderUsageHandlers({ resolveViewedContext })
    expect(register).toHaveBeenCalledWith('ipc:providerUsage.get', expect.any(Function))
    expect(resolveViewedContext).not.toHaveBeenCalled()
  })
  it('wires no-argument production registration to the worker bridge', async () => {
    const snapshot = { status: 'unavailable' as const, semantics: 'unavailable' as const, displayLabel: 'Provider allowance / balance', windows: [], balances: [], stale: false, reason: 'provider-unsupported' as const }
    const query = vi.spyOn(workerBridge, 'getWorkerProviderUsage').mockResolvedValueOnce(snapshot)
    try {
      registerProviderUsageHandlers()
      const handler = register.mock.calls.at(-1)![1] as ReturnType<typeof createProviderUsageHandler>
      const request = { workspaceId: '/work', sessionFile: '/sessions/actual.jsonl', force: true }
      expect(await handler(request)).toBe(snapshot)
      expect(query).toHaveBeenCalledWith(request)
    } finally { query.mockRestore() }
  })
  it('has no default stored-account fallback', async () => {
    expect(await createProviderUsageHandler()({})).toMatchObject({ reason: 'runtime-unavailable' })
  })
  it.each([null, [], 'x', { provider: 'openai-codex' }, { apiKey: 'secret' }, { sessionFile: 5 }, { force: 'yes' }])('rejects renderer provider/auth and malformed input', async (request) => {
    const resolveViewedContext = vi.fn()
    expect(await createProviderUsageHandler({ resolveViewedContext })(request)).toMatchObject({ reason: 'invalid-request' })
    expect(resolveViewedContext).not.toHaveBeenCalled()
  })
  it('forwards only workspace/session/force to the authorized resolver and never falls back on remote error', async () => {
    const resolveViewedContext = vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'remote-unsupported' as const }))
    const handler = createProviderUsageHandler({ resolveViewedContext })
    expect(await handler({ workspaceId: 'virtual-123', sessionFile: '/session', force: true })).toMatchObject({ reason: 'remote-unsupported' })
    expect(resolveViewedContext).toHaveBeenCalledWith({ workspaceId: 'virtual-123', sessionFile: '/session', force: true }, expect.any(AbortSignal))
    expect(await handler({ workspaceId: 'ssh://host/work' })).toMatchObject({ reason: 'remote-unsupported' })
    expect(resolveViewedContext).toHaveBeenCalledTimes(1)
  })
})
