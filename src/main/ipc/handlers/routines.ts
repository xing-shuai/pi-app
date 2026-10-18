import { z } from 'zod'
import { registerHandlerWithSchema } from '../registry'
import { getRoutineService, startRoutineRuntime } from '../../routines/runtime'

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
/** Registration only: parent owns preload, allowlist/method maps, and UI integration. */
export function registerRoutineHandlers(): void {
  registerHandlerWithSchema('ipc:routines.list', z.object({}).strict().default({}), async () => getRoutineService().list())
  registerHandlerWithSchema('ipc:routines.save', z.object({
    routine: z.unknown(), confirmedExecution: z.boolean().optional(),
  }).strict(), async ({ routine, confirmedExecution }) => ({ routine: getRoutineService().save(routine, confirmedExecution) }))
  registerHandlerWithSchema('ipc:routines.delete', z.object({ id }).strict(), async ({ id }) => {
    getRoutineService().delete(id)
    return { ok: true }
  })
  registerHandlerWithSchema('ipc:routines.run', z.object({ id }).strict(), async ({ id }) => ({ run: getRoutineService().runNow(id) }))
  registerHandlerWithSchema('ipc:routines.cancel', z.object({ runId: id }).strict(), async ({ runId }) => {
    getRoutineService().cancel(runId)
    return { ok: true }
  })
  void startRoutineRuntime().catch(() => {
    console.error('[Routines] Local runtime could not start; scheduling is disabled. Inspect the private routine ledger.')
  })
}

export { getRoutineService, hasActiveRoutineRuns, routineRuntime, startRoutineRuntime } from '../../routines/runtime'
