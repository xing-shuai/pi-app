import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummary } from '@shared/usage-summary'
import { SettingsPage } from './settings-page'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async (method: string) => method === 'usage.summary' ? null : {}) } }))
vi.mock('@renderer/lib/right-panel-runtime', () => ({ invalidateRightPanelCatalog: vi.fn() }))
vi.mock('./settings-draft-context', () => ({ SettingsDraftProvider: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('./settings-save-bar', () => ({ SettingsSaveBar: () => <div>Save controls</div> }))
vi.mock('./settings-general-appearance', () => ({ GeneralSettings: () => <h2>General controls</h2>, AppearanceSettings: () => <h2>Appearance controls</h2>, PiSettings: () => <h2>Runtime controls</h2> }))
vi.mock('./models-settings-panel', () => ({ ModelsSettingsPanel: () => <h2>Model credentials</h2> }))
vi.mock('./skills-settings-panel', () => ({ SkillsSettingsPanel: () => <h2>Skill controls</h2> }))
vi.mock('./mcp-settings-panel', () => ({ McpSettingsPanel: () => <h2>MCP controls</h2> }))
vi.mock('./model-routing-panel', () => ({ ModelRoutingPanel: () => <h2>Routing controls</h2> }))
vi.mock('./prompts-settings-panel', () => ({ PromptsSettingsPanel: () => <h2>Prompt controls</h2> }))
vi.mock('./right-panels-settings', () => ({ RightPanelsSettings: () => <h2>Panel controls</h2> }))
vi.mock('./voice-settings-panel', () => ({ VoiceSettingsPanel: () => <h2>Voice controls</h2> }))
vi.mock('./mobile-settings-panel', () => ({ MobileSettingsPanel: () => <h2>Mobile controls</h2> }))
vi.mock('./settings-extensions-panel', () => ({ ExtensionsSettings: () => <h2>Extension controls</h2> }))
vi.mock('./settings-adapters-panel', () => ({ AdaptersSettings: () => <h2>Adapter controls</h2> }))
vi.mock('@renderer/features/extension-ui/extension-config-subpage', () => ({ ExtensionConfigSubpage: () => null }))

beforeEach(() => {
  useUIStore.setState({ pendingExtensionConfig: null })
  vi.mocked(ipcClient.invoke).mockImplementation(async (method: string) => method === 'usage.summary' ? null : {})
})

// Usage is the actual panel: verify its local summary request, selector and unavailable-limit copy.
describe('reference settings details', () => {
  it('opens directly to accessible real usage settings without fake plan data', () => {
    const { container } = render(<SettingsPage referenceLayout initialPage="usage" />)
    expect(container.querySelector('[data-settings-active-page="usage"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('radiogroup', { name: /range/i })).toBeInTheDocument()
    expect(ipcClient.invoke).toHaveBeenCalledWith('usage.summary', { days: 7 })
    expect(screen.getByRole('region', { name: 'Provider usage limits' })).toBeInTheDocument()
    expect(screen.queryByText(/Personal Pro|92% used|Buy more usage|@gmail/)).toBeNull()
    expect(screen.getByText('Save controls')).toBeInTheDocument()
  })

  it('keeps unsupported categories disabled and every implemented page reachable', () => {
    const { container } = render(<SettingsPage referenceLayout />)
    for (const name of ['Account', 'Privacy', 'Billing', 'Memory', 'Design systems', 'Chrome', 'System', 'Plugins']) {
      const row = screen.getByRole('button', { name })
      expect(row).toBeDisabled()
      expect(row).toHaveAttribute('title')
    }
    const pages = ['general', 'appearance', 'rightPanels', 'pi', 'models', 'skills', 'prompts', 'extensions', 'mcp', 'routing', 'adapters', 'voice', 'mobile', 'usage']
    for (const page of pages) {
      fireEvent.click(container.querySelector(`[data-settings-nav-page="${page}"]`)!)
      expect(container.querySelector(`[data-settings-page="${page}"]`)).toBeTruthy()
    }
  })

  it('preserves embedded navigation and accepts parent navigation while mounted', () => {
    const { container, rerender } = render(<SettingsPage initialPage="models" />)
    expect(container.querySelector('[data-settings-layout="embedded"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Model credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'models' } })
    rerender(<SettingsPage initialPage="appearance" />)
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('heading', { name: 'Appearance controls' })).toBeInTheDocument()
  })

  it('preserves pending adapter configuration routing on initial mount', () => {
    useUIStore.setState({ pendingExtensionConfig: 'test-adapter' })
    const { container } = render(<SettingsPage referenceLayout initialPage="usage" />)
    expect(container.querySelector('[data-settings-page="ext:test-adapter"]')).toBeTruthy()
    expect(useUIStore.getState().pendingExtensionConfig).toBeNull()
  })

  it('retains recorded statistics, charts, model ranks and date-range actions', async () => {
    const bucket = { input: 1200, output: 500, cacheRead: 300, cacheWrite: 0, reasoning: 0, cost: 1.23, calls: 3 }
    const summary: UsageSummary = {
      from: 0, to: 1, total: bucket, cacheHitRate: .2, activeDays: 1, sessions: 1, firstAt: null,
      byDay: [{ ...bucket, day: '2026-06-01' }],
      heat: { calls: Array(168).fill(0), cost: Array(168).fill(0), tokens: Array(168).fill(0) },
      byModel: [{ ...bucket, model: 'test/provider-model' }], byProject: [], topSessions: [],
    }
    vi.mocked(ipcClient.invoke).mockImplementation(async (method: string) => method === 'usage.summary' ? summary : {})
    render(<SettingsPage referenceLayout initialPage="usage" />)
    expect(await screen.findByText('test/provider-model')).toBeInTheDocument()
    expect(screen.getAllByText('$1.23').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('radiogroup').length).toBeGreaterThan(1)
    const range = screen.getByRole('radiogroup', { name: /range/i })
    fireEvent.click(range.querySelectorAll('button')[2])
    expect(ipcClient.invoke).toHaveBeenCalledWith('usage.summary', { days: 30 })
  })

  it('searches actual reference page aliases and navigates to the result', () => {
    render(<SettingsPage referenceLayout />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Connectors' } })
    expect(screen.getByRole('button', { name: 'Connectors MCP' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'MCP controls' })).toBeInTheDocument()
  })
})
