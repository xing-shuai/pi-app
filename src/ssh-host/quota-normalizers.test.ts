import { expect, it } from 'vitest'
import { normalizeCodex, normalizeDeepSeek } from './quota-normalizers'
import { normalizeCodex as desktopCodex, normalizeDeepSeek as desktopDeepSeek } from '../main/provider-usage/normalizers'
it('keeps the standalone Codex projection identical without runtime shared chunks', () => {
  const payload = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000 }, limit_reached: false }, credits: { has_credits: true, balance: '61907.3115230000', unlimited: false } }
  expect(normalizeCodex(payload)).toEqual(desktopCodex(payload))
  expect(() => normalizeCodex({})).toThrow('invalid-response')
})
it('preserves exact DeepSeek decimal balances and rejects malformed currency', () => {
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '123.450000001', granted_balance: '0.000000001', topped_up_balance: '123.45' }] }
  expect(normalizeDeepSeek(payload)).toEqual(desktopDeepSeek(payload))
  expect(() => normalizeDeepSeek({ ...payload, balance_infos: [{ ...payload.balance_infos[0], currency: 'OTHER' }] })).toThrow('invalid-response')
})
