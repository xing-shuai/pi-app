import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Only service-generated run directories are ever removed, not stored sessionFile paths.
const serviceRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function root(userData: string): string | undefined {
  const directory = join(userData, 'routine-runs')
  if (!existsSync(directory)) return undefined
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe routine session directory')
  return directory
}
export function removeRoutineSessions(userData: string, ids: string[]): void {
  const directory = root(userData)
  if (!directory) return
  for (const id of ids) {
    if (serviceRunId.test(id)) rmSync(join(directory, id), { recursive: true, force: true })
  }
}
/** Reclaims crash orphans too, without touching any interactive agent sessions. */
export function pruneRoutineSessions(userData: string, retainedIds: string[]): void {
  const directory = root(userData)
  if (!directory) return
  const retained = new Set(retainedIds)
  removeRoutineSessions(userData, readdirSync(directory).filter((id) => !retained.has(id)))
}
