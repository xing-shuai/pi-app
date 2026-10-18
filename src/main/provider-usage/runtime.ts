import type { ProviderUsageRequest, ProviderUsageReason } from '@shared/provider-usage-types'

export interface UsageModel {
  id: string
  provider: string
  baseUrl: string
  api?: string
}
export interface UsageAuthResult {
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
  source?: string
}
/** Structural subset of SDK 1.0.2 ModelRuntime; no eager SDK imports. */
export interface UsageRuntime {
  getAuth(model: UsageModel, options: { signal: AbortSignal }): Promise<UsageAuthResult | undefined>
  getProvider?(provider: string): { baseUrl?: string } | undefined
}
export type ViewedUsageContext =
  | { kind: 'unavailable'; reason: ProviderUsageReason }
  | {
    kind: 'local'
    /** Identity/epoch of the ACTUAL viewed session's runtime and account owner. */
    runtimeId: string
    /** Canonical authorized workspace/session identity, not renderer-supplied provider. */
    viewKey: string
    model: UsageModel
    runtime: UsageRuntime
  }
/** Must authorize the requested workspace/session and reject SSH/WSL/virtual contexts.
 * Prefer the existing bound runtime. Detached histories may use a quiet readonly
 * account-only ModelRuntime for the exact recorded model, never a default session.
 * Called before auth, at the network boundary, and after the response. Do not launch tools.
 * A worker implementation may instead host ProviderUsageService inside the worker and
 * transport only its DTO; never transport UsageAuthResult to a renderer.
 */
export type ResolveViewedUsageContext = (
  request: ProviderUsageRequest, signal: AbortSignal,
) => Promise<ViewedUsageContext>

export class UsageFailure extends Error {
  constructor(readonly reason: ProviderUsageReason) { super(reason) }
}
export function isNonLocalUsageRequest(request: ProviderUsageRequest): boolean {
  // Defense in depth. Parent must also classify workspace IDs that are opaque/virtual.
  return [request.workspaceId, request.sessionFile].some((value) =>
    !!value && (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)
      || /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]/i.test(value)))
}

export function officialUsageOrigin(value: string, provider: string): boolean {
  try {
    const url = new URL(value)
    const origin = provider === 'openai-codex' ? 'https://chatgpt.com' : 'https://api.deepseek.com'
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function validateUsageModel(context: Extract<ViewedUsageContext, { kind: 'local' }>): void {
  const { model, runtime } = context
  if (!['openai-codex', 'deepseek'].includes(model.provider)) throw new UsageFailure('provider-unsupported')
  const expectedApi = model.provider === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions'
  if (model.api && model.api !== expectedApi) throw new UsageFailure('provider-unsupported')
  if (!officialUsageOrigin(model.baseUrl, model.provider)) throw new UsageFailure('proxy-unsupported')
  const configured = runtime.getProvider?.(model.provider)?.baseUrl
  if (configured && !officialUsageOrigin(configured, model.provider)) throw new UsageFailure('proxy-unsupported')
  if (typeof runtime.getAuth !== 'function') throw new UsageFailure('runtime-unavailable')
}
