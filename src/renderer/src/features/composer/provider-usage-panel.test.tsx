import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcClient } from '@renderer/lib/ipc-client'
import type { ProviderUsageSnapshot } from '@shared/provider-usage-types'
import { formatUsageDecimal, ProviderUsagePanel, relativeReset } from './provider-usage-panel'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))
const ready: ProviderUsageSnapshot = {
  status: 'ready', semantics: 'subscription-allowance', provider: 'openai-codex', displayLabel: 'OpenAI Codex · subscription allowance', plan: 'pro', stale: false,
  windows: [
    { id: 'codex:primary', label: 'Codex · Primary limit', windowSeconds: 604800, remainingPercent: 91, usedPercent: 9, resetAt: '2027-01-15T08:00:00.000Z' },
    { id: 'codex:secondary', label: 'Codex · Secondary limit', windowSeconds: 18000, remainingPercent: 67.5, usedPercent: 32.5 },
    { id: 'additional-0:primary', label: 'Extra model', remainingPercent: 80, usedPercent: 20 },
  ], balances: [], credits: { amount: '61907.3115230000', available: true },
}
beforeEach(() => { vi.mocked(ipcClient.invoke).mockReset().mockResolvedValue(ready) })

describe('exact compact decimals', () => {
  it.each([
    ['61907.3115230000', '≈61,907.31'], ['12.50', '12.5'], ['20.0000000000', '20'],
    ['110.00000000000001', '≈110'], ['999999999999999999999999.9999', '≈1,000,000,000,000,000,000,000,000'],
    ['0.000012340000', '≈0.000012'], ['-1234.567', '≈-1,234.57'], ['0.005', '0.005'], ['-0.0100', '-0.01'], ['0.000', '0'], ['999.999', '≈1,000'],
  ])('%s → %s', (raw, expected) => { expect(formatUsageDecimal(raw)).toBe(expected) })
  it('uses actual reset timestamps for relative text', () => {
    const now = Date.parse('2027-01-01T00:00:00Z')
    expect(relativeReset('2027-01-01T02:30:00Z', now)).toBe('Resets in 2h 30m')
    expect(relativeReset('2027-01-03T01:00:00Z', now)).toBe('Resets in 2d 1h')
    expect(relativeReset('2026-12-31T00:00:00Z', now)).toBe('Reset due')
  })
})

describe('compact provider DTO disclosure', () => {
  it('shows the actual 168h/5h primary windows, hides extra stats, preserves exact credits accessibly', async () => {
    render(<ProviderUsagePanel workspaceId="/work" sessionFile="/a" details={<p>Recorded usage</p>} />)
    expect(await screen.findByText('Primary limit · 168h')).toBeInTheDocument()
    expect(screen.getByText('Secondary limit · 5h')).toBeInTheDocument()
    expect(screen.queryByText('Extra model')).toBeNull()
    expect(screen.queryByText('Recorded usage')).toBeNull()
    expect(screen.queryByText(/9% used/)).toBeNull()
    const credits = screen.getByText('≈61,907.31')
    expect(credits).toHaveAttribute('aria-label', '61907.3115230000')
    expect(credits).toHaveAttribute('data-app-tooltip', '61907.3115230000')
    expect(screen.getByText('Codex credits')).toBeInTheDocument()
    expect(screen.queryByText(/USD|\$/)).toBeNull()
    const reset = document.querySelector('time')!
    expect(reset).toHaveAttribute('datetime', ready.windows[0].resetAt)
    expect(reset).toHaveAttribute('data-app-tooltip', new Date(ready.windows[0].resetAt!).toLocaleString())
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    expect(refresh).toHaveAttribute('data-app-tooltip', 'Refresh provider usage')
    expect(refresh).not.toHaveAttribute('title')
    expect(refresh.querySelector('svg')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Extra model')).toBeInTheDocument()
    expect(screen.getByText('91% remaining · 9% used')).toBeInTheDocument()
    expect(screen.getByText('Recorded usage')).toBeInTheDocument()
    expect(screen.queryByText(/Extra model · .*h/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText('Extra model')).toBeNull()
    expect(ipcClient.invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps grants/top-ups and exact API currencies in details, independent from credits', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue({ ...ready, provider: 'deepseek', semantics: 'api-balance', credits: undefined, windows: [], balances: [{ kind: 'total', currency: 'CNY', amount: '12345678901234567890.0100' }, { kind: 'granted', currency: 'CNY', amount: '0.000000000001' }, { kind: 'topped-up', currency: 'CNY', amount: '100.00' }] })
    render(<ProviderUsagePanel />)
    expect(await screen.findByText('CNY 12,345,678,901,234,567,890.01')).toHaveAttribute('data-app-tooltip', 'CNY 12345678901234567890.0100')
    expect(screen.queryByText('Granted balance')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('CNY ≈0')).toHaveAttribute('aria-label', 'CNY 0.000000000001')
    expect(screen.getByText('CNY 100')).toHaveAttribute('aria-label', 'CNY 100.00')
  })

  it('locks refresh in flight, ignores old same-session model results and close/reopen results', async () => {
    let oldResolve!: (snapshot: ProviderUsageSnapshot) => void
    vi.mocked(ipcClient.invoke).mockImplementationOnce(() => new Promise((resolve) => { oldResolve = resolve })).mockResolvedValue({ ...ready, plan: 'current-account' })
    const { rerender, unmount } = render(<ProviderUsagePanel workspaceId="/work" sessionFile="/a" modelKey="old-model" />)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(ipcClient.invoke).toHaveBeenCalledTimes(1)
    rerender(<ProviderUsagePanel workspaceId="/work" sessionFile="/a" modelKey="new-model" />)
    expect(await screen.findByRole('heading', { name: 'OpenAI Codex · current-account' })).toBeInTheDocument()
    await act(async () => oldResolve(ready))
    expect(screen.queryByRole('heading', { name: 'OpenAI Codex · pro' })).toBeNull()
    let afterClose!: (snapshot: ProviderUsageSnapshot) => void
    vi.mocked(ipcClient.invoke).mockImplementationOnce(() => new Promise((resolve) => { afterClose = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    unmount()
    render(<ProviderUsagePanel workspaceId="/work" sessionFile="/a" modelKey="new-model" />)
    await screen.findByRole('heading', { name: 'OpenAI Codex · current-account' })
    await act(async () => afterClose(ready))
    expect(screen.queryByRole('heading', { name: 'OpenAI Codex · pro' })).toBeNull()
    await waitFor(() => expect(ipcClient.invoke).toHaveBeenLastCalledWith('providerUsage.get', { workspaceId: '/work', sessionFile: '/a', force: false }))
  })
})
