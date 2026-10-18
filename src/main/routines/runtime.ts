import { app } from 'electron'
import { join } from 'node:path'
import { ROUTINE_EVENT_CHANNEL } from '../../../packages/shared/routine-types'
import { createSdkRoutineExecutor } from './executor'
import { RoutineService } from './service'
import { RoutineStore } from './store'
import { pruneRoutineSessions, removeRoutineSessions } from './sessions'

let service: RoutineService | undefined
let startupError: unknown
let starting: Promise<void> | undefined

/** Lazy: importing this module does not resolve Electron paths or import the SDK. */
export function getRoutineService(): RoutineService {
  if (startupError) throw startupError
  if (!service) {
    try {
      const userData = app.getPath('userData')
      service = new RoutineService(new RoutineStore(join(userData, 'routines')), {
        executor: createSdkRoutineExecutor(userData),
        maxDurationMs: process.env.PI_DESKTOP_ROUTINE_TIMEOUT_MS === undefined ? undefined : Number(process.env.PI_DESKTOP_ROUTINE_TIMEOUT_MS),
        onPrunedRuns: (runs) => removeRoutineSessions(userData, runs.map((run) => run.id)),
        onEvent: (event) => {
          if (event.kind === 'run' && ['succeeded', 'failed'].includes(event.run.status)) {
            const run = event.run
            let name = 'Routine'
            try { name = service?.list().routines.find((r) => r.id === run.routineId)?.name || name } catch { /* shutdown */ }
            void import('../product-notifications').then(({ notifyProductCompletion }) => notifyProductCompletion({ key: `routine:${run.id}`, title: name, failed: run.status === 'failed' })).catch(() => {})
          }
          // Avoid importing the window/interactive worker graph at routine module initialization.
          void import('../window').then(({ getMainWindow }) => {
            const window = getMainWindow()
            if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send(ROUTINE_EVENT_CHANNEL, event)
            }
          }).catch(() => {})
        },
      })
      try { pruneRoutineSessions(userData, service.list().runs.map((run) => run.id)) } catch { /* Private transcripts may remain if the OS denies cleanup. */ }
    } catch (error) { startupError = error; throw error }
  }
  return service
}

/** Parent can call at startup; also called by registerRoutineHandlers(). Idempotent. */
export function startRoutineRuntime(): Promise<void> {
  if (!starting) {
    app.once('will-quit', () => { service?.abortActive() })
    starting = app.whenReady().then(() => { getRoutineService().start() })
  }
  return starting
}
export function hasActiveRoutineRuns(): boolean { return service?.hasActiveRuns ?? false }
/** Close guard uses this facade without accidentally creating a store or an SDK runtime. */
export const routineRuntime = {
  get hasActiveRuns(): boolean { return hasActiveRoutineRuns() },
  activeWork: () => service?.activeWork() ?? [],
  startup: startRoutineRuntime,
  shutdown: async (waitMs?: number) => service ? service.shutdown(waitMs) : { settled: true },
  abortActive: () => service?.abortActive(),
}
