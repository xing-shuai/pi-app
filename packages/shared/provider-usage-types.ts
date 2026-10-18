/** Pure transport DTOs. No SDK, credential, Electron, or renderer dependencies. */
export interface ProviderUsageRequest {
  workspaceId?: string
  sessionFile?: string
  force?: boolean
}
export type ProviderUsageReason =
  | 'remote-unsupported' | 'remote-bridge-unavailable' | 'remote-sdk-unsupported' | 'remote-provider-config-unsupported' | 'remote-session-untrusted' | 'runtime-unavailable' | 'session-unavailable'
  | 'provider-unsupported' | 'auth-unavailable' | 'oauth-required'
  | 'proxy-unsupported' | 'account-changed' | 'request-failed'
  | 'timeout' | 'invalid-response' | 'busy' | 'invalid-request'
export interface ProviderUsageWindow {
  id: string
  label: string
  usedPercent: number
  remainingPercent: number
  /** ISO timestamp, only when returned by the provider. */
  resetAt?: string
  windowSeconds?: number
}
export interface ProviderUsageBalance {
  currency: 'CNY' | 'USD'
  /** Exact decimal from the API, never converted through floating point. */
  amount: string
  kind: 'total' | 'granted' | 'topped-up' | 'rated-spend'
}
export interface ProviderUsageSnapshot {
  status: 'ready' | 'unavailable' | 'error'
  semantics: 'subscription-allowance' | 'api-balance' | 'rated-spend' | 'unavailable'
  provider?: string
  model?: string
  displayLabel: string
  plan?: string
  windows: ProviderUsageWindow[]
  balances: ProviderUsageBalance[]
  credits?: { available?: boolean; amount?: string; unlimited?: boolean }
  exhausted?: boolean
  apiAvailable?: boolean
  /** Query capture time; absent when no provider response was accepted. */
  fetchedAt?: string
  stale: boolean
  reason?: ProviderUsageReason
}
