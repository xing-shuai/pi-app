import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { CodeUsagePopover } from './code-usage-popover'
import { ipcClient } from '@renderer/lib/ipc-client'
import type { ProviderUsageSnapshot } from '@shared/provider-usage-types'
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))
const ready: ProviderUsageSnapshot = { status: 'ready', semantics: 'subscription-allowance', provider: 'openai-codex', model: 'gpt-5.4', displayLabel: 'OpenAI Codex · subscription allowance', plan: 'plus', windows: [{ id: 'primary', label: 'Primary limit', usedPercent: 25, remainingPercent: 75, resetAt: '2027-01-15T08:00:00.000Z', windowSeconds: 18000 }], balances: [], credits: { amount: '12.50', available: true }, stale: false, fetchedAt: '2027-01-15T01:00:00.000Z' }

const metrics = { estContextTokens: 51200, contextWindow: 200000, ctxPct: 25.6 }
beforeEach(() => {
  vi.mocked(ipcClient.invoke).mockReset().mockResolvedValue({ status: 'unavailable', semantics: 'unavailable', displayLabel: 'Provider allowance / balance', windows: [], balances: [], stale: false, reason: 'auth-unavailable' })
  useUIStore.setState({ currentWorkspace: '/work', historySessionFile: '/session-A', currentSessionId: 'A', runState: { status: 'idle', toolCount: 0, errorCount: 0, usage: undefined } })
})
function open(onOpenUsage?: () => void) {
  render(<CodeUsagePopover metrics={metrics} onOpenUsage={onOpenUsage} />)
  const trigger = screen.getByRole('button', { name: 'Context window and usage' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('Code context and usage disclosure', () => {
  it('shows the current estimate and actual recorded metrics without inventing provider quotas', () => {
    useUIStore.setState({ runState: { status: 'idle', toolCount: 0, errorCount: 0, usage: { input: 1234, output: 456, cacheRead: 50, cacheWrite: 10, cost: 0.0278 } } })
    open()
    expect(screen.getByRole('dialog', { name: 'Context window and usage' })).toBeInTheDocument()
    expect(screen.getByText(/~51\.2k \/ 200\.0k \(25\.6%\)/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '26')
    expect(screen.queryByText('Recorded usage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('$0.0278')).toBeInTheDocument()
    expect(screen.getByText('1.2k / 456')).toBeInTheDocument()
    expect(screen.getByText(/Estimated from the current session text/)).toBeInTheDocument()
    expect(screen.getByText('Loading current provider account…')).toBeInTheDocument()
    expect(screen.queryByText('Plan usage limits')).toBeNull()
    expect(screen.queryByText(/Personal Pro|92%|Resets Mon|1% used/)).toBeNull()
  })

  it('queries on open only, shows real windows/plan/credits/reset and manually refreshes', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue(ready)
    render(<CodeUsagePopover metrics={metrics} />)
    expect(ipcClient.invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByRole('heading', { name: 'OpenAI Codex · plus' })).toBeInTheDocument()
    expect(screen.getByText('75% remaining')).toBeInTheDocument()
    expect(screen.queryByText(/25% used/)).toBeNull()
    expect(screen.getByText('12.5')).toHaveAttribute('aria-label', '12.50')
    expect(screen.getByText('12.5')).toHaveAttribute('data-app-tooltip', '12.50')
    expect(document.querySelector('time[datetime="2027-01-15T08:00:00.000Z"]')).not.toBeNull()
    expect(ipcClient.invoke).toHaveBeenLastCalledWith('providerUsage.get', { workspaceId: '/work', sessionFile: '/session-A', force: false })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(ipcClient.invoke).toHaveBeenLastCalledWith('providerUsage.get', { workspaceId: '/work', sessionFile: '/session-A', force: true }))
  })

  it('queries the reloaded viewed history, not an absent or unrelated worker binding', async () => {
    useUIStore.setState({
      historySessionFile: '/reloaded-local-history.jsonl', currentSessionId: 'reloaded',
      currentWorkspace: '/work',
      workerLiveSnapshot: { sessionId: 'other', sessionFile: '/unrelated-live.jsonl', status: 'idle' },
      runState: { status: 'idle', toolCount: 0, errorCount: 0, model: 'openai-codex/recorded-codex' },
    })
    vi.mocked(ipcClient.invoke).mockResolvedValue(ready)
    open()
    await screen.findByText('75% remaining')
    expect(ipcClient.invoke).toHaveBeenCalledExactlyOnceWith('providerUsage.get', {
      workspaceId: '/work', sessionFile: '/reloaded-local-history.jsonl', force: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(ipcClient.invoke).toHaveBeenLastCalledWith('providerUsage.get', {
      workspaceId: '/work', sessionFile: '/reloaded-local-history.jsonl', force: true,
    }))
    expect(vi.mocked(ipcClient.invoke).mock.calls.every(([channel]) => channel === 'providerUsage.get')).toBe(true)
  })

  it('renders exact currency balance independently of tokens and unknown context', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue({ ...ready, semantics: 'api-balance', displayLabel: 'DeepSeek · API balance', plan: undefined, credits: undefined, windows: [], balances: [{ currency: 'CNY', amount: '110.00000000000001', kind: 'total' }, { currency: 'USD', amount: '20.00', kind: 'total' }] })
    render(<CodeUsagePopover metrics={{ estContextTokens: null, contextWindow: null, ctxPct: null }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('CNY ≈110')).toHaveAttribute('aria-label', 'CNY 110.00000000000001')
    expect(screen.getByText('USD 20')).toHaveAttribute('data-app-tooltip', 'USD 20.00')
    expect(screen.queryByText(/Plan:|Reported cost/)).toBeNull()
  })

  it('ignores an old response after switching workspace/session and after closing', async () => {
    let oldResolve!: (snapshot: ProviderUsageSnapshot) => void
    vi.mocked(ipcClient.invoke).mockImplementationOnce(() => new Promise((resolve) => { oldResolve = resolve })).mockResolvedValue({ ...ready, plan: 'new-account-plan' })
    open()
    act(() => useUIStore.setState({ currentWorkspace: '/other-root', historySessionFile: '/session-B', currentSessionId: 'B' }))
    expect(await screen.findByRole('heading', { name: 'OpenAI Codex · new-account-plan' })).toBeInTheDocument()
    await act(async () => { oldResolve(ready) })
    expect(screen.queryByRole('heading', { name: 'OpenAI Codex · plus' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'OpenAI Codex · new-account-plan' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders honest auth/proxy/network failure reasons', async () => {
    open()
    expect(await screen.findByText(/Authentication is unavailable/)).toBeInTheDocument()
    vi.mocked(ipcClient.invoke).mockResolvedValue({ ...ready, status: 'unavailable', reason: 'proxy-unsupported' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/disabled for proxy or custom endpoints/)).toBeInTheDocument()
    vi.mocked(ipcClient.invoke).mockRejectedValue(new Error('raw-secret'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Provider usage could not be loaded. Try Refresh.')).toBeInTheDocument()
    expect(screen.queryByText(/raw-secret/)).toBeNull()
  })

  it('does not represent absent context as zero or make up a cost', () => {
    render(<CodeUsagePopover metrics={{ estContextTokens: null, contextWindow: null, ctxPct: null }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText(/Context usage is unavailable/)).toBeInTheDocument()
    expect(screen.queryByText('Reported cost')).toBeNull()
  })

  it('closes on Escape, restores focus, and closes on click-away', async () => {
    const trigger = open()
    await waitFor(() => expect(document.activeElement).toHaveClass('code-usage-content'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('routes details via callback or the shared usage event and dismisses', () => {
    const callback = vi.fn()
    const { unmount } = render(<CodeUsagePopover metrics={metrics} onOpenUsage={callback} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    fireEvent.click(screen.getByRole('button', { name: 'See detailed breakdown' }))
    expect(callback).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    const listener = vi.fn()
    window.addEventListener('pi-desktop:open-usage-settings', listener)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    fireEvent.click(screen.getByRole('button', { name: 'See detailed breakdown' }))
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('pi-desktop:open-usage-settings', listener)
  })
})
