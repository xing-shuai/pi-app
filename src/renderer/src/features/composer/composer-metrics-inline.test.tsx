import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { formatTokens } from '@renderer/lib/format-tokens'
import { ComposerMetricsInline } from './composer-metrics-inline'
const metrics = { contextPreview: null, estContextTokens: 100, contextWindow: 1000, ctxPct: 10, cacheHitPct: null, cacheWrite: 0, tps: 24, formatTokens }
it('keeps live speed but no second context icon in the reference toolbar', () => {
  render(<ComposerMetricsInline metrics={metrics} isRunning showContext={false} />)
  expect(screen.getByText('24 tps')).toBeInTheDocument()
  expect(screen.queryByRole('img')).toBeNull()
})
it('retains the context ring for the original non-reference toolbar', () => {
  render(<ComposerMetricsInline metrics={metrics} isRunning />)
  expect(screen.getAllByRole('img')).toHaveLength(1)
})
