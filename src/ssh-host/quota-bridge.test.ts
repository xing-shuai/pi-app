// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { QUOTA_EXTENSION_SOURCE } from './quota-extension-source'
import { QuotaBridge } from './quota-bridge'

const roots: string[] = []
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
const nonce = 'a'.repeat(64)
async function extension(provider = 'deepseek') {
  const home = await mkdtemp(join(tmpdir(), 'remote-quota-')); roots.push(home)
  const agent = join(home, 'agent'); await mkdir(agent)
  const authPath = join(agent, 'auth.json'), modelsPath = join(agent, 'models.json')
  const token = provider === 'deepseek' ? 'synthetic-remote-only-key' : 'header.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'remote-account' } })).toString('base64url') + '.signature'
  await writeFile(authPath, JSON.stringify({ [provider]: provider === 'deepseek' ? { type: 'api_key', key: token } : { type: 'oauth', access: token, refresh: 'synthetic-refresh', expires: Date.now() + 3600000 } }), { mode: 0o600 })
  const responses: any[] = [], waiters: ((v: any) => void)[] = []
  let socket!: FakeSocket
  class FakeSocket extends EventEmitter {
    destroyed = false; writableLength = 0
    constructor() { super(); socket = this }
    write(line: string) { const value = JSON.parse(line); responses.push(value); waiters.shift()?.(value); return true }
    destroy() { this.destroyed = true }
  }
  const handlers = new Map<string, (...args: any[]) => void>()
  const fetcher = vi.fn(async () => new Response(JSON.stringify(provider === 'deepseek' ? { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.30', granted_balance: '2.00', topped_up_balance: '10.30' }] } : { plan_type: token, rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 1800000000 } }, account_id: 'remote-account', access_token: token }), { status: 200 }))
  const api = { on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn) }
  const registry = { getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined, getProviderAuthStatus: () => ({ source: 'stored' }), getProvider: () => undefined, isUsingOAuth: () => provider === 'openai-codex', getProviderAuth: vi.fn(() => { throw new Error('unsafe auth resolution must never run') }), getApiKeyAndHeaders: vi.fn(() => { throw new Error('unsafe command resolution must never run') }) }
  const ctx = { mode: 'rpc', isProjectTrusted: () => true, model: { provider, id: 'exact', api: provider === 'deepseek' ? 'openai-completions' : 'openai-codex-responses', baseUrl: provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://chatgpt.com/backend-api' }, modelRegistry: registry, sessionManager: { getSessionId: () => 'saved', getSessionFile: () => '/remote/saved.jsonl' } }
  const source = QUOTA_EXTENSION_SOURCE.replace(/^import .*;\n/gm, '').replace('export default ', '').replace('await import(pathToFileURL(configPath).href)', 'await loadRemoteConfig()')
  const sdkRoot = join(home, 'remote-sdk'), cli = join(sdkRoot, 'dist/bundle/cli.js')
  await mkdir(dirname(cli), { recursive: true })
  const sdkPackage = { name: '@earendil-works/pi-coding-agent', main: './dist/index.js', bin: { pi: 'dist/bundle/cli.js' } }
  await writeFile(join(sdkRoot, 'package.json'), JSON.stringify(sdkPackage))
  const opened = vi.fn(open)
  const factory = runInNewContext('(' + source + ')', { Socket: FakeSocket, open: opened, constants, join, dirname, resolve, isAbsolute,
    realpath: async (path: string) => path,
    loadRemoteConfig: async () => ({ getAgentDir: () => agent, ENV_AGENT_DIR: 'PI_CODING_AGENT_DIR' }),
    Buffer, URL, AbortSignal, setTimeout, clearTimeout, fetch: fetcher, process: { argv: ['node', cli], env: { PI_DESKTOP_QUOTA_NONCE: nonce, PI_CODING_AGENT_DIR: agent }, getuid: () => process.getuid!() } })
  factory(api)
  expect(fetcher).not.toHaveBeenCalled() // Factory is inert.
  handlers.get('session_start')!({}, ctx)
  const query = () => {
    const result = new Promise<any>(done => waiters.push(done))
    socket.emit('data', Buffer.from(JSON.stringify({ type: 'quota', nonce, id: '12345678-1234-1234-1234-123456789abc', sessionId: 'saved', sessionFile: '/remote/saved.jsonl' }) + '\n'))
    return result
  }
  return { query, socket, responses, fetcher, registry, ctx, token, authPath, modelsPath, handlers, opened, mismatchSdk: async () => writeFile(join(sdkRoot, 'package.json'), JSON.stringify({ ...sdkPackage, name: 'another-sdk' })) }
}
class Pipe extends Duplex {
  writes: any[] = []
  _read() {}
  _write(chunk: Buffer, _encoding: string, done: (e?: Error) => void) { this.writes.push(JSON.parse(chunk.toString())); done() }
  reply(value: unknown) { this.push(Buffer.from(JSON.stringify(value) + '\n')) }
}

describe('remote quota capability bridge', () => {
  it('distinguishes a missing private handshake without sending any RPC or account query', async () => {
    vi.useFakeTimers()
    const pipe = new Pipe(), bridge = new QuotaBridge(pipe, nonce)
    try {
      const pending = bridge.query('saved', '/remote/saved.jsonl')
      await vi.advanceTimersByTimeAsync(501)
      expect((await pending).reason).toBe('remote-bridge-unavailable')
      expect(pipe.writes).toEqual([])
    } finally { bridge.close(); vi.useRealTimers() }
  })
  it('requires a nonce/capability handshake and emits only normalized numeric account DTOs', async () => {
    const pipe = new Pipe(), bridge = new QuotaBridge(pipe, nonce)
    const pending = bridge.query('saved', '/remote/saved.jsonl')
    expect(pipe.writes).toEqual([])
    pipe.reply({ nonce, type: 'ready', capability: 'stored-provider-quota-v1' })
    await new Promise<void>(done => setImmediate(done))
    expect(pipe.writes[0]).toMatchObject({ type: 'quota', sessionId: 'saved', sessionFile: '/remote/saved.jsonl' })
    pipe.reply({ nonce, id: pipe.writes[0].id, provider: 'openai-codex', payload: { rate_limit: { primary_window: { used_percent: 25 } } } })
    expect(await pending).toMatchObject({ status: 'ready', semantics: 'subscription-allowance', windows: [{ remainingPercent: 75 }] })
    bridge.close()
    const badPipe = new Pipe(), bad = new QuotaBridge(badPipe, nonce)
    badPipe.reply({ nonce: 'wrong', type: 'ready', capability: 'stored-provider-quota-v1' })
    await new Promise<void>(done => setImmediate(done))
    expect((await bad.query('saved', '/remote/saved.jsonl')).status).toBe('unavailable')
    expect(badPipe.writes).toEqual([])
  })
  it.each(['deepseek', 'openai-codex'])('queries %s inside the trusted remote Pi only, never resolves commands or returns credentials', async provider => {
    const f = await extension(provider)
    expect(f.responses[0]).toMatchObject({ nonce, capability: 'stored-provider-quota-v1' })
    expect(f.fetcher).not.toHaveBeenCalled() // session_start only announces capability.
    const dto = await f.query()
    expect(dto.provider).toBe(provider)
    expect(dto.payload).toBeTruthy()
    const [url, options] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(provider === 'deepseek' ? 'https://api.deepseek.com/user/balance' : 'https://chatgpt.com/backend-api/wham/usage')
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + f.token } })
    expect(JSON.stringify(dto)).not.toContain(f.token)
    expect(JSON.stringify(dto)).not.toContain('remote-account')
    expect(f.registry.getProviderAuth).not.toHaveBeenCalled()
    expect(f.registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
    f.handlers.get('session_shutdown')!()
  })
  it('does not borrow a default account or another SDK when the running CLI cannot identify its own SDK', async () => {
    const f = await extension()
    await f.mismatchSdk()
    expect((await f.query()).reason).toBe('remote-sdk-unsupported')
    expect(f.opened.mock.calls.some(([path]) => String(path) === f.authPath || String(path) === f.modelsPath)).toBe(false)
    expect(f.fetcher).not.toHaveBeenCalled()
    f.handlers.get('session_shutdown')!()
  })
  it.each(['deepseek', 'openai-codex'])('accepts safe custom %s model metadata on the same official stored account', async provider => {
    const f = await extension(provider)
    const config = { baseUrl: f.ctx.model.baseUrl, api: f.ctx.model.api, models: [{ id: 'exact', name: 'Custom model label', reasoning: true, contextWindow: 1000000, maxTokens: 32000, thinkingLevelMap: { low: 'low', high: 'high' } }], compat: { supportsDeveloperRole: false } }
    await writeFile(f.modelsPath, JSON.stringify({ providers: { [provider]: config } }))
    Reflect.set(f.registry, 'getRegisteredProviderConfig', () => config)
    expect((await f.query()).provider).toBe(provider)
    expect(f.fetcher).toHaveBeenCalledOnce()
    expect(f.registry.getProviderAuth).not.toHaveBeenCalled()
    expect(f.registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
    f.handlers.get('session_shutdown')!()
  })
  it('rejects credential/header/transport overlays and native implementations without sending HTTP', async () => {
    const f = await extension()
    for (const config of [{ apiKey: 'another-account' }, { headers: { Authorization: 'another-account' } }, { models: [{ id: 'exact', headers: { 'ChatGPT-Account-Id': 'other' } }] }, { baseUrl: 'https://proxy.invalid' }]) {
      await writeFile(f.modelsPath, JSON.stringify({ providers: { deepseek: config } }))
      expect((await f.query()).reason).toBe('remote-provider-config-unsupported')
    }
    await writeFile(f.modelsPath, '{}')
    Reflect.set(f.registry, 'getRegisteredNativeProvider', () => ({ streamSimple: () => {} }))
    expect((await f.query()).reason).toBe('remote-provider-config-unsupported')
    expect(f.fetcher).not.toHaveBeenCalled()
    f.handlers.get('session_shutdown')!()
  })
  it('rejects command credentials, configured/native providers, proxies and unavailable registry capabilities without HTTP', async () => {
    const f = await extension()
    await writeFile(f.authPath, JSON.stringify({ deepseek: { type: 'api_key', key: '!never-run-this' } }))
    expect((await f.query()).reason).toBe('auth-unavailable')
    await writeFile(f.modelsPath, JSON.stringify({ providers: { deepseek: { apiKey: '!never-run-this' } } }))
    expect((await f.query()).reason).toBe('remote-provider-config-unsupported')
    await writeFile(f.modelsPath, '{}')
    f.ctx.model.baseUrl = 'https://proxy.invalid'
    expect((await f.query()).reason).toBe('proxy-unsupported')
    f.ctx.model.baseUrl = 'https://api.deepseek.com'
    f.registry.getRegisteredNativeProvider = undefined as any
    expect((await f.query()).reason).toBe('remote-sdk-unsupported')
    expect(f.fetcher).not.toHaveBeenCalled()
    f.handlers.get('session_shutdown')!()
  })
  it('drops results after remote account/session changes and bounds provider response size', async () => {
    const f = await extension()
    f.fetcher.mockImplementationOnce(async () => { await writeFile(f.authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'different-account-key' } })); return new Response('{}') })
    expect((await f.query()).reason).toBe('account-changed')
    f.fetcher.mockImplementationOnce(async () => new Response('x'.repeat(65537)))
    expect((await f.query()).reason).toBe('invalid-response')
    f.ctx.sessionManager.getSessionId = () => 'changed-session'
    expect((await f.query()).reason).toBe('session-unavailable')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    f.handlers.get('session_shutdown')!()
  })
})
