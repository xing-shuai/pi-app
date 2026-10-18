import type { RoutineSchedule } from '../../../packages/shared/routine-types'

export const DAY = 86_400_000
export const CATCHUP_WINDOW = 7 * DAY
const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(at: number, timezone: string): number[] {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    if (formatters.size >= 128) formatters.clear()
    formatters.set(timezone, formatter)
  }
  const p = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]))
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)]
}
function wallStamp(p: number[]): number {
  return Date.UTC(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0, p[5] || 0)
}

/** DST policy: nonexistent wall times are skipped; folds choose the first instant only. */
export function wallTime(day: number, time: string, timezone: string): number | undefined {
  const [hour, minute] = time.split(':').map(Number)
  const target = day + hour * 3_600_000 + minute * 60_000
  const offsets = new Set<number>()
  // Sample both sides of a transition, including non-hour offsets and date-line jumps.
  for (let delta = -48; delta <= 48; delta += 6) {
    const at = target + delta * 3_600_000
    offsets.add(wallStamp(parts(at, timezone)) - at)
  }
  const matches = [...offsets].map((offset) => target - offset)
    .filter((at) => wallStamp(parts(at, timezone)) === target)
  return matches.length ? Math.min(...matches) : undefined
}

function occurrences(schedule: Exclude<RoutineSchedule, { type: 'manual' } | { type: 'once' }>, from: number, days: number): number[] {
  const p = parts(from, schedule.timezone)
  const firstDay = Date.UTC(p[0], p[1] - 1, p[2])
  const result: number[] = []
  for (let n = 0; n < days; n++) {
    const day = firstDay + n * DAY
    const dow = new Date(day).getUTCDay()
    if (schedule.type === 'weekdays' && (dow === 0 || dow === 6)) continue
    if (schedule.type === 'weekly' && dow !== schedule.dayOfWeek) continue
    const at = wallTime(day, schedule.time, schedule.timezone)
    if (at !== undefined) result.push(at)
  }
  return result
}

/** Strictly after `after`; undefined for manual/consumed once schedules. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | undefined {
  if (schedule.type === 'manual') return undefined
  if (schedule.type === 'once') return schedule.at > after ? schedule.at : undefined
  return occurrences(schedule, after, 16).find((at) => at > after)
}

/** Latest due within seven days, never before the already persisted next occurrence. */
export function latestDue(schedule: RoutineSchedule, firstDue: number, now: number): number {
  if (schedule.type === 'manual' || schedule.type === 'once') return firstDue
  const recent = occurrences(schedule, Math.max(firstDue, now - CATCHUP_WINDOW), 10)
    .filter((at) => at >= firstDue && at <= now)
  return recent.length ? recent[recent.length - 1] : firstDue
}
