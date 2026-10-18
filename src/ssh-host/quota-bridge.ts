import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { ProviderUsageReason, ProviderUsageSnapshot } from '../../packages/shared/provider-usage-types'
import { normalizeCodex, normalizeDeepSeek, UsageFailure } from './quota-normalizers'

export function unavailableRemoteQuota(reason: ProviderUsageReason): ProviderUsageSnapshot {
  return { status: 'unavailable', semantics: 'unavailable', displayLabel: 'Remote provider allowance / balance', windows: [], balances: [], stale: false, reason }
}

/** Dedicated inherited pipe, not RPC prompt/UI/tool traffic. Strict nonce + capability gate.
 * Never exposes a raw provider payload, credential, account identity or exception to the app. */
export class QuotaBridge {
  private ready = false
  private closed = false
  private tail = Buffer.alloc(0)
  private readonly readyWaiters = new Set<(ready: boolean) => void>()
  private pending?: { id: string; resolve: (value: ProviderUsageSnapshot) => void; timer: ReturnType<typeof setTimeout> }
  constructor(private readonly pipe: Duplex | undefined, private readonly nonce: string) {
    pipe?.on('data', (data: Buffer) => this.receive(data))
    pipe?.on('error', () => this.close())
    pipe?.on('close', () => this.close())
  }
  private receive(data: Buffer): void {
    if (this.closed) return
    this.tail = Buffer.concat([this.tail, data])
    if (this.tail.length > 16384) { this.close(); return }
    let at: number
    while ((at = this.tail.indexOf(10)) >= 0) {
      const line = this.tail.subarray(0, at); this.tail = this.tail.subarray(at + 1)
      try {
        const value = JSON.parse(line.toString('utf8'))
        if (value.nonce !== this.nonce) { this.close(); return }
        if (!this.ready) {
          if (value.type !== 'ready' || value.capability !== 'stored-provider-quota-v1') { this.close(); return }
          this.ready = true
          for (const done of this.readyWaiters) done(true)
          continue
        }
        if (!this.pending || value.id !== this.pending.id) continue
        let snapshot: ProviderUsageSnapshot
        if (value.reason) {
          const reasons: ProviderUsageReason[] = ['provider-unsupported', 'runtime-unavailable', 'remote-unsupported', 'remote-sdk-unsupported', 'remote-provider-config-unsupported', 'remote-session-untrusted', 'proxy-unsupported', 'auth-unavailable', 'oauth-required', 'account-changed', 'invalid-response', 'request-failed', 'timeout', 'busy', 'session-unavailable']
          snapshot = unavailableRemoteQuota(reasons.includes(value.reason) ? value.reason : 'request-failed')
        } else {
          if (!['openai-codex', 'deepseek'].includes(value.provider)) throw new UsageFailure('provider-unsupported')
          // Extension already projects away provider text; the existing bounded normalizers
          // validate percentages/decimal balances again on the helper boundary.
          const normalized = value.provider === 'openai-codex' ? normalizeCodex(value.payload) : normalizeDeepSeek(value.payload)
          snapshot = { status: 'ready', semantics: value.provider === 'openai-codex' ? 'subscription-allowance' : 'api-balance', provider: value.provider,
            displayLabel: value.provider === 'openai-codex' ? 'Remote OpenAI Codex · subscription allowance' : 'Remote DeepSeek · API balance',
            ...normalized, stale: false, fetchedAt: new Date().toISOString() }
        }
        this.finish(snapshot)
      } catch { this.finish(unavailableRemoteQuota('invalid-response')); this.close() }
    }
  }
  private waitForReady(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.closed || !this.pipe) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (ready: boolean) => { clearTimeout(timer); this.readyWaiters.delete(done); resolve(ready) }
      const timer = setTimeout(() => done(false), 500)
      this.readyWaiters.add(done)
    })
  }
  async query(sessionId: string, sessionFile: string): Promise<ProviderUsageSnapshot> {
    // stdout get_state and private FD3 can become readable in either order.
    if (!await this.waitForReady()) return unavailableRemoteQuota('remote-bridge-unavailable')
    if (this.pending) return unavailableRemoteQuota('busy')
    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => { this.finish(unavailableRemoteQuota('timeout')); this.close() }, 7500)
      this.pending = { id, resolve, timer }
      try { this.pipe!.write(JSON.stringify({ type: 'quota', nonce: this.nonce, id, sessionId, sessionFile }) + '\n') }
      catch { this.close() }
    })
  }
  private finish(snapshot: ProviderUsageSnapshot): void {
    if (this.pending) { const p = this.pending; this.pending = undefined; clearTimeout(p.timer); p.resolve(snapshot) }
  }
  close(): void { this.closed = true; this.ready = false; this.tail = Buffer.alloc(0); for (const done of this.readyWaiters) done(false); this.finish(unavailableRemoteQuota('runtime-unavailable')); this.pipe?.destroy() }
}
