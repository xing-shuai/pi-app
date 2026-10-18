import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionContextMenuPortal } from './session-context-menu'
import { toast } from 'sonner'
const shellMocks = vi.hoisted(() => ({ clearSessionFocus: vi.fn(), patchSessionView: vi.fn() }))
const cacheMocks = vi.hoisted(() => ({ clearLiveSessionTimeline: vi.fn(), clearSessionDiskAuthoritative: vi.fn(), clearSessionWidgets: vi.fn() }))
vi.mock('@renderer/lib/live-session-timeline-cache', () => ({ clearLiveSessionTimeline: cacheMocks.clearLiveSessionTimeline }))
vi.mock('@renderer/lib/session-disk-authority', () => ({ clearSessionDiskAuthoritative: cacheMocks.clearSessionDiskAuthoritative }))
vi.mock('@renderer/lib/extension-widget-cache', () => ({ clearSessionWidgets: cacheMocks.clearSessionWidgets }))
vi.mock('@renderer/lib/session-shell', () => ({ ...shellMocks, getFocusSessionKey: () => uiState.historySessionFile, sessionKeyFromFile: (file: string) => file }))

const invokeMock = vi.fn(async (_method: unknown, _req?: unknown): Promise<unknown> => ({}))
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: unknown, req?: unknown) => invokeMock(method, req) },
}))
const workspaceMocks = vi.hoisted(() => ({
  switchSessionInPlace: vi.fn(),
  activateWorkspace: vi.fn(),
}))
const uiState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
  currentWorkspace: '/proj/current',
  sessionAttention: {} as Record<string, string>,
  historySessionFile: null as string | null,
  setCurrentSession: vi.fn(),
  setHistoryLoading: vi.fn(),
  clearTimeline: () => {},
  loadHistoryItems: () => {},
  setHistoryMeta: () => {},
}))
vi.mock('@renderer/lib/activate-workspace', () => workspaceMocks)
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: Object.assign((selector?: (state: typeof uiState) => unknown) => (selector ? selector(uiState) : uiState), {
    getState: () => uiState,
    setState: () => {},
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const MENU = {
  x: 10,
  y: 10,
  target: {
    sessionId: 's1',
    sessionFile: '/proj/a/s1.jsonl',
    title: '旧标题',
    workspacePath: '/proj/a',
  },
}

describe('SessionContextMenuPortal mutations refresh the owning workspace', () => {
  afterEach(() => {
    invokeMock.mockReset(); shellMocks.clearSessionFocus.mockClear(); shellMocks.patchSessionView.mockClear()
    Object.values(cacheMocks).forEach((mock) => mock.mockClear())
    vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear()
    uiState.currentWorkspace = '/proj/current'; uiState.currentSessionId = null; uiState.historySessionFile = null; uiState.setCurrentSession.mockClear(); uiState.setHistoryLoading.mockClear()
    workspaceMocks.switchSessionInPlace.mockClear()
    workspaceMocks.activateWorkspace.mockClear()
  })

  it('should_activate_owning_workspace_when_continuing_a_foreign_session', async () => {
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.continue'))
    })

    expect(workspaceMocks.activateWorkspace).toHaveBeenCalledWith('/proj/a', {
      sessionId: 's1',
      sessionFile: '/proj/a/s1.jsonl',
    })
    expect(workspaceMocks.switchSessionInPlace).not.toHaveBeenCalled()
  })

  // #94: a native window.confirm leaves Windows Electron pages untypable until alt-tab
  // (electron/electron#19977, #31917) — delete must confirm in-app.
  it('delete confirms in-app instead of the native window.confirm', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const nativeConfirm = vi.spyOn(window, 'confirm')
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.delete'))
    })

    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(invokeMock).not.toHaveBeenCalledWith('session.delete', expect.anything())
  })

  it('delete refreshes the owning workspace', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const onSessionsChange = vi.fn()
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={onSessionsChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.delete'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('common:confirm'))
    })

    expect(invokeMock).toHaveBeenCalledWith('session.delete', {
      sessionFile: '/proj/a/s1.jsonl',
      workspaceId: '/proj/a',
    })
    expect(onSessionsChange).toHaveBeenCalledWith('/proj/a')
    for (const mock of Object.values(cacheMocks)) expect(mock).toHaveBeenCalledExactlyOnceWith('/proj/a/s1.jsonl')
    expect(shellMocks.patchSessionView).toHaveBeenCalledWith('/proj/a/s1.jsonl', expect.objectContaining({ items: [], phase: 'empty' }))
  })

  it('rename refreshes the owning workspace', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const onSessionsChange = vi.fn()
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={onSessionsChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.rename'))
    })
    const input = document.querySelector('input[type="text"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新标题' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common:confirm'))
    })

    expect(invokeMock).toHaveBeenCalledWith('session.rename', {
      sessionId: 's1',
      sessionFile: '/proj/a/s1.jsonl',
      title: '新标题',
      workspaceId: '/proj/a',
    })
    expect(onSessionsChange).toHaveBeenCalledWith('/proj/a')
  })

  it('rename applies the title in place when onSessionRenamed is provided', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const onSessionsChange = vi.fn()
    const onSessionRenamed = vi.fn()
    render(
      <SessionContextMenuPortal
        menu={MENU}
        onClose={() => {}}
        onSessionsChange={onSessionsChange}
        onSessionRenamed={onSessionRenamed}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.rename'))
    })
    const input = document.querySelector('input[type="text"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新标题' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common:confirm'))
    })

    expect(onSessionRenamed).toHaveBeenCalledWith({
      sessionFile: '/proj/a/s1.jsonl',
      title: '新标题',
      workspacePath: '/proj/a',
    })
    // 原地更新时不再整列表重拉
    expect(onSessionsChange).not.toHaveBeenCalled()
  })

  it('delete removes the entry only after backend success, never while the IPC is pending', async () => {
    let resolveDelete: (v: unknown) => void = () => {}
    invokeMock.mockImplementation(async (method: unknown) => {
      if (method === 'session.delete') return new Promise<unknown>((r) => (resolveDelete = r))
      return { ok: true }
    })
    const onSessionRemoved = vi.fn()
    render(
      <SessionContextMenuPortal
        menu={MENU}
        onClose={() => {}}
        onSessionsChange={() => {}}
        onSessionRemoved={onSessionRemoved}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByText('common:sidebar.delete'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('common:confirm'))
    })

    expect(onSessionRemoved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    await act(async () => { resolveDelete({ ok: true }) })
    expect(onSessionRemoved).toHaveBeenCalledWith({ sessionFile: '/proj/a/s1.jsonl', workspacePath: '/proj/a' })
  })

  it('surfaces refusal and transport errors without claiming success or removing history', async () => {
    invokeMock.mockRejectedValue(new Error('session_busy: finish the active turn'))
    const removed = vi.fn()
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={() => {}} onSessionRemoved={removed} />)
    await act(async () => { fireEvent.click(screen.getByText('common:sidebar.delete')) })
    await act(async () => { fireEvent.click(screen.getByText('common:confirm')) })
    expect(toast.error).toHaveBeenCalledWith('session_busy: finish the active turn')
    expect(toast.success).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled()
    for (const mock of Object.values(cacheMocks)) expect(mock).not.toHaveBeenCalled()
  })

  it('resets only the still-current exact remote history and never sends a local pending bind', async () => {
    const target = { ...MENU.target, workspacePath: '/__pi_ssh__/host/root', sessionFile: '/__pi_ssh__/host/root/.sessions/known.jsonl' }
    Object.assign(uiState, { currentWorkspace: target.workspacePath, currentSessionId: target.sessionId, historySessionFile: target.sessionFile })
    invokeMock.mockResolvedValue({ ok: true })
    render(<SessionContextMenuPortal menu={{ ...MENU, target }} onClose={() => {}} onSessionsChange={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('common:sidebar.delete')) })
    await act(async () => { fireEvent.click(screen.getByText('common:confirm')) })
    expect(invokeMock).toHaveBeenCalledWith('session.delete', { workspaceId: target.workspacePath, sessionFile: target.sessionFile })
    expect(uiState.setCurrentSession).toHaveBeenCalledWith(null)
    expect(uiState.setHistoryLoading).toHaveBeenCalledWith(false)
    expect(shellMocks.clearSessionFocus).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalledWith('session.setPendingBind', expect.anything())
  })

  it('does not reset a newer focus after an awaited deletion even if the session ID is identical', async () => {
    let finish!: (value: unknown) => void
    invokeMock.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    Object.assign(uiState, { currentWorkspace: MENU.target.workspacePath, currentSessionId: MENU.target.sessionId, historySessionFile: MENU.target.sessionFile })
    render(<SessionContextMenuPortal menu={MENU} onClose={() => {}} onSessionsChange={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('common:sidebar.delete')) })
    await act(async () => { fireEvent.click(screen.getByText('common:confirm')) })
    Object.assign(uiState, { currentWorkspace: '/other', historySessionFile: '/other/file.jsonl' })
    await act(async () => { finish({ ok: true }) })
    expect(uiState.setCurrentSession).not.toHaveBeenCalled()
    expect(shellMocks.clearSessionFocus).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('disconnected rows explain connect-to-delete without calling any backend', () => {
    render(<SessionContextMenuPortal menu={{ ...MENU, target: { ...MENU.target, disconnected: true } }} onClose={() => {}} onSessionsChange={() => {}} />)
    const button = screen.getByRole('button', { name: 'Connect to delete' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Connect to this SSH host before deleting its session')
    fireEvent.click(button)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
