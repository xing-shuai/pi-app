/** Routines execute only while the desktop process is running and the machine is awake. */
export type RoutineSchedule =
  | { type: 'manual' }
  | { type: 'once'; at: number }
  | { type: 'daily' | 'weekdays' | 'weekly'; time: string; timezone: string; dayOfWeek?: number }

export interface Routine {
  id: string
  name: string
  description: string
  prompt: string
  surface: 'chat' | 'code'
  cwd?: string
  /** provider/model; split at the FIRST slash. */
  model?: string
  permissionMode: 'read-only' | 'trusted-code'
  /** Explicit Chat-only grant. Missing/false on existing records means zero tools. */
  onlineWeather?: boolean
  enabled: boolean
  schedule: RoutineSchedule
  createdAt: number
  updatedAt: number
  nextRunAt?: number
}

export interface RoutineRun {
  id: string
  routineId: string
  scheduledAt: number
  startedAt?: number
  finishedAt?: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'interrupted' | 'unknown'
  output: string
  error?: string
  sessionFile?: string
  skipReason?: string
  trigger?: 'scheduled' | 'manual'
  /** A timeout/cancellation request is not proof that execution has stopped. */
  executionSettledAt?: number
  outputTruncated?: boolean
}

export const ROUTINE_EVENT_CHANNEL = 'ipc:routine-event'
export type RoutineEvent = { kind: 'changed' } | { kind: 'run'; run: RoutineRun }
export const ROUTINE_RUNTIME = { kind: 'desktop-local', requiresAppOpen: true } as const
export const TRUSTED_CODE_NOTICE = 'Trusted Code has full user filesystem and shell permissions. It is not a sandbox.'
export const READ_ONLY_CODE_NOTICE = 'Read-only Code is a tool policy, not a sandbox: read/grep/find/ls can read outside the project root. Bash, writes, extensions and MCP are disabled.'
