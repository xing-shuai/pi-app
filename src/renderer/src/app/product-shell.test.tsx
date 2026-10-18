import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductShell from './product-shell'

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ i18n: { language: 'en' } }) }))
vi.mock('@renderer/components/app/window-controls', () => ({ WindowControls: () => <span data-testid="window-controls" /> }))
vi.mock('@renderer/components/app/top-bar', () => ({ TopBar: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>Back from settings</button> }))
vi.mock('@renderer/features/settings/settings-page', () => ({ SettingsPage: ({ initialPage }: { initialPage?: string }) => <div data-testid="settings-page-mock" data-page={initialPage}>Shared settings</div> }))
vi.mock('@renderer/components/ui/close-decision-dialog', () => ({ CloseDecisionDialog: () => null }))
vi.mock('@renderer/components/app/app-toaster', () => ({ AppToaster: () => null }))
vi.mock('@renderer/lib/app-update-notify', () => ({ AppUpdateHost: () => null }))
vi.mock('@renderer/features/settings/settings-draft', () => ({ hydrateThemeFromSettings: async () => {}, hydrateCustomThemeFromSettings: async () => {}, hydrateCustomCssOverrideFromSettings: async () => {}, watchSystemTheme: () => () => {} }))
vi.mock('@renderer/lib/theme/background-layer', () => ({ hydrateBackgroundFromSettings: async () => {} }))
vi.mock('@renderer/lib/ui-zoom', () => ({ applyUiZoom: () => {}, readUiZoom: () => 1, referenceUiZoom: () => 1 }))
vi.mock('./app', () => ({ default: ({ active, environmentControl, sidebarFooter }: { active: boolean; environmentControl?: ReactNode; sidebarFooter?: ReactNode }) => <div data-testid="code-mock" data-active={String(active)}>Code workbench{environmentControl}{sidebarFooter}</div> }))
vi.mock('@renderer/features/chat/chat-page', () => ({ ChatPage: ({ onRoutines, sidebarFooter }: { onRoutines: () => void; sidebarFooter?: ReactNode }) => <div data-testid="chat-mock"><textarea aria-label="Preserved chat draft" /><button onClick={onRoutines}>Scheduled</button>{sidebarFooter}</div> }))
vi.mock('@renderer/features/routines/routines-page', () => ({ RoutinesPage: () => <div data-testid="routines-mock">Routine manager</div> }))
vi.mock('@renderer/features/ssh/ssh-workspace-page', () => ({ SshWorkspacePage: () => <div data-testid="ssh-mock">SSH prototype</div> }))
const original = window.piDesktop
let project: string | null
beforeEach(() => {
  localStorage.clear(); project = null
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke: vi.fn(async (channel: string) => {
    if (channel === 'ipc:settings.get') return { settings: { currentProject: project } }
    if (channel === 'ipc:code.environment.get') return { targetId: 'local', connections: [], workspaces: [] }
    if (channel === 'ipc:ssh.profiles') return { profiles: [], authCapabilities: { password: false } }
    return {}
  }) } })
})
afterEach(() => { cleanup(); window.piDesktop = original; localStorage.clear() })
describe('Chat / Code product shell', () => {
  it('gives the main menu keyboard navigation and restores focus without native tooltip titles', async () => {
    render(<ProductShell />)
    await screen.findByTestId('chat-mock')
    const trigger = screen.getByRole('button', { name: 'Main menu' })
    expect(trigger).toHaveAttribute('data-app-tooltip', 'Main menu')
    expect(trigger).not.toHaveAttribute('title')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Main menu actions' })
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'New chat' })).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(within(menu).getByRole('menuitem', { name: 'New routine' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Main menu actions' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
  it('defaults new users to Chat and does not mount the coding runtime until requested', async () => {
    render(<ProductShell />)
    await screen.findByTestId('chat-mock')
    expect(screen.queryByTestId('code-mock')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page')
  })
  it('keeps independent views mounted, preserves drafts and deactivates hidden Code shortcuts', async () => {
    render(<ProductShell />)
    fireEvent.change(await screen.findByLabelText('Preserved chat draft'), { target: { value: 'Keep this idea' } })
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    const code = await screen.findByTestId('code-mock')
    expect(code).toHaveAttribute('data-active', 'true')
    expect(screen.queryByRole('button', { name: /What.s new/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(code).toHaveAttribute('data-active', 'false')
    expect(screen.getByLabelText('Preserved chat draft')).toHaveValue('Keep this idea')
    expect(code.closest('section')).toHaveAttribute('inert')
    expect(code.closest('section')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(code.closest('section')).toHaveAttribute('hidden'))
  })
  it('upgrades existing project users into Code without moving their sessions', async () => {
    project = '/existing/project'
    render(<ProductShell />)
    await screen.findByTestId('code-mock')
    expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page')
  })
  it('opens shared settings without mounting the Code worker workspace', async () => {
    render(<ProductShell />)
    await screen.findByTestId('chat-mock')
    fireEvent.click(screen.getByLabelText('Account and settings'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Settings/ }))
    await screen.findByText('Shared settings')
    expect(screen.queryByTestId('code-mock')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-mock').closest('section')).toHaveAttribute('inert')
    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(screen.getByTestId('chat-mock').closest('section')).not.toHaveAttribute('hidden')
  })

  it('routes Browser setup directly to capabilities, without changing preferences or starting Code', async () => {
    // Appearance migration is an independent first-boot write, not Browser setup.
    localStorage.setItem('pi-desktop-reference-layout-20261017-matched', '1')
    render(<ProductShell />)
    await screen.findByTestId('chat-mock')
    fireEvent(window, new CustomEvent('pi-desktop:open-capability-settings'))
    expect(await screen.findByTestId('settings-page-mock')).toHaveAttribute('data-page', 'rightPanels')
    expect(screen.queryByTestId('code-mock')).not.toBeInTheDocument()
    expect(vi.mocked(window.piDesktop!.invoke).mock.calls.some(([method]) => method === 'ipc:settings.set')).toBe(false)
  })

  it('offers Routines and SSH initialization without a separate remote workbench', async () => {
    render(<ProductShell />)
    await screen.findByTestId('chat-mock')
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }))
    await screen.findByTestId('routines-mock')
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    await screen.findByTestId('code-mock')
    fireEvent.click(screen.getByLabelText('Code execution environment'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'SSH' }))
    const sameWorkbench = screen.getByTestId('code-mock')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add SSH connection…' }))
    await screen.findByRole('dialog', { name: 'Add SSH connection' })
    expect(screen.queryByTestId('ssh-mock')).not.toBeInTheDocument()
    expect(screen.getByTestId('code-mock')).toBe(sameWorkbench)
    expect(sameWorkbench.closest('section')).not.toHaveAttribute('hidden')
    await waitFor(() => expect(sameWorkbench).toHaveAttribute('data-active', 'false'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Add SSH connection' }))
    await waitFor(() => expect(sameWorkbench).toHaveAttribute('data-active', 'true'))
  })
})
