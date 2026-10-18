import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ProviderUsageReason, ProviderUsageSnapshot, ProviderUsageWindow } from '@shared/provider-usage-types'
import { RefreshCw } from '@renderer/components/icons'
import { ipcClient } from '@renderer/lib/ipc-client'

const REASONS: Record<ProviderUsageReason, string> = {
  'remote-unsupported': 'This execution runtime does not expose a safe provider-usage capability. Your desktop account was not queried.',
  'remote-bridge-unavailable': 'The remote quota extension did not complete its private handshake. No model prompt was sent. Your desktop account was not queried.',
  'remote-sdk-unsupported': 'The running remote CLI’s SDK/account directory could not be verified, or its registry API is unsupported. No other installation or account was used.',
  'remote-provider-config-unsupported': 'The remote provider has an authentication/header/command override or custom provider implementation. Its account cannot be safely matched to stored credentials; model-only customizations are supported.',
  'remote-session-untrusted': 'The remote session is not a trusted RPC session. No account query was sent.',
  'runtime-unavailable': 'This session runtime cannot resolve provider usage yet.',
  'session-unavailable': 'The selected local session could not be verified. Reopen its history and refresh.',
  'provider-unsupported': 'Allowance queries currently support OpenAI Codex subscriptions and DeepSeek API balances only.',
  'auth-unavailable': 'Authentication is unavailable or expired for this session’s provider. Sign in and refresh.',
  'oauth-required': 'Codex subscription allowance requires the session’s ChatGPT OAuth login, not an API key.',
  'proxy-unsupported': 'Usage queries are disabled for proxy or custom endpoints to protect your credentials.',
  'account-changed': 'The session, model or account changed during the query. Refresh to query the current account.',
  'request-failed': 'The provider usage request failed. Try Refresh.',
  'timeout': 'The provider usage query timed out after 8 seconds. Try Refresh.',
  'invalid-response': 'The provider returned an unrecognized usage response.',
  'busy': 'Too many provider queries are pending. Try Refresh shortly.',
  'invalid-request': 'The provider usage request is invalid.',
}
/** Format decimal strings without ever converting API money through IEEE-754. */
export function formatUsageDecimal(raw: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) return raw
  const [, sign, integer, fraction = ''] = match
  const digits = integer.replace(/^0+(?=\d)/, '')
  const precision = digits === '0' ? Math.max(2, Math.min(8, (fraction.search(/[1-9]/) < 0 ? 0 : fraction.search(/[1-9]/)) + 2)) : 2
  const discarded = fraction.slice(precision)
  const approximate = /[1-9]/.test(discarded)
  let units = BigInt(digits + fraction.slice(0, precision).padEnd(precision, '0'))
  if (discarded && discarded[0] >= '5') units += 1n
  const padded = units.toString().padStart(precision + 1, '0')
  const whole = padded.slice(0, -precision).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimals = padded.slice(-precision).replace(/0+$/, '')
  return `${approximate ? '≈' : ''}${sign}${whole}${decimals ? `.${decimals}` : ''}`
}

function ExactAmount({ amount, currency }: { amount: string; currency?: string }) {
  const exact = `${currency ? `${currency} ` : ''}${amount}`
  return <span aria-label={exact} data-app-tooltip={exact}>{currency && `${currency} `}{formatUsageDecimal(amount)}</span>
}

/** Relative presentation only; neither duration nor reset is inferred from a window's position. */
export function relativeReset(resetAt: string, now = Date.now()): string {
  const delta = new Date(resetAt).getTime() - now
  if (!Number.isFinite(delta)) return resetAt
  if (delta <= 0) return 'Reset due'
  const minutes = Math.ceil(delta / 60000)
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Resets in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `Resets in ${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

function UsageWindow({ window, expanded }: { window: ProviderUsageWindow; expanded: boolean }) {
  const label = window.label.replace(/^Codex · /, '')
  return <div className="compact-usage-window">
    <div className="compact-usage-window-heading"><span data-app-tooltip={window.label}>{label}{window.windowSeconds != null ? ` · ${window.windowSeconds / 3600}h` : ''}</span><strong>{window.remainingPercent}% remaining</strong></div>
    <div className="compact-allowance-progress" role="progressbar" aria-label={`${window.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}><span style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }} /></div>
    {window.resetAt && <time dateTime={window.resetAt} data-app-tooltip={new Date(window.resetAt).toLocaleString()} aria-label={`Resets ${new Date(window.resetAt).toLocaleString()}`}>{relativeReset(window.resetAt)}</time>}
    {expanded && <p className="code-usage-note">{window.remainingPercent}% remaining · {window.usedPercent}% used</p>}
  </div>
}

/** Mounted only while the popup is open: no polling, model-turn hooks, or background auth. */
export function ProviderUsagePanel({ workspaceId, sessionFile, modelKey, details }: { workspaceId?: string; sessionFile?: string; modelKey?: string; details?: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const [state, setState] = useState<{ key: string; snapshot?: ProviderUsageSnapshot; failed?: boolean }>()
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const key = JSON.stringify([workspaceId, sessionFile, modelKey])
  useEffect(() => {
    const current = ++generation.current
    let alive = true
    setState({ key })
    void ipcClient.invoke('providerUsage.get', { workspaceId, sessionFile, force: refresh > 0 }).then((snapshot: ProviderUsageSnapshot) => {
      if (!alive || current !== generation.current) return
      if (!snapshot || !['ready', 'unavailable', 'error'].includes(snapshot.status)) setState({ key, failed: true })
      else setState({ key, snapshot })
    }).catch(() => { if (alive && current === generation.current) setState({ key, failed: true }) })
    return () => { alive = false; generation.current++ }
  }, [key, refresh, workspaceId, sessionFile])
  // Hide old account data synchronously on a root/session/model switch, before the effect runs.
  const view = state?.key === key ? state : undefined
  const snapshot = view?.snapshot
  const loading = !view?.failed && !snapshot
  const primaryWindows = snapshot?.windows.filter((window) => /^(?:codex:(?:primary|secondary)|primary|secondary)$/.test(window.id)) ?? []
  const summaryWindows = primaryWindows.length ? primaryWindows : (snapshot?.windows.slice(0, 1) ?? [])
  const summaryBalances = snapshot?.balances.filter((balance) => balance.kind === 'total') ?? []
  return <section aria-label="Provider plan usage" className="code-usage-plan" aria-busy={loading}>
    <div className="compact-provider-heading">
      <h3 data-app-tooltip={snapshot?.displayLabel}>{snapshot?.provider === 'openai-codex' ? 'OpenAI Codex' : snapshot?.provider === 'deepseek' ? 'DeepSeek' : snapshot?.displayLabel ?? 'Provider allowance / balance'}{snapshot?.plan && <span> · {snapshot.plan}</span>}</h3>
      <button type="button" className="compact-popover-icon" aria-label="Refresh" data-app-tooltip="Refresh provider usage" onClick={() => setRefresh((value) => value + 1)} disabled={loading}><RefreshCw size={16} /></button>
    </div>
    {loading && <p role="status" className="code-usage-note">Loading current provider account…</p>}
    {view?.failed && <p role="status" className="code-usage-note">Provider usage could not be loaded. Try Refresh.</p>}
    {snapshot && snapshot.status !== 'ready' && <p role="status" className="code-usage-note">{snapshot.reason === 'remote-unsupported' && workspaceId?.startsWith('/__pi_ssh__/') ? 'This remote Pi runtime has no safe quota bridge. Reconnect SSH to load the updated helper; older or wrapped CLI installations may remain unsupported. Your desktop account was not queried.' : REASONS[snapshot.reason ?? 'request-failed']}</p>}
    {snapshot?.status === 'ready' && <>
      {summaryWindows.map((window) => <UsageWindow key={window.id} window={window} expanded={expanded} />)}
      <dl>
        {summaryBalances.map((balance) => <div key={`${balance.currency}-${balance.kind}`}><dt>Total balance</dt><dd><ExactAmount amount={balance.amount} currency={balance.currency} /></dd></div>)}
        {snapshot.credits && <div><dt>Codex credits</dt><dd>{snapshot.credits.unlimited ? 'Unlimited' : snapshot.credits.amount != null ? <ExactAmount amount={snapshot.credits.amount} /> : snapshot.credits.available === true ? 'Available' : snapshot.credits.available === false ? 'None' : 'Not reported'}</dd></div>}
      </dl>
      {snapshot.exhausted && <p className="code-usage-note">Subscription limit reached</p>}
      {snapshot.apiAvailable === false && <p className="code-usage-note">API calls unavailable</p>}
      {snapshot.stale && <p role="status" className="code-usage-note">Stale provider data · Refresh to update</p>}
    </>}
    <button type="button" className="compact-details-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide details' : 'Show details'}<span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
    {expanded && <div id={detailsId} className="compact-usage-details">
      {snapshot?.status === 'ready' && <>
        {snapshot.windows.filter((window) => !summaryWindows.includes(window)).map((window) => <UsageWindow key={window.id} window={window} expanded />)}
        <dl>{snapshot.balances.filter((balance) => !summaryBalances.includes(balance)).map((balance) => <div key={`${balance.currency}-${balance.kind}`}><dt>{balance.kind === 'granted' ? 'Granted balance' : balance.kind === 'rated-spend' ? 'Rated spend' : 'Topped-up balance'}</dt><dd><ExactAmount amount={balance.amount} currency={balance.currency} /></dd></div>)}</dl>
        {snapshot.exhausted !== undefined && <p className="code-usage-note">{snapshot.exhausted ? 'Subscription limit reached' : 'Subscription limit not reached'}</p>}
        {snapshot.apiAvailable !== undefined && <p className="code-usage-note">API calls {snapshot.apiAvailable ? 'available' : 'unavailable'}</p>}
        {snapshot.fetchedAt && <p className="code-usage-note">{snapshot.stale ? 'Stale · ' : ''}Updated <time dateTime={snapshot.fetchedAt} data-app-tooltip={new Date(snapshot.fetchedAt).toLocaleString()}>{new Date(snapshot.fetchedAt).toLocaleTimeString()}</time></p>}
      </>}
      {details}
      <p className="code-usage-note">Queried only when opened or refreshed. Recorded token cost is not your plan balance. Codex credits are not USD.</p>
    </div>}
  </section>
}
