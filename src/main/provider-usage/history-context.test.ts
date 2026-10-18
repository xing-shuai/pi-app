// @vitest-environment node
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHistoryUsageService, recordedUsageModel, type UsageSdk } from './history-context'
import { createProviderUsageWorkerBridge } from './worker-bridge'
import { unavailableUsage } from './service'

const access = (account = 'fixture-account') => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`
const model = { provider: 'openai-codex', id: 'recorded-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' }
const header = { type: 'session', version: 3, id: 'history-id', cwd: '/work' }
const selected = { type: 'model_change', id: 'model', parentId: null, provider: model.provider, modelId: model.id }
const jsonl = (...entries: object[]) => [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'history-usage-'))
  vi.stubEnv('HOME', dir); vi.stubEnv('PI_CODING_AGENT_DIR', dir)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in fixture tests') }))
})
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const file = join(dir, 'history.jsonl')
  await writeFile(file, jsonl(selected))
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: access(), refresh: 'fixture-refresh', expires: Date.now() + 86400000 } }))
  await writeFile(join(dir, 'models.json'), '{}')
  const getAuth = vi.fn(async () => ({ auth: { apiKey: access() }, source: 'OAuth' }))
  const getModel = vi.fn((provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined)
  const create = vi.fn(async (_options: NonNullable<Parameters<UsageSdk['ModelRuntime']['create']>[0]>) => ({ getModel, getAuth, getError: () => undefined }))
  const sdk = { ModelRuntime: { create }, getAgentDir: () => dir, createAgentSession: vi.fn(), createAgentSessionRuntime: vi.fn(), SessionManager: { open: vi.fn(), create: vi.fn() } }
  const loadSdk = vi.fn(async () => sdk as unknown as UsageSdk)
  const authorize = vi.fn(async (cwd: string | undefined, requested: string | undefined) => cwd === '/work' && requested === file
    ? { ok: true as const, cwd, sessionFile: file } : { ok: false as const, error: 'denied' })
  const hasLiveSessionWorker = vi.fn(() => false)
  const getLeaf = vi.fn((): string | null | undefined => undefined)
  const fetchUsage = vi.fn(async () => new Response(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 31 } } })))
  const deps = { authorize, hasLiveSessionWorker, getLeaf, loadSdk, isWsl: vi.fn(() => false), fetch: fetchUsage }
  const service = createHistoryUsageService(deps)
  const getProviderUsage = vi.fn(async () => unavailableUsage('session-unavailable'))
  const bridge = createProviderUsageWorkerBridge({ ...deps, getProviderUsage, getHistoryUsage: (request, signal) => service.get(request, signal) })
  return { file, request: { workspaceId: '/work', sessionFile: file }, sdk, create, getAuth, getModel, fetchUsage, deps, service, bridge, getProviderUsage }
}

describe('reloaded local history account-only usage', () => {
  it('queries the exact recorded model on open/Refresh without worker/session creation, and retains account cache', async () => {
    const f = await fixture()
    expect(await f.bridge(f.request)).toMatchObject({ status: 'ready', model: 'recorded-codex', windows: [{ remainingPercent: 69 }] })
    expect(await f.bridge(f.request)).toMatchObject({ status: 'ready' })
    expect(f.fetchUsage).toHaveBeenCalledTimes(1)
    expect(await f.bridge({ ...f.request, force: true })).toMatchObject({ status: 'ready' })
    expect(f.fetchUsage).toHaveBeenCalledTimes(2)
    expect(f.getModel).toHaveBeenCalledWith('openai-codex', 'recorded-codex')
    expect(f.getProviderUsage).not.toHaveBeenCalled()
    expect(f.sdk.createAgentSession).not.toHaveBeenCalled(); expect(f.sdk.createAgentSessionRuntime).not.toHaveBeenCalled()
    expect(f.sdk.SessionManager.open).not.toHaveBeenCalled(); expect(f.sdk.SessionManager.create).not.toHaveBeenCalled()
    const options = f.create.mock.calls[0][0]
    expect(options).toMatchObject({ allowModelNetwork: false, refreshOnCreate: false, modelsPath: join(dir, 'models.json') })
    const refresh = vi.fn()
    expect(options.credentials).toBeDefined()
    await expect(options.credentials!.modify(model.provider, refresh)).rejects.toThrow()
    expect(refresh).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('always prefers a bound worker and never retries a racing/failed worker through detached auth', async () => {
    const f = await fixture()
    f.deps.hasLiveSessionWorker.mockReturnValue(true)
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'session-unavailable' })
    expect(f.getProviderUsage).toHaveBeenCalledWith(f.file, '/work', undefined)
    expect(f.deps.loadSdk).not.toHaveBeenCalled()
  })
  it('rejects unauthorized cwd/file before SDK/auth access', async () => {
    const f = await fixture()
    expect(await f.bridge({ ...f.request, workspaceId: '/other' })).toMatchObject({ reason: 'session-unavailable' })
    expect(await f.bridge({ ...f.request, sessionFile: join(dir, 'other.jsonl') })).toMatchObject({ reason: 'session-unavailable' })
    expect(f.deps.loadSdk).not.toHaveBeenCalled(); expect(f.fetchUsage).not.toHaveBeenCalled()
  })
  it.each(['ssh://host/work', 'wsl://Ubuntu/work', '//wsl$/Ubuntu/work'])('never resolves host accounts for %s', async (workspaceId) => {
    const f = await fixture()
    expect(await f.bridge({ ...f.request, workspaceId })).toMatchObject({ reason: 'remote-unsupported' })
    expect(f.deps.authorize).not.toHaveBeenCalled(); expect(f.deps.loadSdk).not.toHaveBeenCalled()
  })
  it('rejects local-looking paths while WSL is active', async () => {
    const f = await fixture(); f.deps.isWsl.mockReturnValue(true)
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'remote-unsupported' })
    expect(f.deps.loadSdk).not.toHaveBeenCalled()
  })
  it('uses the viewed branch rather than the last model on another branch', async () => {
    const f = await fixture()
    await writeFile(f.file, jsonl(selected, { type: 'model_change', id: 'other', parentId: null, provider: 'anthropic', modelId: 'other-account' }))
    f.deps.getLeaf.mockReturnValue('model')
    expect(await f.bridge(f.request)).toMatchObject({ status: 'ready', provider: model.provider })
    f.deps.getLeaf.mockReturnValue(undefined)
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'provider-unsupported' })
    expect(f.fetchUsage).toHaveBeenCalledTimes(1)
  })
  it('does not substitute default/available models for missing exact metadata or catalog identity', async () => {
    const f = await fixture()
    await writeFile(f.file, jsonl({ type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'hello' } }))
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'runtime-unavailable' })
    expect(f.deps.loadSdk).not.toHaveBeenCalled()
    await writeFile(f.file, jsonl({ ...selected, modelId: 'unknown-exact-model' }))
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'runtime-unavailable' })
    expect(f.getAuth).not.toHaveBeenCalled(); expect(f.fetchUsage).not.toHaveBeenCalled()
  })
  it('does not use another stored/default account when the exact provider credential is missing', async () => {
    const f = await fixture()
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: 'fixture-other-account' } }))
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'auth-unavailable' })
    expect(f.create).not.toHaveBeenCalled(); expect(f.fetchUsage).not.toHaveBeenCalled()
  })
  it('rejects changed history at the auth boundary before network, and changed branch/runtime after fetch', async () => {
    const f = await fixture()
    f.getAuth.mockImplementationOnce(async () => {
      await writeFile(f.file, jsonl({ ...selected, modelId: 'changed-model' }))
      return { auth: { apiKey: access() }, source: 'OAuth' }
    })
    expect((await f.bridge(f.request)).status).not.toBe('ready')
    expect(f.fetchUsage).not.toHaveBeenCalled()
    await writeFile(f.file, jsonl(selected))
    f.fetchUsage.mockImplementationOnce(async () => {
      f.deps.hasLiveSessionWorker.mockReturnValue(true)
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }))
    })
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'account-changed' })
  })
  it('drops old cache on credential changes and suppresses changed-account responses', async () => {
    const f = await fixture()
    expect((await f.bridge(f.request)).status).toBe('ready')
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: access('second-account'), refresh: 'refresh', expires: Date.now() + 86400000 } }))
    f.getAuth.mockResolvedValue({ auth: { apiKey: access('second-account') }, source: 'OAuth' })
    expect((await f.bridge(f.request)).status).toBe('ready')
    expect(f.fetchUsage).toHaveBeenCalledTimes(2)
    f.fetchUsage.mockImplementationOnce(async () => {
      await writeFile(join(dir, 'models.json'), '{"providers":{}}')
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }))
    })
    expect(await f.bridge({ ...f.request, force: true })).toMatchObject({ reason: 'account-changed' })
  })
  it('refuses expired OAuth and auth/config commands without executing callbacks or network', async () => {
    const f = await fixture()
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: access(), refresh: 'never-refresh', expires: 0 } }))
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'auth-unavailable' })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: '!forbidden-command' } }))
    expect(await f.bridge(f.request)).toMatchObject({ reason: 'auth-unavailable' })
    expect(f.create).not.toHaveBeenCalled(); expect(f.fetchUsage).not.toHaveBeenCalled()
  })
  it('cancels detached resolution before late auth/fetch after a bridge deadline', async () => {
    const f = await fixture()
    let release!: () => void
    f.deps.loadSdk.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(f.sdk as unknown as UsageSdk) }))
    const controller = new AbortController()
    const pending = f.service.get(f.request, controller.signal)
    // Wait for an actual resolution hook, not a clock or paid network.
    await vi.waitFor(() => expect(f.deps.loadSdk).toHaveBeenCalled())
    controller.abort(); release()
    expect(await pending).toMatchObject({ reason: 'timeout' })
    expect(f.create).not.toHaveBeenCalled(); expect(f.fetchUsage).not.toHaveBeenCalled()
  })
  it('real bundled SDK resolves the recorded custom Codex model with readonly fixture credentials and no session/discovery', async () => {
    const f = await fixture()
    const sdk = await import('@earendil-works/pi-coding-agent')
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { baseUrl: model.baseUrl, api: model.api, models: [{ id: model.id }] } } }))
    f.deps.loadSdk.mockResolvedValue({ ModelRuntime: sdk.ModelRuntime, getAgentDir: () => dir })
    const before = await readdir(dir)
    const authBefore = await readFile(join(dir, 'auth.json'), 'utf8')
    const sessionBefore = await readFile(f.file, 'utf8')
    const snapshot = await f.bridge(f.request)
    expect(snapshot).toMatchObject({ status: 'ready', provider: model.provider, model: model.id })
    expect(f.fetchUsage).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: `Bearer ${access()}`, 'ChatGPT-Account-Id': 'fixture-account' }) }))
    expect(await readdir(dir)).toEqual(before)
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(authBefore)
    expect(await readFile(f.file, 'utf8')).toBe(sessionBefore)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot)).not.toMatch(/fixture-account|signature|Authorization|apiKey/)
  }, 20000)
})

it('parses assistant-only recorded identities and fails closed on legacy, missing leaf and malformed models', () => {
  expect(recordedUsageModel(jsonl({ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-chat' } }), '/work', undefined)).toEqual({ provider: 'deepseek', id: 'deepseek-chat' })
  expect(() => recordedUsageModel(jsonl(selected), '/other', undefined)).toThrow()
  expect(() => recordedUsageModel(jsonl(selected), '/work', 'missing-leaf')).toThrow()
  expect(() => recordedUsageModel(jsonl(selected), '/work', null)).toThrow()
  expect(() => recordedUsageModel(jsonl({ ...selected, modelId: '' }), '/work', undefined)).toThrow()
  expect(() => recordedUsageModel(JSON.stringify({ ...header, version: 1 }), '/work', undefined)).toThrow()
})
