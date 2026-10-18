// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProviderUsageWorkerBridge } from './worker-bridge'
import { createWorkerProviderUsageService, handleGetProviderUsage } from '../../worker/handlers/worker-handlers-provider-usage'
import { st } from '../../worker/worker-runtime'

vi.mock('../../worker/worker-runtime', () => ({ st: { session: null, modelRuntime: null, runtime: null, currentCwd: '/work' } }))
const file = '/sessions/native.jsonl'
const request = { workspaceId: '/work', sessionFile: file }
const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`
function bind() {
  const model = { id: 'native-selected-codex', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' }
  const getAuth = vi.fn(async () => ({ auth: { apiKey: access }, source: 'OAuth' }))
  st.session = { sessionFile: file, model } as never
  st.modelRuntime = { getAuth } as never
  return { model, getAuth }
}
function setup(fetcher = vi.fn(async () => new Response(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 } } })))) {
  const service = createWorkerProviderUsageService(fetcher)
  const authorize = vi.fn(async () => ({ ok: true as const, sessionFile: file, cwd: '/work' }))
  const getProviderUsage = vi.fn((sessionFile: string, cwd: string, force?: boolean) => service.get({ sessionFile, workspaceId: cwd, force }))
  const isWsl = vi.fn(() => false)
  return { fetcher, service, authorize, getProviderUsage, isWsl, bridge: createProviderUsageWorkerBridge({ authorize, getProviderUsage, isWsl }) }
}
beforeEach(() => { st.session = null; st.modelRuntime = null; st.runtime = null; st.currentCwd = '/work' })

describe('authorized existing-worker provider usage', () => {
  it('uses the actual selected native session model and SDK getAuth, transports only a snapshot', async () => {
    const { model, getAuth } = bind()
    const { bridge, fetcher, getProviderUsage } = setup()
    const snapshot = await bridge({ ...request, force: true })
    expect(snapshot).toMatchObject({ status: 'ready', model: model.id, plan: 'plus', windows: [{ usedPercent: 23, remainingPercent: 77 }] })
    expect(getProviderUsage).toHaveBeenCalledWith(file, '/work', true)
    expect(getAuth).toHaveBeenCalledWith(model, { signal: expect.any(AbortSignal) })
    expect(fetcher).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': 'synthetic-account' } }))
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-account|signature|Authorization|headers|apiKey/)
    expect(st.currentCwd).toBe('/work')
    expect(st.session?.model).toBe(model)
  })
  it.each(['ssh://host/work', 'remote:opaque', 'wsl://Ubuntu/work', '\\\\wsl.localhost\\Ubuntu\\work', '//wsl$/Ubuntu/work'])('rejects %s before authorization or runtime access', async (workspaceId) => {
    const { getAuth } = bind()
    const { bridge, authorize, getProviderUsage } = setup()
    expect(await bridge({ ...request, workspaceId })).toMatchObject({ reason: 'remote-unsupported' })
    expect(authorize).not.toHaveBeenCalled(); expect(getProviderUsage).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled()
  })
  it('rejects WSL mode before authorization, and fails closed on denied authorization', async () => {
    const { getAuth } = bind()
    const s = setup()
    s.isWsl.mockReturnValue(true)
    expect(await s.bridge(request)).toMatchObject({ reason: 'remote-unsupported' })
    expect(s.authorize).not.toHaveBeenCalled()
    s.isWsl.mockReturnValue(false)
    s.authorize.mockResolvedValue({ ok: false, error: 'untrusted' } as never)
    expect(await s.bridge(request)).toMatchObject({ reason: 'session-unavailable' })
    expect(s.getProviderUsage).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled()
  })
  it('has no fallback for absent, unknown or mismatched sessions/runtimes', async () => {
    const { getAuth } = bind()
    const s = setup()
    expect(await s.bridge({})).toMatchObject({ reason: 'runtime-unavailable' })
    expect(s.authorize).not.toHaveBeenCalled()
    expect(await s.service.get({ ...request, sessionFile: '/unknown' })).toMatchObject({ reason: 'session-unavailable' })
    expect(await s.service.get({ ...request, workspaceId: '/other' })).toMatchObject({ reason: 'session-unavailable' })
    st.modelRuntime = {} as never
    expect(await s.bridge(request)).toMatchObject({ reason: 'runtime-unavailable' })
    expect(getAuth).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled()
  })
  it('rejects changed model/runtime at the network boundary and after fetch', async () => {
    const { model, getAuth } = bind()
    const s = setup()
    getAuth.mockImplementationOnce(async () => { model.id = 'rotated'; return { auth: { apiKey: access }, source: 'OAuth' } })
    expect(await s.bridge(request)).toMatchObject({ reason: 'account-changed' })
    expect(s.fetcher).not.toHaveBeenCalled()
    s.fetcher.mockImplementationOnce(async () => { bind(); return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } })) })
    expect(await s.bridge(request)).toMatchObject({ reason: 'account-changed' })
  })
  it('ignores old cache after worker/runtime restart, even with the same account/model', async () => {
    bind()
    const s = setup()
    expect((await s.bridge(request)).status).toBe('ready')
    expect((await s.bridge(request)).status).toBe('ready')
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    bind()
    expect((await s.bridge(request)).status).toBe('ready')
    expect(s.fetcher).toHaveBeenCalledTimes(2)
  })
  it('bounds authorization too, with no late worker dispatch after expiry', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      let authorize!: (value: { ok: true; sessionFile: string; cwd: string }) => void
      s.authorize.mockImplementationOnce(() => new Promise((resolve) => { authorize = resolve }))
      const pending = s.bridge(request)
      await vi.advanceTimersByTimeAsync(8000)
      expect(await pending).toMatchObject({ status: 'error', reason: 'timeout' })
      authorize({ ok: true, sessionFile: file, cwd: '/work' })
      await Promise.resolve()
      expect(s.getProviderUsage).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('production worker handler returns typed unsupported without auth or SDK startup', async () => {
    const { model, getAuth } = bind()
    model.provider = 'unsupported-provider'
    const reply = vi.fn()
    await handleGetProviderUsage({ type: 'getProviderUsage', sessionFile: file, cwd: '/work' }, reply)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'getProviderUsage-done', snapshot: expect.objectContaining({ reason: 'provider-unsupported' }) }))
    expect(getAuth).not.toHaveBeenCalled()
  })
  it('redacts runtime failures and validates worker request keys', async () => {
    const { getAuth } = bind()
    const s = setup()
    getAuth.mockRejectedValue(new Error(`secret ${access}`))
    expect(await s.bridge(request)).toMatchObject({ status: 'error', reason: 'request-failed' })
    const reply = vi.fn()
    await handleGetProviderUsage({ type: 'getProviderUsage', sessionFile: file, cwd: '/work', apiKey: access }, reply)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'getProviderUsage-done', snapshot: expect.objectContaining({ reason: 'invalid-request' }) }))
    expect(JSON.stringify(reply.mock.calls)).not.toContain(access)
  })
})
