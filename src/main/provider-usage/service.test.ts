// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderUsageService } from './service'
import type { UsageRuntime, ViewedUsageContext } from './runtime'

const token = (account = 'account-A') => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`
const codex = { plan_type: 'plus', rate_limit: { limit_reached: false, primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: { used_percent: 60, limit_window_seconds: 604800 } }, credits: { has_credits: true, unlimited: false, balance: '12.50' } }
const deepseek = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00000000000001', granted_balance: '10.00', topped_up_balance: '100.00000000000001' }, { currency: 'USD', total_balance: '20.00', granted_balance: '0.00', topped_up_balance: '20.00' }] }
function fixture(provider = 'openai-codex') {
  let credential = provider === 'deepseek' ? 'sk-test-deepseek-secret' : token()
  const runtime: UsageRuntime = { getAuth: vi.fn(async () => ({ auth: { apiKey: credential }, source: provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OAuth' })) }
  let context: ViewedUsageContext = { kind: 'local', viewKey: '/work/session', runtimeId: 'active-runtime-1', model: { provider, id: 'gpt-5.4', baseUrl: provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://chatgpt.com/backend-api', api: provider === 'deepseek' ? 'openai-completions' : 'openai-codex-responses' }, runtime }
  const resolve = vi.fn(async () => context)
  const fetch = vi.fn(async () => new Response(JSON.stringify(provider === 'deepseek' ? deepseek : codex)))
  let now = 1000
  const service = new ProviderUsageService(resolve, fetch, () => now)
  return { service, runtime, resolve, fetch, rotate: (value: string) => { credential = value }, setContext: (value: ViewedUsageContext) => { context = value }, context: () => context, advance: (ms: number) => { now += ms } }
}
afterEach(() => vi.useRealTimers())
describe('actual provider allowance queries', () => {
  it('queries Codex official OAuth with only bearer and derived account, normalizes real windows/credits', async () => {
    const f = fixture()
    const snapshot = await f.service.get({ sessionFile: '/work/session' })
    expect(snapshot).toMatchObject({ status: 'ready', semantics: 'subscription-allowance', plan: 'plus', credits: { amount: '12.50' }, exhausted: false, windows: [{ usedPercent: 25, remainingPercent: 75, windowSeconds: 18000, resetAt: '2027-01-15T08:00:00.000Z' }, { usedPercent: 60, remainingPercent: 40 }] })
    expect(f.fetch).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token()}`, 'ChatGPT-Account-Id': 'account-A', Accept: 'application/json' } }))
    expect(JSON.stringify(snapshot)).not.toContain(token())
    expect(JSON.stringify(snapshot)).not.toContain('account-A')
  })
  it('preserves exact DeepSeek currencies, never converts tokens/cost into balance', async () => {
    const f = fixture('deepseek')
    const snapshot = await f.service.get()
    expect(snapshot).toMatchObject({ status: 'ready', semantics: 'api-balance', apiAvailable: true, windows: [], balances: expect.arrayContaining([{ currency: 'CNY', kind: 'total', amount: '110.00000000000001' }, { currency: 'USD', kind: 'total', amount: '20.00' }]) })
    expect(f.fetch).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({ headers: { Authorization: 'Bearer sk-test-deepseek-secret', Accept: 'application/json' } }))
    expect(snapshot.plan).toBeUndefined()
  })
  it.each(['ssh://host/work', 'ssh:opaque', 'remote-code:work', 'wsl:Ubuntu', '//wsl.localhost/Ubuntu/home'])('never resolves local auth for remote %s', async (workspaceId) => {
    const f = fixture()
    expect(await f.service.get({ workspaceId })).toMatchObject({ reason: 'remote-unsupported' })
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('honors parent classification of opaque remote workspace and no SSH fallback', async () => {
    const f = fixture()
    f.setContext({ kind: 'unavailable', reason: 'remote-unsupported' })
    expect(await f.service.get({ workspaceId: 'opaque-id' })).toMatchObject({ reason: 'remote-unsupported' })
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each(['https://proxy.example/v1', 'https://chatgpt.com.evil.test', 'http://chatgpt.com', 'https://user@chatgpt.com/backend-api'])('rejects model origin %s before auth', async (baseUrl) => {
    const f = fixture()
    const context = f.context()
    if (context.kind !== 'local') throw new Error()
    f.setContext({ ...context, model: { ...context.model, baseUrl } })
    expect(await f.service.get()).toMatchObject({ reason: 'proxy-unsupported' })
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('rejects a custom API implementation for an otherwise supported official provider', async () => {
    const f = fixture()
    const context = f.context()
    if (context.kind !== 'local') throw new Error()
    f.setContext({ ...context, model: { ...context.model, api: 'openai-completions' } })
    expect(await f.service.get()).toMatchObject({ reason: 'provider-unsupported' })
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('rejects resolved auth override and registered provider override', async () => {
    const f = fixture()
    vi.mocked(f.runtime.getAuth).mockResolvedValue({ auth: { apiKey: token(), baseUrl: 'https://proxy.test' }, source: 'OAuth' })
    expect(await f.service.get()).toMatchObject({ reason: 'proxy-unsupported' })
    expect(f.fetch).not.toHaveBeenCalled()
    f.runtime.getProvider = () => ({ baseUrl: 'https://proxy.test' })
    expect(await f.service.get()).toMatchObject({ reason: 'proxy-unsupported' })
  })
  it('rejects API keys for Codex and unsupported xAI without auth/network', async () => {
    const f = fixture()
    vi.mocked(f.runtime.getAuth).mockResolvedValue({ auth: { apiKey: 'arbitrary-key' }, source: 'runtime' })
    expect(await f.service.get()).toMatchObject({ reason: 'oauth-required' })
    const xai = fixture('xai')
    expect(await xai.service.get()).toMatchObject({ reason: 'provider-unsupported' })
    expect(xai.runtime.getAuth).not.toHaveBeenCalled()
    expect(xai.fetch).not.toHaveBeenCalled()
  })
  it('coalesces concurrent queries, caches 45s, and refresh forces a new fetch', async () => {
    const f = fixture()
    await Promise.all([f.service.get(), f.service.get(), f.service.get()])
    expect(f.fetch).toHaveBeenCalledTimes(1)
    await f.service.get()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    await f.service.get({ force: true })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(45001)
    await f.service.get()
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
  it('separates rotated accounts and bounds cache to 32 salted entries, without raw bearer keys', async () => {
    const f = fixture()
    await f.service.get()
    f.rotate(token('account-B'))
    await f.service.get()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 35; i++) { f.rotate(token(`account-${i}`)); await f.service.get() }
    const cache = (f.service as unknown as { cache: Map<string, unknown> }).cache
    expect(cache.size).toBe(32)
    expect([...cache.keys()].every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true)
    expect(JSON.stringify([...cache])).not.toContain('signature')
  })
  it('discards a response after account, session, or model rotation', async () => {
    for (const change of ['account', 'session', 'model']) {
      const f = fixture()
      f.fetch.mockImplementationOnce(async () => {
        if (change === 'account') f.rotate(token('account-B'))
        else { const ctx = f.context(); if (ctx.kind === 'local') f.setContext({ ...ctx, viewKey: change === 'session' ? '/other' : ctx.viewKey, model: { ...ctx.model, id: change === 'model' ? 'other-model' : ctx.model.id } }) }
        return new Response(JSON.stringify(codex))
      })
      expect(await f.service.get()).toMatchObject({ reason: 'account-changed', windows: [] })
    }
  })
  it('revalidates runtime credentials before sending bearer', async () => {
    const f = fixture()
    vi.mocked(f.runtime.getAuth).mockImplementationOnce(async () => { f.rotate(token('account-B')); return { auth: { apiKey: token() }, source: 'OAuth' } })
    expect(await f.service.get()).toMatchObject({ reason: 'account-changed' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('refuses redirects and oversized/invalid responses without revealing any raw errors', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(new Response('secret', { status: 302, headers: { location: 'https://evil.test' } }))
    expect(await f.service.get()).toMatchObject({ status: 'error', reason: 'request-failed' })
    f.fetch.mockRejectedValueOnce(new Error(`Authorization: Bearer ${token()} sk-raw-secret`))
    const error = await f.service.get()
    expect(JSON.stringify(error)).not.toMatch(/signature|sk-raw-secret|Bearer/)
    f.fetch.mockResolvedValueOnce(new Response('x'.repeat(65537)))
    expect(await f.service.get()).toMatchObject({ reason: 'invalid-response' })
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ plan_type: token() })))
    expect(await f.service.get()).toMatchObject({ reason: 'invalid-response' })
  })
  it('redacts secrets even from provider-returned plan labels', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...codex, plan_type: token(), additional_rate_limits: [{ limit_name: token(), rate_limit: codex.rate_limit }] })))
    const snapshot = await f.service.get()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.plan).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('signature')
  })
  it('bounds even hung auth resolution to 8s; never sends late credentials', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<UsageRuntime['getAuth']>>) => void
    vi.mocked(f.runtime.getAuth).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.service.get()
    await vi.advanceTimersByTimeAsync(8000)
    expect(await pending).toMatchObject({ reason: 'timeout' })
    finish({ auth: { apiKey: token() }, source: 'OAuth' })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
