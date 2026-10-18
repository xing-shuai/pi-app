import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Routine, RoutineRun } from '../../../packages/shared/routine-types'
import { MAX_ROUTINES, MAX_RUNS, routineSchema, runSchema, timestamp } from './validation'

const MAX_STORE_BYTES = 32 * 1024 * 1024
const fields = {
  routines: z.array(routineSchema).max(MAX_ROUTINES),
  runs: z.array(runSchema).max(MAX_RUNS),
}
const schema = z.object({
  version: z.literal(2), ...fields,
  // Durable high-water marks outlive bounded history. Failed/skipped occurrences are consumed too.
  consumed: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), timestamp),
}).strict().superRefine((data, ctx) => {
  for (const list of [data.routines, data.runs]) {
    if (new Set(list.map((r) => r.id)).size !== list.length) ctx.addIssue({ code: 'custom', message: 'Duplicate IDs' })
  }
  if (Object.keys(data.consumed).some((id) => !data.routines.some((r) => r.id === id))) {
    ctx.addIssue({ code: 'custom', message: 'Orphan schedule cursor' })
  }
})
export interface RoutineLedger {
  version: 2
  routines: Routine[]
  runs: RoutineRun[]
  consumed: Record<string, number>
}

export function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Unsafe routine directory')
  chmodSync(path, 0o700)
}

/** One desktop process owns this store. All writes are synchronous atomic transactions. */
export class RoutineStore {
  readonly file: string
  private failed = false
  constructor(directory: string) {
    secureDirectory(directory)
    this.file = join(directory, 'ledger.json')
  }

  load(): RoutineLedger {
    try {
      let stat: ReturnType<typeof lstatSync>
      try { stat = lstatSync(this.file) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, routines: [], runs: [], consumed: {} }
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error('Invalid store file')
      chmodSync(this.file, 0o600)
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof raw === 'object' && raw && 'version' in raw && raw.version === 1) {
        const old = z.object({ version: z.literal(1), ...fields }).strict().parse(raw)
        const consumed: Record<string, number> = {}
        for (const run of old.runs) {
          if (run.trigger !== 'manual' && old.routines.some((r) => r.id === run.routineId)) {
            consumed[run.routineId] = Math.max(consumed[run.routineId] ?? 0, run.scheduledAt)
          }
        }
        const migrated = schema.parse({ ...old, version: 2, consumed })
        this.save(migrated)
        return migrated
      }
      return schema.parse(raw)
    } catch {
      this.failed = true
      throw new Error('Routine store is corrupt or inaccessible; execution is disabled. Restore the ledger before restarting. The original file was not reset.')
    }
  }

  save(ledger: RoutineLedger): void {
    if (this.failed) throw new Error('Routine store is disabled after an I/O or validation failure')
    const temp = `${this.file}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      const data = JSON.stringify(schema.parse(ledger))
      if (Buffer.byteLength(data) > MAX_STORE_BYTES) throw new Error('Routine store size limit')
      if (existsSync(this.file) && !lstatSync(this.file).isFile()) throw new Error('Unsafe ledger file')
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, data, 'utf8')
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(temp, this.file)
      // Directory fsync makes the rename durable on POSIX. Windows doesn't support it.
      if (process.platform !== 'win32') {
        fd = openSync(dirname(this.file), 'r')
        fsyncSync(fd)
        closeSync(fd); fd = undefined
      }
    } catch {
      this.failed = true
      throw new Error('Routine ledger could not be durably saved; execution is disabled')
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
}
