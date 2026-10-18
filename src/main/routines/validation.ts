import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { TRUSTED_CODE_NOTICE } from '../../../packages/shared/routine-types'
import type { Routine } from '../../../packages/shared/routine-types'

export const MAX_ROUTINES = 100
export const MAX_RUNS = 100
export const MAX_OUTPUT_BYTES = 250 * 1024
export const timestamp = z.number().int().min(0).max(8_000_000_000_000_000)
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
const zone = z.string().min(1).max(100).refine((value) => {
  if (/^[+-]/.test(value)) return false // Fixed-offset literals are not IANA timezone IDs.
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true } catch { return false }
}, 'Invalid IANA timezone')
const recurring = {
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: zone,
  dayOfWeek: z.number().int().min(0).max(6).optional(),
}
export const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({ type: z.literal('once'), at: timestamp }).strict(),
  z.object({ type: z.literal('daily'), ...recurring }).strict(),
  z.object({ type: z.literal('weekdays'), ...recurring }).strict(),
  z.object({ type: z.literal('weekly'), ...recurring, dayOfWeek: z.number().int().min(0).max(6) }).strict(),
])
export const routineSchema = z.object({
  id,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000),
  prompt: z.string().min(1).max(64 * 1024).refine((v) => v.trim().length > 0, 'Prompt is required'),
  surface: z.enum(['chat', 'code']),
  cwd: z.string().min(1).max(4096).optional(),
  model: z.string().min(3).max(500).regex(/^[^/\s]+\/\S+$/).optional(),
  permissionMode: z.enum(['read-only', 'trusted-code']),
  onlineWeather: z.boolean().optional(),
  enabled: z.boolean(),
  schedule: scheduleSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  nextRunAt: timestamp.optional(),
}).strict().superRefine((r, ctx) => {
  if (r.surface === 'chat' && (r.cwd !== undefined || r.permissionMode !== 'read-only')) {
    ctx.addIssue({ code: 'custom', message: 'Chat requires read-only permission and no cwd' })
  }
  if (r.surface !== 'chat' && r.onlineWeather === true) {
    ctx.addIssue({ code: 'custom', message: 'Online weather is a Chat-only capability' })
  }
  if (r.surface === 'code' && (!r.cwd || !isAbsolute(r.cwd))) {
    ctx.addIssue({ code: 'custom', message: 'Code requires an absolute project directory' })
  }
})
export const runSchema = z.object({
  id, routineId: id, scheduledAt: timestamp,
  startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'interrupted', 'unknown']),
  output: z.string().refine((v) => Buffer.byteLength(v) <= MAX_OUTPUT_BYTES),
  error: z.string().max(4096).optional(), sessionFile: z.string().max(8192).optional(),
  skipReason: z.string().max(4096).optional(), trigger: z.enum(['scheduled', 'manual']).optional(),
  executionSettledAt: timestamp.optional(), outputTruncated: z.boolean().optional(),
}).strict()

/** Filesystem validation is deliberately separate: unavailable projects don't corrupt the ledger. */
export function canonicalCodeDirectory(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error('Code requires an absolute project directory')
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error('Code cwd must exist and be a directory')
  return canonical
}

export function validateSave(input: unknown, confirmedExecution?: boolean): Routine {
  // IDs and timestamps are server-owned; empty/client-generated draft IDs create new records.
  const raw = z.object({ id: z.string().max(100) }).passthrough().parse(input)
  const result = routineSchema.parse({ ...raw, id: raw.id || 'new' })
  if (result.permissionMode === 'trusted-code' && confirmedExecution !== true) {
    throw new Error(`Explicit confirmation is required on every save. ${TRUSTED_CODE_NOTICE}`)
  }
  if (result.surface === 'code') result.cwd = canonicalCodeDirectory(result.cwd!)
  return { ...result, id: raw.id }
}
