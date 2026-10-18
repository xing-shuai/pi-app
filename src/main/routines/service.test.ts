import { mkdtempSync, rmSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine, RoutineEvent } from '../../../packages/shared/routine-types'
import { RoutineService, type RoutineClock, type RoutineExecution, type RoutineExecutionResult, type RoutineExecutor } from './service'
import { RoutineStore } from './store'
import { CATCHUP_WINDOW, DAY } from './schedule'
import { MAX_OUTPUT_BYTES, MAX_RUNS } from './validation'

const NOW = Date.parse('2026-05-01T08:00Z')
function draft(patch: Partial<Routine> = {}): Routine {
  return { id: '', name: 'Routine', description: '', prompt: 'Do this saved task', surface: 'chat',
    permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: 0, updatedAt: 0, ...patch }
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve() }
let dir: string
let services: RoutineService[]
let pending: Array<{ ctx: RoutineExecution; resolve: (result?: RoutineExecutionResult) => void }>
function setup(executor?: RoutineExecutor, duration?: number, onEvent?: (event: RoutineEvent) => void) {
  const store = new RoutineStore(join(dir, 'routines'))
  const execute = vi.fn(executor ?? ((ctx) => new Promise<RoutineExecutionResult | void>((resolve) => { pending.push({ ctx, resolve }) })))
  const service = new RoutineService(store, { executor: execute, maxDurationMs: duration, onEvent })
  services.push(service)
  return { service, store, execute }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  dir = mkdtempSync(join(tmpdir(), 'routine-service-')); services = []; pending = []
})
afterEach(async () => {
  for (const service of services) service.abortActive()
  for (const task of pending) task.resolve()
  await flush()
  vi.useRealTimers(); rmSync(dir, { recursive: true, force: true })
})

describe('durable desktop routine service', () => {
  it('does no execution during construction or saving; owns IDs and timestamps', () => {
    const { service, execute } = setup()
    const saved = service.save(draft({ id: 'client-draft-id', createdAt: 3, updatedAt: 5, nextRunAt: 1 }))
    expect(execute).not.toHaveBeenCalled()
    expect(saved.id).toMatch(/^[\da-f-]{36}$/)
    expect(saved.id).not.toBe('client-draft-id')
    expect(saved.createdAt).toBe(NOW)
    expect(saved.nextRunAt).toBeUndefined()
    vi.setSystemTime(NOW + 1)
    const updated = service.save({ ...saved, createdAt: 50, updatedAt: 90, name: 'Changed' })
    expect(updated.createdAt).toBe(NOW)
    expect(updated.updatedAt).toBe(NOW + 1)
    expect(updated.id).toBe(saved.id)
    expect(service.list().runtime).toEqual({ kind: 'desktop-local', requiresAppOpen: true })
  })
  it('validates model, sizes, Chat permissions and arbitrary cwd', () => {
    const { service } = setup()
    for (const patch of [
      { name: ' ' }, { prompt: '' }, { prompt: 'a'.repeat(65537) },
      { permissionMode: 'trusted-code' as const }, { cwd: dir }, { model: 'no-provider' },
      { schedule: { type: 'daily', time: '25:00', timezone: 'UTC' } as const },
      { schedule: { type: 'daily', time: '09:00', timezone: 'not-a-zone' } as const },
      { surface: 'code' as const, cwd: 'relative' }, { surface: 'code' as const, cwd: join(dir, 'missing') },
    ]) expect(() => service.save(draft(patch), true)).toThrow()
    expect(() => service.save({ ...draft(), sessionFile: '/tmp/not-allowed' })).toThrow()
  })
  it('persists only an explicit boolean Chat weather grant and never infers it from instructions', () => {
    const { service } = setup()
    const old = service.save(draft({ prompt: 'latest Hangzhou weather' }))
    expect(old.onlineWeather).toBeUndefined()
    const granted = service.save({ ...old, onlineWeather: true })
    expect(granted.onlineWeather).toBe(true)
    const restarted = new RoutineService(new RoutineStore(join(dir, 'routines')), { executor: async () => {} })
    services.push(restarted)
    expect(restarted.list().routines[0].onlineWeather).toBe(true)
    expect(service.save({ ...granted, onlineWeather: false }).onlineWeather).toBe(false)
    for (const patch of [{ onlineWeather: 'true' }, { onlineWeather: 1 }, { capabilities: ['weather'] }, { onlineWeather: true, surface: 'code', cwd: dir }]) {
      expect(() => service.save({ ...draft(), ...patch })).toThrow()
    }
  })
  it('requires acknowledgement on EVERY trusted-code save, including enable toggles', () => {
    const { service } = setup()
    const input = draft({ surface: 'code', cwd: dir, permissionMode: 'trusted-code' })
    expect(() => service.save(input)).toThrow(/full user filesystem and shell permissions/)
    const saved = service.save(input, true)
    expect(() => service.save({ ...saved, enabled: false })).toThrow(/every save/)
    expect(service.save({ ...saved, enabled: false }, true).enabled).toBe(false)
  })
  it('enforces two global executions and no per-routine overlap', async () => {
    const { service, execute } = setup()
    const a = service.save(draft()), b = service.save(draft()), c = service.save(draft())
    const runA = service.runNow(a.id)
    service.runNow(b.id)
    expect(service.runNow(c.id).skipReason).toMatch(/global-capacity/)
    expect(service.runNow(a.id).skipReason).toMatch(/routine-active/)
    await flush()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(service.activeWork()).toHaveLength(2)
    expect(() => service.delete(a.id)).toThrow(/active/)
    expect(() => service.save({ ...a, prompt: 'Modified' })).toThrow(/definition/)
    service.save({ ...a, enabled: false })
    expect(pending[0].ctx.routine.enabled).toBe(true)
    pending[0].resolve({ output: 'done' }); await flush()
    expect(service.history(a.id).find((r) => r.id === runA.id)?.status).toBe('succeeded')
    expect(service.activeWork()).toHaveLength(1)
    service.delete(a.id)
    expect(service.history(a.id)).toHaveLength(2)
  })
  it('runs disabled routines manually without enabling their schedule', async () => {
    const { service, execute } = setup(async () => ({ output: 'manual' }))
    const routine = service.save(draft({ enabled: false, schedule: { type: 'once', at: NOW } }))
    service.tick(); expect(execute).not.toHaveBeenCalled()
    service.runNow(routine.id); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.list().routines[0].nextRunAt).toBeUndefined()
  })
  it('catches up only latest; records coalesced skips and never bursts or repeats on restart', async () => {
    const { service, execute, store } = setup(async () => ({ output: 'ok' }))
    service.save(draft({ schedule: { type: 'daily', time: '09:00', timezone: 'UTC' } }))
    vi.setSystemTime(NOW + 90 * DAY + 2 * 3_600_000)
    service.tick(); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.history().map((r) => r.status)).toEqual(['skipped', 'succeeded'])
    expect(service.history()[0].skipReason).toMatch(/superseded/)
    const due = NOW + 90 * DAY + 3_600_000
    expect(service.history()[1].scheduledAt).toBe(due)
    service.tick(); await flush(); expect(execute).toHaveBeenCalledTimes(1)
    const secondExecutor = vi.fn(async () => {})
    const restarted = new RoutineService(store, { executor: secondExecutor }); services.push(restarted)
    restarted.tick(); await flush(); expect(secondExecutor).not.toHaveBeenCalled()
  })
  it('allows a once catchup exactly seven days late but expires older tasks', async () => {
    const { service, execute } = setup(async () => {})
    service.save(draft({ schedule: { type: 'once', at: NOW - CATCHUP_WINDOW } }))
    service.save(draft({ schedule: { type: 'once', at: NOW - CATCHUP_WINDOW - 1 } }))
    service.tick(); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.history().find((r) => r.status === 'skipped')?.skipReason).toMatch(/expired/)
    service.tick(); expect(service.history()).toHaveLength(2)
  })
  it('consumes scheduled overlap and capacity skips permanently', async () => {
    const { service } = setup()
    const a = service.save(draft({ schedule: { type: 'once', at: NOW } }))
    const b = service.save(draft())
    service.save(draft({ schedule: { type: 'once', at: NOW } }))
    service.runNow(a.id); service.runNow(b.id)
    service.tick(); await flush()
    const skipped = service.history().filter((r) => r.status === 'skipped')
    expect(skipped.map((r) => r.skipReason)).toEqual([expect.stringContaining('routine-active'), expect.stringContaining('global-capacity')])
    pending.forEach((p) => p.resolve()); await flush(); service.tick(); await flush()
    expect(service.history()).toHaveLength(4)
  })
  it('does not retry failed side effects except an explicit Run now', async () => {
    const { service, execute } = setup(async () => { throw new Error('secret-token-must-not-leak') })
    const routine = service.save(draft({ schedule: { type: 'once', at: NOW } }))
    service.tick(); await flush(); service.tick(); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.history()[0].error).not.toContain('secret-token')
    expect(service.history()[0].status).toBe('failed')
    service.runNow(routine.id); await flush(); expect(execute).toHaveBeenCalledTimes(2)
  })
  it('marks old running executions interrupted without replaying them', async () => {
    const { service, store } = setup()
    service.save(draft({ schedule: { type: 'once', at: NOW } }))
    service.tick(); await flush()
    const execute = vi.fn(async () => {})
    const restarted = new RoutineService(store, { executor: execute }); services.push(restarted)
    expect(restarted.history()[0].status).toBe('interrupted')
    restarted.tick(); await flush(); expect(execute).not.toHaveBeenCalled()
  })
  it('keeps timeout locks until the real executor settles, then retains unknown outcome', async () => {
    const { service } = setup(undefined, 1000)
    const routine = service.save(draft())
    const run = service.runNow(routine.id); await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pending[0].ctx.signal.aborted).toBe(true)
    expect(service.history()[0].status).toBe('unknown')
    expect(service.hasActiveRuns).toBe(true)
    expect(service.runNow(routine.id).status).toBe('skipped')
    expect(() => service.delete(routine.id)).toThrow(/active/)
    pending[0].resolve(); await flush()
    expect(service.hasActiveRuns).toBe(false)
    expect(service.history().find((r) => r.id === run.id)?.status).toBe('unknown')
    expect(service.history().find((r) => r.id === run.id)?.executionSettledAt).toBe(NOW + 1000)
    expect(service.runNow(routine.id).status).toBe('running')
  })
  it('cancels cooperatively without releasing the active lock early', async () => {
    const { service } = setup()
    const routine = service.save(draft()), run = service.runNow(routine.id)
    await flush(); service.cancel(run.id)
    expect(pending[0].ctx.signal.aborted).toBe(true)
    expect(service.hasActiveRuns).toBe(true)
    pending[0].resolve(); await flush()
    expect(service.history()[0].status).toBe('cancelled')
    expect(service.hasActiveRuns).toBe(false)
  })
  it('prevents an already-cancelled dispatch from calling the executor', async () => {
    const { service, execute } = setup()
    const run = service.runNow(service.save(draft()).id)
    service.cancel(run.id); await flush()
    expect(execute).not.toHaveBeenCalled()
    expect(service.history()[0].status).toBe('cancelled')
  })
  it('streams coalesced ordered partial snapshots before resolve and replaces final output without duplication', async () => {
    const events: RoutineEvent[] = []
    const { service, store } = setup(undefined, undefined, (e) => events.push(e))
    const run = service.runNow(service.save(draft()).id)
    await flush()
    const task = pending[0]
    for (const text of ['Actual ', 'assistant ', 'text']) task.ctx.onOutput(text)
    expect(service.history()[0].output).toBe('Actual assistant text')
    expect(events.filter((e) => e.kind === 'run')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    const partial = events.filter((e) => e.kind === 'run').at(-1)
    expect(partial).toMatchObject({ run: { id: run.id, status: 'running', output: 'Actual assistant text' } })
    expect(service.hasActiveRuns).toBe(true)
    task.ctx.onOutput(' ending')
    task.resolve({ output: 'Actual assistant text ending' }); await flush()
    await vi.advanceTimersByTimeAsync(100)
    const runs = events.filter((e) => e.kind === 'run')
    expect(runs).toHaveLength(3) // dispatch, coalesced partial, final; no stale timer event
    expect(runs.at(-1)).toMatchObject({ run: { status: 'succeeded', output: 'Actual assistant text ending' } })
    expect(partial).toMatchObject({ run: { output: 'Actual assistant text' } }) // immutable snapshot
    expect(new RoutineStore(join(dir, 'routines')).load().runs[0].output).toBe('Actual assistant text ending')
    expect(readFileSync(store.file, 'utf8')).toContain('Actual assistant text ending')
    task.ctx.onOutput('late callback')
    expect(service.history()[0].output).toBe('Actual assistant text ending')
  })
  it('bounds streamed output and flushes it on stop while retaining settlement locks', async () => {
    const events: RoutineEvent[] = []
    const { service } = setup(undefined, undefined, (e) => events.push(e))
    const run = service.runNow(service.save(draft()).id); await flush()
    pending[0].ctx.onOutput('🙂'.repeat(MAX_OUTPUT_BYTES))
    pending[0].ctx.onOutput('discarded')
    service.cancel(run.id)
    const stopped = events.filter((e) => e.kind === 'run').at(-1)
    expect(stopped).toMatchObject({ run: { status: 'unknown', outputTruncated: true } })
    expect(Buffer.byteLength(service.history()[0].output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(service.hasActiveRuns).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(events.filter((e) => e.kind === 'run')).toHaveLength(2)
    pending[0].resolve(); await flush()
    expect(service.history()[0]).toMatchObject({ status: 'cancelled', outputTruncated: true })
    expect(service.history()[0].output).not.toContain('discarded')
  })
  it('bounds UTF-8 output and retains a bounded ledger with durable cursors', async () => {
    let calls = 0
    const { service, store } = setup(async ({ onOutput }) => { onOutput(calls++ === 0 ? '🙂'.repeat(MAX_OUTPUT_BYTES) : 'ok'); return {} })
    const routine = service.save(draft({ schedule: { type: 'once', at: NOW } }))
    service.tick(); await flush()
    expect(Buffer.byteLength(service.history()[0].output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(service.history()[0].outputTruncated).toBe(true)
    for (let n = 0; n < MAX_RUNS + 5; n++) { service.runNow(routine.id); await flush() }
    expect(service.history()).toHaveLength(MAX_RUNS)
    expect(JSON.parse(readFileSync(store.file, 'utf8')).consumed[routine.id]).toBe(NOW)
    const execute = vi.fn(async () => {})
    const restarted = new RoutineService(store, { executor: execute }); services.push(restarted)
    restarted.tick(); await flush(); expect(execute).not.toHaveBeenCalled()
  })
  it('ticks every 30s, is idempotent, and shuts down without claiming abort has settled', async () => {
    const { service, execute } = setup()
    service.save(draft({ schedule: { type: 'once', at: NOW + 30_000 } }))
    service.start(); service.start(); expect(execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000); expect(execute).toHaveBeenCalledTimes(1)
    const closing = service.shutdown(100)
    expect(pending[0].ctx.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(await closing).toEqual({ settled: false })
    expect(service.hasActiveRuns).toBe(true)
    expect(() => service.runNow('anything')).toThrow(/shutting down/)
    pending[0].resolve(); await flush()
    expect(await service.shutdown()).toEqual({ settled: true })
  })
  it('accepts a fully injected clock and unrefs both tick and execution timers', async () => {
    let now = 1_000_000
    let intervalCallback!: () => void, timeoutCallback!: () => void
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>
    const clock: RoutineClock = {
      now: () => now,
      setInterval: vi.fn((fn) => { intervalCallback = fn; return timer }),
      setTimeout: vi.fn((fn) => { timeoutCallback = fn; return timer }),
      clearInterval: vi.fn(), clearTimeout: vi.fn(),
    }
    let finish!: () => void
    const service = new RoutineService(new RoutineStore(join(dir, 'injected')), {
      clock, executor: () => new Promise<void>((resolve) => { finish = resolve }),
    }); services.push(service)
    const saved = service.save(draft({ schedule: { type: 'once', at: now + 30_000 } }))
    expect(saved.createdAt).toBe(now)
    service.start(); now += 30_000; intervalCallback(); await flush()
    expect(service.hasActiveRuns).toBe(true)
    expect(clock.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000)
    expect(clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 600_000)
    expect(timer.unref).toHaveBeenCalledTimes(2)
    timeoutCallback()
    expect(service.history()[0].status).toBe('unknown')
    expect(service.hasActiveRuns).toBe(true)
    finish(); await flush(); expect(service.hasActiveRuns).toBe(false)
  })
  it('never begins execution if the pre-execution durable commit fails', async () => {
    const { service, store, execute } = setup()
    const routine = service.save(draft())
    unlinkSync(store.file); mkdirSync(store.file)
    expect(() => service.runNow(routine.id)).toThrow(/disabled/)
    await flush(); expect(execute).not.toHaveBeenCalled()
    expect(() => service.list()).toThrow(/disabled/)
    expect(service.hasActiveRuns).toBe(false)
  })
  it('does not replay when the wall clock goes backward', async () => {
    const { service, execute } = setup(async () => {})
    service.save(draft({ schedule: { type: 'daily', time: '09:00', timezone: 'UTC' } }))
    vi.setSystemTime(NOW + 3_600_000); service.tick(); await flush()
    vi.setSystemTime(NOW); service.tick(); await flush()
    vi.setSystemTime(NOW + 3_600_000); service.tick(); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
