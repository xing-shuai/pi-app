import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { Composer } from './composer'

const mocks = vi.hoisted(() => ({ send: vi.fn(), abort: vi.fn(), attach: vi.fn(), running: false }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async () => ({})) } }))
vi.mock('@renderer/lib/composer-run-display', () => ({ refreshComposerRunDisplay: vi.fn() }))
vi.mock('@renderer/lib/session-chrome', () => ({ useSessionChrome: () => ({ canStop: mocks.running, showSpinner: mocks.running }) }))
vi.mock('./use-composer-metrics', () => ({ useComposerMetrics: () => ({}) }))
vi.mock('./composer-metrics-inline', () => ({ ComposerMetricsInline: ({ showContext = true }: { showContext?: boolean }) => <span data-testid="run-metrics" data-context-visible={String(showContext)}>Run metrics</span> }))
vi.mock('./composer-tools-menu', () => ({ ComposerToolsMenu: () => <button>Tools</button> }))
vi.mock('./composer-adapter-widget-host', () => ({ ComposerAdapterWidgetHost: () => null }))
vi.mock('./composer-agent-activity', () => ({ ComposerAgentActivity: () => null }))
vi.mock('./composer-compaction-banner', () => ({ ComposerCompactionBanner: () => null }))
vi.mock('./composer-pending-queue', () => ({ ComposerPendingQueue: () => <div data-testid="pending-queue" /> }))
vi.mock('./use-voice-input', () => ({ useVoiceInput: () => ({ voiceState: 'idle', toggle: vi.fn(), disabled: true }) }))
vi.mock('./use-composer-send', () => ({ useComposerSend: () => ({ sendCurrent: mocks.send, handleSend: mocks.send, runComposerAbort: mocks.abort, handleAbort: mocks.abort }) }))
vi.mock('./use-composer-attachments', () => ({ useComposerAttachments: () => ({ pickAttachments: mocks.attach }) }))
vi.mock('./use-composer-slash', () => ({ useComposerSlash: () => ({ showPopover: false, filteredCommands: [], argCompletions: [] }) }))
vi.mock('./use-composer-file-search', () => ({ useComposerFileSearch: () => ({ show: false, entries: [], dismiss: vi.fn() }) }))
vi.mock('./use-composer-keydown', () => ({ useComposerKeyDown: () => vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.running = false
  useUIStore.setState({ currentWorkspace: '/work/reference-composer', currentSessionId: '__pending_new__', historySessionFile: null,
    ephemeralSandboxDraft: false, pendingNewSessionPlaceholder: true, composerPrefill: null, modelPickerOpen: false, thinkingPickerOpen: false,
    runState: { ...useUIStore.getState().runState, model: 'test-model', thinkingLevel: 'medium' },
  })
})

function enterTask() {
  const editor = screen.getByRole('textbox', { name: 'Describe a task or ask a question' })
  editor.textContent = 'Review my changes'
  fireEvent.input(editor)
}

describe('Code reference composer', () => {
  it('places model/tools below the input and keeps return/send inside it', () => {
    const { container } = render(<Composer referenceLayout />)
    const shell = container.querySelector('[data-composer-shell]')!
    const toolbar = container.querySelector('.composer-toolbar')!
    expect(shell.contains(toolbar)).toBe(false)
    expect(toolbar.querySelector('[data-composer-model-chip]')).toBeTruthy()
    expect(toolbar.querySelector('[data-composer-thinking-chip]')).toBeTruthy()
    expect(toolbar.lastElementChild).toBe(screen.getByRole('button', { name: 'Context window and usage' }))
    expect(shell).toContainElement(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('textbox')).toHaveAttribute('data-placeholder', 'Describe a task or ask a question')
    expect(screen.queryByText('Run metrics')).toBeNull()
    expect(screen.queryByText('Auto')).toBeNull()
    expect(screen.getByTestId('pending-queue')).toBeInTheDocument()
  })

  it('preserves attachment, model/thinking and send actions', () => {
    const { container } = render(<Composer referenceLayout />)
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }))
    expect(mocks.attach).toHaveBeenCalledOnce()
    fireEvent.click(container.querySelector('[data-composer-model-chip]')!)
    expect(useUIStore.getState().modelPickerOpen).toBe(true)
    fireEvent.click(container.querySelector('[data-composer-thinking-chip]')!)
    expect(useUIStore.getState().thinkingPickerOpen).toBe(true)
    expect(useUIStore.getState().modelPickerOpen).toBe(false)
    enterTask()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('retains Stop and queue submission while a turn is running', () => {
    mocks.running = true
    const { container } = render(<Composer referenceLayout />)
    const shell = container.querySelector('[data-composer-shell]')!
    expect(shell).toContainElement(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getAllByRole('button', { name: 'Context window and usage' })).toHaveLength(1)
    expect(screen.getByTestId('run-metrics')).toHaveAttribute('data-context-visible', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(mocks.abort).toHaveBeenCalledOnce()
    enterTask()
    const queue = screen.getByRole('button', { name: /queue/i })
    expect(shell).toContainElement(queue)
    fireEvent.click(queue)
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('does not move the default composer toolbar out of its existing shell', () => {
    const { container } = render(<Composer />)
    expect(container.querySelector('[data-composer-shell]')).toContainElement(container.querySelector('.composer-toolbar'))
    expect(container.querySelector('[data-composer-variant]')).toBeNull()
  })
})
