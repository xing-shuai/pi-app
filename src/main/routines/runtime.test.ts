import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(), whenReady: vi.fn(), once: vi.fn(), send: vi.fn(), loadExecutor: vi.fn(), execute: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: mocks.getPath, whenReady: mocks.whenReady, once: mocks.once } }))
vi.mock('../window', () => ({ getMainWindow: () => ({
  isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send },
}) }))
vi.mock('./executor', () => ({ createSdkRoutineExecutor: mocks.loadExecutor }))
let dir: string
let runtime: typeof import('./runtime')
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve() }
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(1_000_000)
  dir = mkdtempSync(join(tmpdir(), 'routine-runtime-'))
  mocks.getPath.mockReturnValue(dir); mocks.whenReady.mockResolvedValue(undefined)
  mocks.loadExecutor.mockReturnValue(mocks.execute)
  mocks.execute.mockImplementation(({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })))
  runtime = await import('./runtime')
})
afterEach(async () => {
  runtime.routineRuntime.abortActive(); await flush()
  vi.useRealTimers(); rmSync(dir, { recursive: true, force: true })
})

describe('lazy Electron routine lifecycle', () => {
  it('exports safe close-guard accessors without resolving app paths or constructing executors', () => {
    expect(runtime.hasActiveRoutineRuns()).toBe(false)
    expect(runtime.routineRuntime.activeWork()).toEqual([])
    expect(runtime.routineRuntime.hasActiveRuns).toBe(false)
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(mocks.loadExecutor).not.toHaveBeenCalled()
  })
  it('starts after app ready, emits only ipc:routine-event, and aborts safely on will-quit', async () => {
    const startup = runtime.startRoutineRuntime()
    expect(runtime.startRoutineRuntime()).toBe(startup)
    await startup
    expect(mocks.once).toHaveBeenCalledOnce()
    expect(mocks.once.mock.calls[0][0]).toBe('will-quit')
    expect(mocks.execute).not.toHaveBeenCalled()
    const service = runtime.getRoutineService()
    const routine = service.save({ id: '', name: 'Saved', description: '', prompt: 'Task', surface: 'chat', permissionMode: 'read-only',
      enabled: true, schedule: { type: 'once', at: 1_030_000 }, createdAt: 0, updatedAt: 0 })
    await flush()
    expect(mocks.send).toHaveBeenCalledWith('ipc:routine-event', { kind: 'changed' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(runtime.routineRuntime.activeWork()[0].routineId).toBe(routine.id)
    expect(runtime.hasActiveRoutineRuns()).toBe(true)
    mocks.once.mock.calls[0][1]()
    expect(mocks.execute.mock.calls[0][0].signal.aborted).toBe(true)
    await flush()
    expect(runtime.hasActiveRoutineRuns()).toBe(false)
    expect(mocks.send.mock.calls.every(([channel]) => channel === 'ipc:routine-event')).toBe(true)
  })
  it('caches startup corruption failures without resetting the store or dispatching', async () => {
    mkdirSync(join(dir, 'routines')); writeFileSync(join(dir, 'routines', 'ledger.json'), 'corrupt')
    await expect(runtime.startRoutineRuntime()).rejects.toThrow(/corrupt/)
    expect(() => runtime.getRoutineService()).toThrow(/corrupt/)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(runtime.hasActiveRoutineRuns()).toBe(false)
  })
})
