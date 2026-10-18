import { randomUUID } from 'node:crypto'
import type { Routine, RoutineEvent, RoutineRun } from '../../../packages/shared/routine-types'
import { ROUTINE_RUNTIME } from '../../../packages/shared/routine-types'
import { CATCHUP_WINDOW, latestDue, nextOccurrence } from './schedule'
import { RoutineStore, type RoutineLedger } from './store'
import { MAX_OUTPUT_BYTES, MAX_ROUTINES, MAX_RUNS, validateSave } from './validation'

type Timer = ReturnType<typeof setTimeout>
export interface RoutineClock {
  now(): number
  setTimeout(fn: () => void, ms: number): Timer
  clearTimeout(timer: Timer): void
  setInterval(fn: () => void, ms: number): Timer
  clearInterval(timer: Timer): void
}
export const systemClock: RoutineClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (timer) => clearInterval(timer),
}
export interface RoutineExecution {
  routine: Routine
  run: RoutineRun
  signal: AbortSignal
  onOutput(text: string): void
  onSessionFile(path: string): void
}
export interface RoutineExecutionResult { output?: string; sessionFile?: string }
/** Must settle only after actual execution stops, including abort cleanup. */
export type RoutineExecutor = (execution: RoutineExecution) => Promise<RoutineExecutionResult | void>
interface ActiveRun {
  run: RoutineRun
  controller: AbortController
  timer?: Timer
  outputTimer?: Timer
  done: Promise<void>
  resolve(): void
  cancelReason?: 'timeout' | 'cancelled' | 'shutdown'
  output: string
  truncated: boolean
}

export function boundOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return { text, truncated: false }
  // Avoid replacement characters expanding the final byte count at a UTF-8 boundary.
  let bytes = Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES)
  while (bytes.length && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes = bytes.subarray(0, bytes.length - 1)
  if (bytes.length && bytes[bytes.length - 1] >= 0xc0) bytes = bytes.subarray(0, bytes.length - 1)
  return { text: bytes.toString('utf8'), truncated: true }
}
const clone = <T>(value: T): T => structuredClone(value)

export class RoutineService {
  private ledger: RoutineLedger
  private readonly clock: RoutineClock
  private readonly execute: RoutineExecutor
  private readonly emit: (event: RoutineEvent) => void
  private readonly maxDurationMs: number
  private readonly onPrunedRuns: (runs: RoutineRun[]) => void
  private interval?: Timer
  private active = new Map<string, ActiveRun>()
  private stopped = false
  private failed = false

  constructor(private readonly store: RoutineStore, options: {
    executor: RoutineExecutor
    clock?: RoutineClock
    onEvent?: (event: RoutineEvent) => void
    maxDurationMs?: number
    onPrunedRuns?: (runs: RoutineRun[]) => void
  }) {
    this.clock = options.clock ?? systemClock
    this.execute = options.executor
    this.onPrunedRuns = options.onPrunedRuns ?? (() => {})
    this.emit = (event) => { try { options.onEvent?.(clone(event)) } catch { /* Closed renderer must not affect execution. */ } }
    this.maxDurationMs = options.maxDurationMs ?? 10 * 60_000
    if (!Number.isFinite(this.maxDurationMs) || this.maxDurationMs < 1 || this.maxDurationMs > 86_400_000) throw new Error('Invalid routine duration')
    this.ledger = store.load()
    let changed = false
    for (const run of this.ledger.runs) {
      if (run.status === 'running' || run.status === 'queued' || (run.status === 'unknown' && run.executionSettledAt === undefined)) {
        run.status = 'interrupted'
        run.finishedAt = this.clock.now()
        run.error = 'Desktop restarted before execution settled. Effects may have occurred; use Run now explicitly to retry.'
        changed = true
      }
    }
    for (const routine of this.ledger.routines) {
      const consumed = this.ledger.consumed[routine.id]
      if (consumed !== undefined && routine.nextRunAt !== undefined && routine.nextRunAt <= consumed) {
        routine.nextRunAt = nextOccurrence(routine.schedule, consumed)
        changed = true
      }
    }
    if (changed) this.persist()
    // No SDK loading, timers, or model calls in the constructor.
  }

  private assertAvailable(): void {
    if (this.failed) throw new Error('Routine execution disabled after a ledger failure')
    if (this.stopped) throw new Error('Routine runtime is shutting down')
  }
  private persist(): void {
    // Never evict a live lock's run, including unknown executions.
    const live = new Set([...this.active.keys()])
    const protectedRuns = this.ledger.runs.filter((r) => live.has(r.id))
    const terminal = this.ledger.runs.filter((r) => !live.has(r.id)).slice(-(MAX_RUNS - protectedRuns.length))
    const retained = [...terminal, ...protectedRuns].sort((a, b) => a.scheduledAt - b.scheduledAt)
    const removed = this.ledger.runs.filter((r) => !retained.includes(r))
    this.ledger.runs = retained
    try { this.store.save(this.ledger) } catch (error) {
      this.failed = true
      this.abortActive()
      throw error
    }
    // Cleanup happens only AFTER the new ledger is durable. Cleanup failure cannot restart a task.
    if (removed.length) { try { this.onPrunedRuns(clone(removed)) } catch { /* Retried by startup cleanup. */ } }
  }
  private routine(id: string): Routine {
    const routine = this.ledger.routines.find((r) => r.id === id)
    if (!routine) throw new Error('Routine not found')
    return routine
  }
  list(): { routines: Routine[]; runs: RoutineRun[]; runtime: typeof ROUTINE_RUNTIME } {
    this.assertAvailable()
    return clone({ routines: this.ledger.routines, runs: this.ledger.runs, runtime: ROUTINE_RUNTIME })
  }
  history(routineId?: string): RoutineRun[] {
    this.assertAvailable()
    return clone(this.ledger.runs.filter((r) => !routineId || r.routineId === routineId))
  }
  save(input: unknown, confirmedExecution?: boolean): Routine {
    this.assertAvailable()
    const validated = validateSave(input, confirmedExecution)
    // Accept client-generated draft IDs, but never use them as persistent service IDs.
    const old = this.ledger.routines.find((r) => r.id === validated.id)
    if (!old && this.ledger.routines.length >= MAX_ROUTINES) throw new Error('Routine limit reached')
    const now = this.clock.now()
    const routine: Routine = { ...validated, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, updatedAt: now }
    const definition = (r: Routine) => {
      const { enabled: _enabled, createdAt: _created, updatedAt: _updated, nextRunAt: _next, ...rest } = r
      return rest
    }
    if (old && this.hasActiveRoutine(old.id) && JSON.stringify(definition(old)) !== JSON.stringify(definition(routine))) {
      throw new Error('An active routine definition cannot be edited; only its enabled flag may change')
    }
    const scheduleChanged = !old || JSON.stringify(old.schedule) !== JSON.stringify(routine.schedule)
    const reenabled = old && !old.enabled && routine.enabled
    if (!routine.enabled || routine.schedule.type === 'manual') routine.nextRunAt = undefined
    else if (scheduleChanged || reenabled) {
      const consumed = this.ledger.consumed[routine.id] ?? -1
      routine.nextRunAt = routine.schedule.type === 'once'
        ? nextOccurrence(routine.schedule, consumed)
        : nextOccurrence(routine.schedule, Math.max(now, consumed))
    } else routine.nextRunAt = old.nextRunAt
    if (old) this.ledger.routines[this.ledger.routines.indexOf(old)] = routine
    else this.ledger.routines.push(routine)
    this.persist()
    this.emit({ kind: 'changed' })
    return clone(routine)
  }
  delete(id: string): void {
    this.assertAvailable()
    const routine = this.routine(id)
    if (this.hasActiveRoutine(id)) throw new Error('Cannot delete an active routine')
    this.ledger.routines.splice(this.ledger.routines.indexOf(routine), 1)
    delete this.ledger.consumed[id]
    this.persist()
    this.emit({ kind: 'changed' })
  }
  private hasActiveRoutine(id: string): boolean {
    return [...this.active.values()].some((a) => a.run.routineId === id)
  }
  get hasActiveRuns(): boolean { return this.active.size > 0 }
  activeWork(): RoutineRun[] { return clone([...this.active.values()].map((a) => a.run)) }

  start(): void {
    this.assertAvailable()
    if (this.interval) return
    this.tick()
    this.interval = this.clock.setInterval(() => {
      try { this.tick() } catch { /* persist() already fails closed and aborts active work. */ }
    }, 30_000)
    this.interval.unref?.()
  }
  tick(): void {
    this.assertAvailable()
    const now = this.clock.now()
    for (const routine of this.ledger.routines) {
      if (!routine.enabled || routine.nextRunAt === undefined || routine.nextRunAt > now) continue
      const first = routine.nextRunAt
      const due = latestDue(routine.schedule, first, now)
      const coalesced = due !== first ? this.skipped(routine, first, 'superseded-misfires: older occurrences coalesced; only the latest may catch up') : undefined
      // Consume before calling executor; pruning history or restarting cannot re-dispatch this due.
      this.ledger.consumed[routine.id] = Math.max(this.ledger.consumed[routine.id] ?? -1, due)
      routine.nextRunAt = nextOccurrence(routine.schedule, Math.max(now, due))
      if (due < now - CATCHUP_WINDOW) {
        const skipped = this.skipped(routine, due, 'misfire-expired: more than seven days late')
        this.persist()
        this.emit({ kind: 'run', run: skipped })
      } else this.dispatch(routine, due, 'scheduled')
      if (coalesced) this.emit({ kind: 'run', run: coalesced })
      this.emit({ kind: 'changed' })
    }
  }
  runNow(id: string): RoutineRun {
    this.assertAvailable()
    return clone(this.dispatch(this.routine(id), this.clock.now(), 'manual'))
  }
  private skipped(routine: Routine, due: number, reason: string, trigger: 'manual' | 'scheduled' = 'scheduled'): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(), routineId: routine.id, scheduledAt: due,
      finishedAt: this.clock.now(), status: 'skipped', output: '', skipReason: reason, trigger,
    }
    this.ledger.runs.push(run)
    return run
  }
  private dispatch(routine: Routine, due: number, trigger: 'manual' | 'scheduled'): RoutineRun {
    const skipReason = this.hasActiveRoutine(routine.id) ? 'routine-active: no overlapping execution'
      : this.active.size >= 2 ? 'global-capacity: maximum two active executions' : undefined
    if (skipReason) {
      const run = this.skipped(routine, due, skipReason, trigger)
      this.persist()
      this.emit({ kind: 'run', run })
      return run
    }
    const run: RoutineRun = {
      id: randomUUID(), routineId: routine.id, scheduledAt: due, startedAt: this.clock.now(),
      status: 'running', output: '', trigger,
    }
    let resolve!: () => void
    const active: ActiveRun = {
      run, controller: new AbortController(), done: new Promise<void>((r) => { resolve = r }),
      resolve: () => resolve(), output: '', truncated: false,
    }
    this.active.set(run.id, active)
    this.ledger.runs.push(run)
    try { this.persist() } catch (error) { this.active.delete(run.id); active.resolve(); throw error }
    this.emit({ kind: 'run', run })
    active.timer = this.clock.setTimeout(() => this.requestStop(active, 'timeout'), this.maxDurationMs)
    active.timer.unref?.()
    // The immutable definition cannot be changed by subsequent UI edits.
    const execution = { routine: clone(routine), run: clone(run), signal: active.controller.signal, onSessionFile: (path: string) => {
      run.sessionFile = path
      if (!this.failed) this.persist()
    }, onOutput: (text: string) => {
      if (!text || active.truncated || this.failed || !this.active.has(run.id)) return
      const bounded = boundOutput(active.output + text)
      active.output = run.output = bounded.text
      active.truncated = run.outputTruncated = bounded.truncated
      // Full, ordered snapshots on the existing run channel: at most 10 updates/sec/run.
      // list/history see the latest text even before this coalesced event is delivered.
      if (!active.outputTimer) {
        active.outputTimer = this.clock.setTimeout(() => {
          active.outputTimer = undefined
          if (!this.failed && this.active.has(run.id)) this.emit({ kind: 'run', run })
        }, 100)
        active.outputTimer.unref?.()
      }
    } }
    void Promise.resolve().then(() => {
      execution.signal.throwIfAborted()
      return this.execute(execution)
    }).then(
      (result) => this.settle(active, result),
      () => this.settle(active, undefined, true),
    ).catch(() => { /* Persistence failure is fail-closed; never an unhandled rejection. */ })
    return run
  }
  private requestStop(active: ActiveRun, reason: ActiveRun['cancelReason']): void {
    if (active.cancelReason) return
    active.cancelReason = reason
    if (active.outputTimer) this.clock.clearTimeout(active.outputTimer)
    active.outputTimer = undefined
    active.run.status = 'unknown'
    active.run.error = reason === 'timeout'
      ? 'Run timed out; abort requested. Effects may have occurred. Lock retained until execution settles.'
      : 'Abort requested; execution has not yet settled. Effects may have occurred.'
    active.controller.abort()
    if (!this.failed) {
      try { this.persist(); this.emit({ kind: 'run', run: active.run }) } catch { /* Already disabled. */ }
    }
  }
  private settle(active: ActiveRun, result?: RoutineExecutionResult | void, failed = false): void {
    if (active.timer) this.clock.clearTimeout(active.timer)
    if (active.outputTimer) this.clock.clearTimeout(active.outputTimer)
    active.outputTimer = undefined
    const run = active.run
    run.executionSettledAt = this.clock.now()
    run.finishedAt = this.clock.now()
    if (active.cancelReason === 'timeout') {
      run.status = 'unknown'
      run.error = 'Run timed out. Execution has now settled, but its effects/outcome are unknown. Retry only with Run now.'
    }
    else if (active.cancelReason) { run.status = 'cancelled'; run.error = 'Execution stopped after abort. Prior side effects are not rolled back.' }
    else {
      run.status = failed ? 'failed' : 'succeeded'
      if (failed) run.error = 'Routine execution failed. Inspect the private run session; retry only with Run now.'
    }
    const bounded = boundOutput(result?.output ?? active.output)
    run.output = bounded.text
    run.outputTruncated = bounded.truncated || active.truncated
    if (result?.sessionFile) run.sessionFile = result.sessionFile
    // Release only here, never on timeout/abort request.
    this.active.delete(run.id)
    try {
      if (!this.failed) this.persist()
      this.emit({ kind: 'run', run })
    } finally { active.resolve() }
  }
  cancel(runId: string): void {
    this.assertAvailable()
    const active = this.active.get(runId)
    if (active) this.requestStop(active, 'cancelled')
    else if (!this.ledger.runs.some((r) => r.id === runId)) throw new Error('Run not found')
  }
  /** Synchronous quit hook; does not pretend abort means execution is stopped. */
  abortActive(): void {
    this.stopped = true
    if (this.interval) this.clock.clearInterval(this.interval)
    this.interval = undefined
    for (const active of this.active.values()) this.requestStop(active, 'shutdown')
  }
  async shutdown(waitMs = 5000): Promise<{ settled: boolean }> {
    this.abortActive()
    if (!this.hasActiveRuns) return { settled: true }
    let timer!: Timer
    const settled = await Promise.race([
      Promise.all([...this.active.values()].map((a) => a.done)).then(() => true),
      new Promise<boolean>((resolve) => { timer = this.clock.setTimeout(() => resolve(false), waitMs); timer.unref?.() }),
    ])
    this.clock.clearTimeout(timer)
    return { settled }
  }
}
