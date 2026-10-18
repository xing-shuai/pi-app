import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine, RoutineEvent, RoutineRun } from '@shared/routine-types'
import { RoutinesPage } from './routines-page'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const routine: Routine = { id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Daily review', description: 'Check code', prompt: 'Inspect only', surface: 'code', cwd: '/code', permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: 1, updatedAt: 2 }
type Invoke = (channel: string, request?: { routine?: Routine; id?: string; runId?: string }) => Promise<unknown>
let invoke: ReturnType<typeof vi.fn<Invoke>>
let emit: (event: RoutineEvent) => void
let definitions: Routine[]
let ledger: RoutineRun[]
const original = window.piDesktop
const openTask = async () => fireEvent.click(await screen.findByTestId('routine-card'))
const cardNames = () => screen.queryAllByTestId('routine-card').map((card) => within(card).getByRole('strong').textContent)
const runRecord = (overrides: Partial<RoutineRun> = {}): RoutineRun => ({ id: 'run-1', routineId: routine.id, scheduledAt: 1700000000000, status: 'succeeded', output: 'Persisted result', ...overrides })
beforeEach(() => {
  definitions = [structuredClone(routine)]
  ledger = []
  invoke = vi.fn(async (channel: string, request?: { routine?: Routine; id?: string; runId?: string }) => {
    if (channel === 'ipc:routines.list') return { routines: [...definitions], runs: [...ledger], runtime: { kind: 'desktop-local', requiresAppOpen: true } }
    if (channel === 'ipc:chat.models') return { models: [{ id: 'actual/model', provider: 'provider', name: 'Display name' }] }
    if (channel === 'ipc:routines.save' && request?.routine) { definitions = [request.routine, ...definitions.filter((r) => r.id !== request.routine?.id)]; return { routine: request.routine } }
    if (channel === 'ipc:routines.run') { const run = runRecord({ status: 'queued', output: '' }); ledger = [run, ...ledger]; return { run } }
    if (channel === 'ipc:routines.delete') definitions = definitions.filter((r) => r.id !== request?.id)
    return { ok: true }
  })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke, onRoutineEvent: (fn: typeof emit) => { emit = fn; return vi.fn() } } })
})
afterEach(() => { cleanup(); window.piDesktop = original; vi.restoreAllMocks() })

describe('local Scheduled tasks', () => {
  it('shows actual tasks and the app-open + awake boundary, with working search/filter/sort', async () => {
    definitions = [routine, { ...routine, id: 'chat', name: 'Alpha checklist', description: 'Reflection', prompt: 'Think through priorities', surface: 'chat', cwd: undefined, enabled: false, updatedAt: 0, nextRunAt: 100 }]
    render(<RoutinesPage surface="chat" />)
    await screen.findAllByTestId('routine-card')
    expect(screen.getByRole('heading', { name: 'Scheduled tasks' })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText(/desktop app is open and your computer is awake/)).toBeInTheDocument()
    expect(cardNames()).toEqual(['Daily review', 'Alpha checklist'])
    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'INSPECT' } })
    expect(cardNames()).toEqual(['Daily review'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Filter tasks' }))
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'paused' } })
    expect(cardNames()).toEqual(['Alpha checklist'])
    fireEvent.change(screen.getByLabelText('Surface filter'), { target: { value: 'code' } })
    expect(screen.getByText('No matching tasks')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort tasks' }))
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'name' } })
    expect(cardNames()).toEqual(['Alpha checklist', 'Daily review'])
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'next' } })
    expect(cardNames()).toEqual(['Alpha checklist', 'Daily review'])
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'updated' } })
    expect(cardNames()).toEqual(['Daily review', 'Alpha checklist'])
    expect(invoke.mock.calls.every(([channel]) => ['ipc:routines.list', 'ipc:chat.models'].includes(channel))).toBe(true)
  })

  it('offers existing examples plus an explicit weather template and creates drafts without saving or installing', async () => {
    definitions = []
    render(<RoutinesPage surface="code" />)
    await screen.findByText('No scheduled tasks yet')
    expect(screen.queryAllByTestId('routine-card')).toHaveLength(0)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Yours' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Templates' })).toHaveFocus()
    const templates = screen.getAllByTestId('routine-template')
    expect(templates).toHaveLength(3)
    expect(templates.map((t) => t.textContent).join(' ')).toMatch(/Daily code review.*Weekly reflection/)
    expect(screen.getByText(/Nothing is installed or run automatically/)).toBeInTheDocument()
    fireEvent.click(templates.find((t) => t.textContent?.includes('Daily code review'))!)
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Daily code review')
    expect(screen.getByLabelText('Instructions', { exact: true })).toHaveValue('Read the workspace code and report potential defects and improvements. Do not modify files.')
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.save', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(screen.queryAllByTestId('routine-card')).toHaveLength(0)
  })

  it('has an accessible custom Chat/Code dropdown and saves Chat without code permissions', async () => {
    render(<RoutinesPage surface="code" />)
    await screen.findByTestId('routine-card')
    const trigger = screen.getByRole('button', { name: 'New task' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('group', { name: 'Task type' })).getByRole('button', { name: /Chat/ }))
    fireEvent.change(screen.getByLabelText('Name', { exact: true }), { target: { value: 'Weekly writing' } })
    fireEvent.change(screen.getByLabelText('Instructions', { exact: true }), { target: { value: 'Create a writing checklist' } })
    expect(screen.getByLabelText('Tool permission')).toBeDisabled()
    expect(screen.queryByLabelText('Local working folder (absolute path)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.save', expect.objectContaining({ confirmedExecution: false, routine: expect.objectContaining({ surface: 'chat', permissionMode: 'read-only', schedule: { type: 'manual' } }) })))
  })

  it('keeps old weather tasks off, explains the limitation before Run, and saves only the checkbox grant', async () => {
    definitions = [{ ...routine, name: 'latestHangzhouweather', prompt: 'latest Hangzhou weather', surface: 'chat', cwd: undefined }]
    render(<RoutinesPage surface="chat" />)
    await openTask()
    expect(screen.getByText(/Chat has no tools and cannot retrieve current weather/)).toBeInTheDocument()
    expect(screen.getByTestId('routine-permission-badge')).toHaveTextContent(/^Chat$/)
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.save', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const toggle = screen.getByRole('checkbox', { name: 'Online weather lookup (read-only)' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/Existing tasks remain off unless/)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByLabelText('Tool permission')).toHaveDisplayValue('Read-only weather')
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.save', expect.objectContaining({ routine: expect.objectContaining({ onlineWeather: true, permissionMode: 'read-only', surface: 'chat' }) })))
    await waitFor(() => expect(screen.getByTestId('routine-permission-badge')).toHaveTextContent('Chat+Weather'))
    expect(screen.getByText('Weather (read-only)')).toBeInTheDocument()
    expect(screen.queryByText('No tools', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText(/Only the weather tool:/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('routine-online-weather')).toBeChecked()
    fireEvent.click(screen.getByTestId('routine-online-weather'))
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(definitions[0].onlineWeather).toBe(false))
  })

  it('weather template opts into a visible editable draft only and never auto-saves or runs', async () => {
    definitions = []
    render(<RoutinesPage surface="chat" />)
    await screen.findByText('No scheduled tasks yet')
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }))
    fireEvent.click(screen.getAllByTestId('routine-template').find((t) => t.textContent?.includes('Hangzhou weather'))!)
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Hangzhou weather')
    expect(screen.getByTestId('routine-online-weather')).toBeChecked()
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain('Use the weather tool')
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.save', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.run', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.save', expect.objectContaining({ routine: expect.objectContaining({ onlineWeather: true, surface: 'chat' }) })))
  })

  it('completed execution is not goal verification, including a model refusal', async () => {
    ledger = [runRecord({ output: 'I cannot get weather because I have no tools.' })]
    render(<RoutinesPage surface="chat" />)
    await openTask()
    fireEvent.click(screen.getByTestId('routine-run-row'))
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeInTheDocument()
    expect(screen.getByTestId('routine-completion-note')).toHaveTextContent('task goal was not independently verified')
    expect(screen.getByText('I cannot get weather because I have no tools.')).toBeInTheDocument()
  })

  it('requires explicit confirmation before saving unsandboxed trusted-code tasks', async () => {
    render(<RoutinesPage surface="code" />)
    await screen.findByTestId('routine-card')
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }))
    fireEvent.change(screen.getByLabelText('Name', { exact: true }), { target: { value: 'Run tests' } })
    fireEvent.change(screen.getByLabelText('Instructions', { exact: true }), { target: { value: 'Run npm test' } })
    fireEvent.change(screen.getByLabelText('Local working folder (absolute path)'), { target: { value: '/code' } })
    fireEvent.change(screen.getByLabelText('Tool permission'), { target: { value: 'trusted-code' } })
    expect(screen.getByRole('button', { name: 'Save routine' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize these permissions/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.save', expect.objectContaining({ confirmedExecution: true, routine: expect.objectContaining({ permissionMode: 'trusted-code' }) })))
  })

  it('allows clearing a one-time date and blocks invalid schedules', async () => {
    render(<RoutinesPage surface="chat" />)
    await screen.findByTestId('routine-card')
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }))
    fireEvent.change(screen.getByLabelText('Name', { exact: true }), { target: { value: 'Once' } })
    fireEvent.change(screen.getByLabelText('Instructions', { exact: true }), { target: { value: 'One-off task' } })
    fireEvent.change(screen.getByLabelText('Schedule', { exact: true }), { target: { value: 'once' } })
    const date = screen.getByLabelText('Local date and time')
    fireEvent.change(date, { target: { value: '' } })
    expect(date).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }))
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.save', expect.anything())
  })

  it('keeps actual model values and uses only the custom local folder callback', async () => {
    definitions = [{ ...routine, model: 'missing-provider/actual/model' }]
    const choose = vi.fn(async () => '/custom/folder')
    render(<RoutinesPage surface="code" onSelectLocalFolder={choose} />)
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Model')).toHaveValue('missing-provider/actual/model')
    expect(screen.getByRole('option', { name: 'Display name · provider' })).toHaveValue('provider/actual/model')
    fireEvent.click(screen.getByRole('button', { name: 'Choose local folder' }))
    await waitFor(() => expect(screen.getByLabelText('Local working folder (absolute path)')).toHaveValue('/custom/folder'))
    expect(choose).toHaveBeenCalledWith('/code')
    expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/dialog|folder/), expect.anything())
  })

  it('renders actual two-column properties, collapses instructions, toggles status, and returns to the list', async () => {
    definitions = [{ ...routine, prompt: 'Long instructions. '.repeat(25), schedule: { type: 'weekly', time: '13:00', timezone: 'Asia/Shanghai', dayOfWeek: 5 }, nextRunAt: 1700000000000 }]
    render(<RoutinesPage surface="code" />)
    await openTask()
    expect(screen.getByText('/code')).toBeInTheDocument()
    expect(screen.getByText('Weekly · Friday · 13:00 · Asia/Shanghai')).toBeInTheDocument()
    expect(screen.getByText('Read-only', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/Next run:/)).toHaveTextContent(new Date(1700000000000).toLocaleString())
    const expand = screen.getByRole('button', { name: 'Show all' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(expand)
    expect(screen.getByText(definitions[0].prompt.trim())).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText(definitions[0].prompt.trim())).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable' })).toHaveAttribute('aria-checked', 'false'))
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
    expect(screen.getByTestId('routine-card')).toHaveTextContent('Paused')
  })

  it('requires trusted authorization again for the status toggle and honors denial', async () => {
    definitions = [{ ...routine, permissionMode: 'trusted-code' }]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RoutinesPage surface="code" />)
    await openTask()
    expect(screen.getByText('Trusted execution')).toBeInTheDocument()
    expect(screen.queryByText('Automatically approve')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.save', expect.anything())
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Pause' })).toBeEnabled())
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.save', expect.objectContaining({ confirmedExecution: true })))
  })

  it('keeps unknown executions locked until settled, including edit/delete/status and cancellation', async () => {
    render(<RoutinesPage surface="code" />)
    await openTask()
    const unknown = runRecord({ id: 'unknown', status: 'unknown', finishedAt: 1700000001000, output: '' })
    act(() => emit({ kind: 'run', run: unknown }))
    expect(screen.getByText(/Execution has not confirmed it stopped/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete routine' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Pause' })).toBeDisabled()
    fireEvent.click(screen.getByTestId('routine-run-row'))
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled()
    expect(screen.getByText(/Execution has not confirmed it stopped/)).toBeInTheDocument()
    act(() => emit({ kind: 'run', run: { ...unknown, executionSettledAt: 1700000002000 } }))
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
  })

  it('updates actual output from service events and cancels active work', async () => {
    render(<RoutinesPage surface="code" />)
    await openTask()
    const run = runRecord({ status: 'running', output: 'Inspecting code…' })
    act(() => emit({ kind: 'run', run }))
    expect(screen.getByRole('heading', { name: 'Running' })).toBeInTheDocument()
    expect(screen.getByText('Inspecting code…')).toBeInTheDocument()
    act(() => emit({ kind: 'run', run: { ...run, output: 'Actual new output' } }))
    expect(screen.getByText('Actual new output')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:routines.cancel', { runId: 'run-1' }))
  })

  it('navigates persisted output and all Runs, selects history, closes/reopens the panel, and treats session paths as text', async () => {
    ledger = [runRecord({ output: '# Saved result\n\n[local secret](file:///private/secret)\n\n![remote](https://example.com/image.png)', sessionFile: '/private/session.jsonl' }), runRecord({ id: 'skipped', scheduledAt: 1600000000000, status: 'skipped', output: '', skipReason: 'Concurrency limit' })]
    render(<RoutinesPage surface="code" />)
    await openTask()
    expect(screen.queryByRole('article', { name: 'Run output' })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('routine-run-row')).toHaveLength(2)
    expect(screen.getAllByLabelText('Output available')).toHaveLength(1)
    fireEvent.click(screen.getAllByTestId('routine-run-row')[0])
    const output = screen.getByRole('article', { name: 'Run output' })
    expect(within(output).getByRole('heading', { name: 'Saved result' })).toBeInTheDocument()
    expect(within(output).queryByRole('link')).not.toBeInTheDocument()
    expect(within(output).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('/private/session.jsonl').tagName).toBe('CODE')
    expect(screen.getAllByTestId('routine-run-row')[0]).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getAllByTestId('routine-run-row')[1])
    expect(within(screen.getByRole('article', { name: 'Run output' })).getByRole('heading', { name: 'Skipped' })).toBeInTheDocument()
    expect(screen.getByText('Concurrency limit')).toBeInTheDocument()
    expect(screen.getByText('No output yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close runs panel' }))
    expect(screen.queryByRole('complementary', { name: 'Runs' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(screen.getByRole('complementary', { name: 'Runs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/worker|workspace|session\./), expect.anything())
  })

  it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'interrupted', 'unknown'] as const)('preserves actual %s status and output, errors and truncation', async (status) => {
    const labels = { queued: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', interrupted: 'Interrupted', unknown: 'Outcome unknown' }
    ledger = [runRecord({ status, output: `Actual ${status} output`, error: status === 'failed' ? 'Actual failure' : undefined, outputTruncated: true })]
    render(<RoutinesPage surface="code" />)
    await openTask()
    fireEvent.click(screen.getByTestId('routine-run-row'))
    expect(within(screen.getByRole('article', { name: 'Run output' })).getByRole('heading', { name: labels[status] })).toBeInTheDocument()
    expect(screen.getByText(`Actual ${status} output`)).toBeInTheDocument()
    expect(screen.getByText('Stored output was truncated.')).toBeInTheDocument()
    if (status === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('Actual failure')
  })

  it('live output selects a manual dispatch event before the request resolves, then respects historical selection', async () => {
    ledger = [runRecord({ id: 'older', scheduledAt: 1600000000000, output: 'Older saved output' })]
    let resolveRun!: (value: { run: RoutineRun }) => void
    const defaultInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) => channel === 'ipc:routines.run' ? new Promise((resolve) => { resolveRun = resolve }) : defaultInvoke(channel, request))
    render(<RoutinesPage surface="code" />)
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    const run = runRecord({ status: 'running', output: '', trigger: 'manual' })
    act(() => emit({ kind: 'run', run }))
    expect(screen.getByRole('article', { name: 'Run output' })).toHaveTextContent('Running · waiting for output…')
    expect(screen.getAllByTestId('routine-run-row')[0]).toHaveTextContent('Running')
    act(() => emit({ kind: 'run', run: { ...run, output: 'Real partial text' } }))
    expect(screen.getByText('Real partial text')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('routine-run-row')[1])
    expect(screen.getByText('Older saved output')).toBeInTheDocument()
    await act(async () => resolveRun({ run }))
    expect(screen.getByText('Older saved output')).toBeInTheDocument()
    expect(screen.queryByText('Real partial text')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('routine-run-row')[0])
    expect(screen.getByText('Real partial text')).toBeInTheDocument() // stale dispatch response did not replace it
    act(() => emit({ kind: 'run', run: { ...run, status: 'succeeded', output: 'Real partial text ending' } }))
    expect(screen.getAllByText('Real partial text ending')).toHaveLength(1)
    expect(screen.queryByTestId('routine-live-status')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('routine-run-row')[0]).toHaveTextContent('Completed')
  })

  it('live output opens the immediate Run now result without waiting for any refresh or completion', async () => {
    render(<RoutinesPage surface="code" />)
    await openTask()
    const listsBefore = invoke.mock.calls.filter(([c]) => c === 'ipc:routines.list').length
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(await screen.findByRole('article', { name: 'Run output' })).toHaveTextContent('Running · waiting for output…')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled())
    expect(invoke.mock.calls.filter(([c]) => c === 'ipc:routines.list')).toHaveLength(listsBefore)
  })

  it('live output survives a stale initial list and a stale refresh for the same run', async () => {
    const defaultInvoke = invoke.getMockImplementation()!
    let resolveList!: (value: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    render(<RoutinesPage surface="code" />)
    const run = runRecord({ status: 'running', output: 'Partial before initial list' })
    act(() => emit({ kind: 'run', run }))
    await act(async () => resolveList({ routines: definitions, runs: [{ ...run, output: '' }], runtime: { kind: 'desktop-local', requiresAppOpen: true } }))
    await openTask()
    expect(screen.getByText('Partial before initial list')).toBeInTheDocument()
    invoke.mockImplementation((channel, request) => channel === 'ipc:routines.list' ? new Promise((resolve) => { resolveList = resolve }) : defaultInvoke(channel, request))
    act(() => emit({ kind: 'changed' }))
    act(() => emit({ kind: 'run', run: { ...run, status: 'succeeded', output: 'Final observed output' } }))
    await act(async () => resolveList({ routines: definitions, runs: [run], runtime: { kind: 'desktop-local', requiresAppOpen: true } }))
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeInTheDocument()
    expect(screen.getAllByText('Final observed output')).toHaveLength(1)
  })

  it('live output keeps background runs discoverable without stealing historical or other routine focus', async () => {
    definitions = [routine, { ...routine, id: 'second', name: 'Second routine' }]
    ledger = [runRecord({ output: 'Historical output' })]
    render(<RoutinesPage surface="code" />)
    fireEvent.click((await screen.findAllByTestId('routine-card'))[0])
    fireEvent.click(screen.getByTestId('routine-run-row'))
    const run = runRecord({ id: 'scheduled', scheduledAt: 1800000000000, status: 'running', trigger: 'scheduled', output: 'Background partial' })
    act(() => emit({ kind: 'run', run }))
    expect(screen.getByText('Historical output')).toBeInTheDocument()
    expect(screen.getAllByTestId('routine-run-row')[0]).toHaveTextContent('Running')
    fireEvent.click(screen.getAllByTestId('routine-run-row')[0])
    expect(screen.getByText('Background partial')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
    fireEvent.click(screen.getAllByTestId('routine-card')[1])
    act(() => emit({ kind: 'run', run: { ...run, output: 'Later background text' } }))
    expect(screen.queryByRole('article', { name: 'Run output' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Second routine')
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
    fireEvent.click(screen.getAllByTestId('routine-card')[0])
    expect(screen.getByText('Later background text')).toBeInTheDocument()
    act(() => emit({ kind: 'run', run: { ...run, status: 'succeeded', output: 'Background complete' } }))
    const next = { ...run, id: 'next-scheduled', scheduledAt: 1900000000000, output: '' }
    act(() => emit({ kind: 'run', run: next }))
    expect(screen.getByTestId('routine-live-status')).toHaveTextContent('waiting for output')
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    act(() => emit({ kind: 'run', run: { ...next, output: 'Still in details' } }))
    expect(screen.queryByRole('article', { name: 'Run output' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
  })

  it('live output follows near the bottom only and resets scroll when selecting another run', async () => {
    ledger = [runRecord({ id: 'older', scheduledAt: 1600000000000 })]
    render(<RoutinesPage surface="code" />)
    await openTask()
    const run = runRecord({ status: 'running', output: 'Start' })
    act(() => emit({ kind: 'run', run }))
    const output = screen.getByRole('article', { name: 'Run output' })
    Object.defineProperties(output, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    output.scrollTop = 800; fireEvent.scroll(output)
    act(() => emit({ kind: 'run', run: { ...run, output: 'Near bottom update' } }))
    expect(output.scrollTop).toBe(1000)
    output.scrollTop = 200; fireEvent.scroll(output)
    act(() => emit({ kind: 'run', run: { ...run, output: 'Scrolled away update' } }))
    expect(output.scrollTop).toBe(200)
    fireEvent.click(screen.getAllByTestId('routine-run-row')[1])
    expect(output.scrollTop).toBe(0)
    act(() => emit({ kind: 'run', run: { ...run, output: 'Historical view unchanged' } }))
    expect(output.scrollTop).toBe(0)
    expect(screen.getByText('Persisted result')).toBeInTheDocument()
  })

  it('locks conflicting controls while a request is pending and opens the returned real run', async () => {
    let resolveRun!: (value: { run: RoutineRun }) => void
    const defaultInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) => channel === 'ipc:routines.run' ? new Promise((resolve) => { resolveRun = resolve }) : defaultInvoke(channel, request))
    render(<RoutinesPage surface="code" />)
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete routine' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Pause' })).toBeDisabled()
    ledger = [runRecord({ status: 'running', output: 'From returned run' })]
    await act(async () => resolveRun({ run: ledger[0] }))
    expect(screen.getByText('From returned run')).toBeInTheDocument()
  })

  it('does not pretend an unavailable ledger is empty and retries the actual service', async () => {
    invoke.mockRejectedValueOnce(new Error('Ledger unavailable'))
    render(<RoutinesPage surface="code" />)
    expect(await screen.findByText('Tasks could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('No scheduled tasks yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('routine-card')).toHaveTextContent('Daily review')
  })

  it('deletes only after confirmation and returns to the actual list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RoutinesPage surface="code" />)
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }))
    expect(invoke).not.toHaveBeenCalledWith('ipc:routines.delete', expect.anything())
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }))
    await screen.findByText('No scheduled tasks yet')
    expect(invoke).toHaveBeenCalledWith('ipc:routines.delete', { id: routine.id })
    expect(screen.queryAllByTestId('routine-card')).toHaveLength(0)
  })

  it('shows service errors without changing the actual task and provides non-native icon tooltips', async () => {
    render(<RoutinesPage surface="code" />)
    await openTask()
    const edit = screen.getByRole('button', { name: 'Edit' })
    expect(edit).toHaveAttribute('data-app-tooltip', 'Edit')
    expect(edit).not.toHaveAttribute('title')
    invoke.mockRejectedValueOnce(new Error('Executor unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Executor unavailable')
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
