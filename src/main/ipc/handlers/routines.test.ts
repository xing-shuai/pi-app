import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodSchema } from 'zod'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  list: vi.fn(), save: vi.fn(), delete: vi.fn(), runNow: vi.fn(), cancel: vi.fn(), start: vi.fn(),
}))
vi.mock('../registry', () => ({ registerHandlerWithSchema: (channel: string, schema: ZodSchema, handler: (req: unknown) => Promise<unknown>) => {
  mocks.handlers.set(channel, async (req) => handler(schema.parse(req)))
} }))
vi.mock('../../routines/runtime', () => ({
  getRoutineService: () => mocks,
  startRoutineRuntime: mocks.start,
  hasActiveRoutineRuns: vi.fn(), routineRuntime: {},
}))
import { registerRoutineHandlers } from './routines'
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.start.mockResolvedValue(undefined)
  registerRoutineHandlers()
})
const invoke = (channel: string, req: unknown) => mocks.handlers.get(`ipc:routines.${channel}`)!(req)
describe('routine IPC owned contract', () => {
  it('registers five handlers and starts the runtime lifecycle', () => {
    expect([...mocks.handlers.keys()]).toEqual(['ipc:routines.list', 'ipc:routines.save', 'ipc:routines.delete', 'ipc:routines.run', 'ipc:routines.cancel'])
    expect(mocks.start).toHaveBeenCalledOnce()
  })
  it('returns the exact response wrappers and forwards explicit confirmation', async () => {
    const snapshot = { routines: [], runs: [], runtime: { kind: 'desktop-local', requiresAppOpen: true } }
    mocks.list.mockReturnValue(snapshot)
    expect(await invoke('list', {})).toEqual(snapshot)
    mocks.save.mockReturnValue({ id: 'server-owned' })
    expect(await invoke('save', { routine: { id: '' }, confirmedExecution: true })).toEqual({ routine: { id: 'server-owned' } })
    expect(mocks.save).toHaveBeenCalledWith({ id: '' }, true)
    mocks.runNow.mockReturnValue({ id: 'run' })
    expect(await invoke('run', { id: 'routine' })).toEqual({ run: { id: 'run' } })
    expect(await invoke('delete', { id: 'routine' })).toEqual({ ok: true })
    expect(await invoke('cancel', { runId: 'run' })).toEqual({ ok: true })
  })
  it('rejects malformed IDs, confirmation coercion, unknown fields and caller session paths', async () => {
    await expect(invoke('list', { sessionFile: '/tmp/evil' })).rejects.toThrow()
    await expect(invoke('run', { id: '../evil' })).rejects.toThrow()
    await expect(invoke('save', { routine: {}, confirmedExecution: 'true' })).rejects.toThrow()
    await expect(invoke('cancel', { runId: '' })).rejects.toThrow()
    await expect(invoke('save', { routine: {}, sessionFile: '/tmp/evil' })).rejects.toThrow()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
