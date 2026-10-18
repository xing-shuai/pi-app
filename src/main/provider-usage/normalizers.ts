// Adapted from @narumitw/pi-usage 0.61.1 providers/codex.ts and deepseek.ts.
// Copyright (c) 2026 narumiruna. MIT; see ./LICENSE.pi-usage.
import type { ProviderUsageSnapshot, ProviderUsageWindow } from '@shared/provider-usage-types'
import { UsageFailure } from './runtime'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
}
export function safeUsageText(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string' || !value || secrets.some((secret) => secret && value.includes(secret))) return undefined
  if (/bearer|access_token|refresh_token|api_key/i.test(value)) return undefined
  return value.replace(/[^a-zA-Z0-9 ._:/+-]/g, '').slice(0, 100) || undefined
}
export function normalizeCodex(payload: unknown, secrets: readonly string[] = []): Pick<ProviderUsageSnapshot, 'windows' | 'balances' | 'plan' | 'credits' | 'exhausted'> {
  const data = object(payload)
  const windows: ProviderUsageWindow[] = []
  const group = (raw: unknown, id: string, label: string) => {
    const rate = object(raw)
    for (const position of ['primary', 'secondary'] as const) {
      const w = object(rate[`${position}_window`])
      const used = number(w.used_percent)
      if (used === undefined || used < 0 || used > 100) continue
      const seconds = number(w.limit_window_seconds)
      const reset = number(w.reset_at)
      windows.push({
        id: `${id}:${position}`, label: `${label} · ${position === 'primary' ? 'Primary limit' : 'Secondary limit'}`,
        usedPercent: used, remainingPercent: 100 - used,
        ...(seconds !== undefined && seconds > 0 ? { windowSeconds: seconds } : {}),
        ...(reset !== undefined && reset > 0 && reset < 8.64e12 ? { resetAt: new Date(reset * 1000).toISOString() } : {}),
      })
    }
  }
  group(data.rate_limit, 'codex', 'Codex')
  if (Array.isArray(data.additional_rate_limits)) data.additional_rate_limits.slice(0, 16).forEach((item, index) => {
    const additional = object(item)
    group(additional.rate_limit, `additional-${index}`, safeUsageText(additional.limit_name, secrets) ?? 'Additional model limit')
  })
  const rawCredits = object(data.credits)
  let credits: ProviderUsageSnapshot['credits']
  if (typeof rawCredits.has_credits === 'boolean' || typeof rawCredits.unlimited === 'boolean') {
    const amount = decimal(rawCredits.balance) ? rawCredits.balance : typeof rawCredits.balance === 'number' && Number.isFinite(rawCredits.balance) ? String(rawCredits.balance) : undefined
    credits = {
      ...(typeof rawCredits.has_credits === 'boolean' ? { available: rawCredits.has_credits } : {}),
      ...(typeof rawCredits.unlimited === 'boolean' ? { unlimited: rawCredits.unlimited } : {}),
      ...(amount !== undefined ? { amount } : {}),
    }
  }
  if (!windows.length && !credits) throw new UsageFailure('invalid-response')
  const rate = object(data.rate_limit)
  return { windows, balances: [], plan: safeUsageText(data.plan_type, secrets), credits,
    ...(typeof rate.limit_reached === 'boolean' ? { exhausted: rate.limit_reached } : {}) }
}
export function normalizeDeepSeek(payload: unknown): Pick<ProviderUsageSnapshot, 'windows' | 'balances' | 'apiAvailable'> {
  const data = object(payload)
  if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length || data.balance_infos.length > 2) throw new UsageFailure('invalid-response')
  const balances: ProviderUsageSnapshot['balances'] = []
  const seen = new Set<string>()
  for (const raw of data.balance_infos) {
    const row = object(raw)
    if ((row.currency !== 'CNY' && row.currency !== 'USD') || seen.has(row.currency)) throw new UsageFailure('invalid-response')
    seen.add(row.currency)
    for (const [kind, field] of [['total', 'total_balance'], ['granted', 'granted_balance'], ['topped-up', 'topped_up_balance']] as const) {
      if (!decimal(row[field])) throw new UsageFailure('invalid-response')
      balances.push({ currency: row.currency, kind, amount: row[field] })
    }
  }
  return { windows: [], balances, apiAvailable: data.is_available }
}
