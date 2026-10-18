import { createHmac, randomBytes } from 'node:crypto'
import type { ProviderUsageRequest, ProviderUsageSnapshot, ProviderUsageReason } from '@shared/provider-usage-types'
import { normalizeCodex, normalizeDeepSeek, safeUsageText } from './normalizers'
import { isNonLocalUsageRequest, officialUsageOrigin, UsageFailure, validateUsageModel, type ResolveViewedUsageContext, type ViewedUsageContext } from './runtime'

type LocalContext = Extract<ViewedUsageContext, { kind: 'local' }>
const TTL = 45_000
const MAX = 32
const URLS = { 'openai-codex': 'https://chatgpt.com/backend-api/wham/usage', deepseek: 'https://api.deepseek.com/user/balance' }
export function unavailableUsage(reason: ProviderUsageReason, status: 'unavailable' | 'error' = 'unavailable'): ProviderUsageSnapshot {
  return { status, semantics: 'unavailable', displayLabel: 'Provider allowance / balance', windows: [], balances: [], stale: false, reason }
}

/** Explicit popup queries only. No timers, disk auth fallback, CLI/SSH, billing mutations,
 * extension registration, SDK startup imports, logging, or credential persistence. */
export class ProviderUsageService {
  private readonly salt = randomBytes(32)
  private readonly cache = new Map<string, { at: number; snapshot: ProviderUsageSnapshot }>()
  private readonly pending = new Map<string, Promise<ProviderUsageSnapshot>>()
  constructor(private readonly resolveViewed: ResolveViewedUsageContext, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async get(request: ProviderUsageRequest = {}, parentSignal?: AbortSignal): Promise<ProviderUsageSnapshot> {
    if (isNonLocalUsageRequest(request)) return unavailableUsage('remote-unsupported')
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (parentSignal?.aborted) abort()
    else parentSignal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    // A deadline also bounds runtime/auth resolution, even if an injected resolver ignores signal.
    try {
      return await Promise.race([
        this.query(request, controller.signal),
        new Promise<ProviderUsageSnapshot>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(unavailableUsage('timeout', 'error')) }, 8000)
        }),
      ])
    } catch (error) {
      // Never forward SDK/fetch/provider text: it may contain bearer, account IDs or URLs.
      const reason = controller.signal.aborted ? 'timeout' : error instanceof UsageFailure ? error.reason : 'request-failed'
      return unavailableUsage(reason, ['request-failed', 'invalid-response', 'timeout'].includes(reason) ? 'error' : 'unavailable')
    } finally { if (timer) clearTimeout(timer); parentSignal?.removeEventListener('abort', abort) }
  }
  private check(signal: AbortSignal): void { if (signal.aborted) throw new UsageFailure('timeout') }
  private async context(request: ProviderUsageRequest, signal: AbortSignal): Promise<LocalContext> {
    this.check(signal)
    const context = await this.resolveViewed(request, signal)
    this.check(signal)
    if (context.kind !== 'local') throw new UsageFailure(context.reason)
    validateUsageModel(context)
    return context
  }
  private identity(context: LocalContext): string {
    return JSON.stringify([context.runtimeId, context.viewKey, context.model.provider, context.model.id, context.model.baseUrl, context.model.api])
  }
  private async auth(context: LocalContext, signal: AbortSignal): Promise<{ fingerprint: string; headers: Record<string, string>; secrets: string[] }> {
    this.check(signal)
    const resolved = await context.runtime.getAuth(context.model, { signal })
    this.check(signal)
    if (!resolved) throw new UsageFailure('auth-unavailable')
    if (resolved.auth.baseUrl && !officialUsageOrigin(resolved.auth.baseUrl, context.model.provider)) throw new UsageFailure('proxy-unsupported')
    const entries = Object.entries(resolved.auth.headers ?? {})
    const authorization = entries.find(([name]) => name.toLowerCase() === 'authorization')?.[1]
    const token = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : resolved.auth.apiKey
    if (!token || /[\r\n]/.test(token)) throw new UsageFailure('auth-unavailable')
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    if (context.model.provider === 'openai-codex') {
      // SDK 1.0.2 resolves its standard stored OAuth credential with source="OAuth".
      // Derive the same account header as its inference adapter from that exact bearer,
      // not from another auth.json or a renderer-supplied account ID.
      if (resolved.source !== 'OAuth') throw new UsageFailure('oauth-required')
      let account: unknown
      try {
        if (token.length > 32_768) throw new Error()
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
        account = payload['https://api.openai.com/auth']?.chatgpt_account_id
      } catch { throw new UsageFailure('auth-unavailable') }
      if (typeof account !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(account)) throw new UsageFailure('auth-unavailable')
      const offeredAccount = entries.find(([name]) => name.toLowerCase() === 'chatgpt-account-id')?.[1]
      if (offeredAccount && offeredAccount !== account) throw new UsageFailure('account-changed')
      headers['ChatGPT-Account-Id'] = account
    }
    const fingerprint = createHmac('sha256', this.salt).update(JSON.stringify([this.identity(context), resolved, headers])).digest('hex')
    const secrets = [token, ...Object.values(headers), resolved.auth.apiKey, ...entries.map(([, value]) => value)].filter((v): v is string => !!v)
    return { fingerprint, headers, secrets }
  }
  private async guard(request: ProviderUsageRequest, original: LocalContext, fingerprint: string, signal: AbortSignal): Promise<void> {
    const current = await this.context(request, signal)
    if (this.identity(current) !== this.identity(original) || current.runtime !== original.runtime) throw new UsageFailure('account-changed')
    const auth = await this.auth(current, signal)
    const after = await this.context(request, signal)
    if (auth.fingerprint !== fingerprint || this.identity(after) !== this.identity(original) || after.runtime !== original.runtime) throw new UsageFailure('account-changed')
  }
  private async query(request: ProviderUsageRequest, signal: AbortSignal): Promise<ProviderUsageSnapshot> {
    const context = await this.context(request, signal)
    const auth = await this.auth(context, signal)
    await this.guard(request, context, auth.fingerprint, signal)
    this.check(signal)
    for (const [key, value] of this.cache) if (this.now() - value.at >= TTL) this.cache.delete(key)
    if (!request.force) {
      const cached = this.cache.get(auth.fingerprint)
      if (cached) return structuredClone(cached.snapshot)
    }
    const existing = this.pending.get(auth.fingerprint)
    if (existing) {
      const snapshot = await existing
      await this.guard(request, context, auth.fingerprint, signal)
      return structuredClone(snapshot)
    }
    if (this.pending.size >= MAX) throw new UsageFailure('busy')
    const operation = (async () => {
      // guard above is the last awaited operation before fetch; no user/provider choice here.
      this.check(signal)
      const response = await this.fetcher(URLS[context.model.provider as keyof typeof URLS], { method: 'GET', headers: auth.headers, redirect: 'error', signal })
      this.check(signal)
      if (response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel(); throw new UsageFailure('request-failed') }
      if (!response.ok) { void response.body?.cancel(); throw new UsageFailure(response.status === 401 || response.status === 403 ? 'auth-unavailable' : 'request-failed') }
      const payload = await readBoundedJson(response, signal)
      this.check(signal)
      await this.guard(request, context, auth.fingerprint, signal)
      const snapshot: ProviderUsageSnapshot = {
        status: 'ready', semantics: context.model.provider === 'openai-codex' ? 'subscription-allowance' : 'api-balance',
        provider: context.model.provider, model: safeUsageText(context.model.id, auth.secrets),
        displayLabel: context.model.provider === 'openai-codex' ? 'OpenAI Codex · subscription allowance' : 'DeepSeek · API balance',
        ...(context.model.provider === 'openai-codex' ? normalizeCodex(payload, auth.secrets) : normalizeDeepSeek(payload)),
        fetchedAt: new Date(this.now()).toISOString(), stale: false,
      }
      this.check(signal)
      while (this.cache.size >= MAX) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(auth.fingerprint, { at: this.now(), snapshot })
      return snapshot
    })()
    this.pending.set(auth.fingerprint, operation)
    const remove = () => { if (this.pending.get(auth.fingerprint) === operation) this.pending.delete(auth.fingerprint) }
    signal.addEventListener('abort', remove, { once: true })
    try { return structuredClone(await operation) }
    finally { remove(); signal.removeEventListener('abort', remove) }
  }
}
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 64 * 1024
  if (Number(response.headers.get('content-length')) > limit) { void response.body?.cancel(); throw new UsageFailure('invalid-response') }
  if (!response.body) throw new UsageFailure('invalid-response')
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) throw new UsageFailure('timeout')
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new UsageFailure('invalid-response') }
      chunks.push(value)
    }
    const body = Buffer.concat(chunks)
    try { return JSON.parse(body.toString('utf8')) } catch { throw new UsageFailure('invalid-response') }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
}
