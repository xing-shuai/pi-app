import { describe, expect, it } from 'vitest'
import { CATCHUP_WINDOW, latestDue, nextOccurrence, wallTime } from './schedule'

const utc = (s: string) => Date.parse(s)
describe('local wall-clock schedules', () => {
  it('manual never becomes due; once is consumed strictly after its instant', () => {
    expect(nextOccurrence({ type: 'manual' }, 0)).toBeUndefined()
    expect(nextOccurrence({ type: 'once', at: 100 }, 99)).toBe(100)
    expect(nextOccurrence({ type: 'once', at: 100 }, 100)).toBeUndefined()
  })
  it('uses IANA timezone offsets, including quarter hours', () => {
    expect(nextOccurrence({ type: 'daily', time: '09:00', timezone: 'Asia/Kathmandu' }, utc('2026-05-01T00:00Z')))
      .toBe(utc('2026-05-01T03:15Z'))
  })
  it('skips weekend days and selects Sunday=0 weekly days', () => {
    expect(nextOccurrence({ type: 'weekdays', time: '09:00', timezone: 'UTC' }, utc('2026-05-01T09:00Z')))
      .toBe(utc('2026-05-04T09:00Z'))
    expect(nextOccurrence({ type: 'weekly', time: '09:00', timezone: 'UTC', dayOfWeek: 0 }, utc('2026-05-01T09:00Z')))
      .toBe(utc('2026-05-03T09:00Z'))
  })
  it('skips nonexistent spring-forward times rather than shifting the task', () => {
    expect(nextOccurrence({ type: 'daily', time: '02:30', timezone: 'America/New_York' }, utc('2026-03-07T07:30Z')))
      .toBe(utc('2026-03-09T06:30Z'))
    expect(wallTime(utc('2026-10-04T00:00Z'), '02:15', 'Australia/Lord_Howe')).toBeUndefined()
  })
  it('runs only the first repeated time during a fall-back fold', () => {
    const schedule = { type: 'daily', time: '01:30', timezone: 'America/New_York' } as const
    expect(nextOccurrence(schedule, utc('2026-11-01T00:00Z'))).toBe(utc('2026-11-01T05:30Z'))
    expect(nextOccurrence(schedule, utc('2026-11-01T05:30Z'))).toBe(utc('2026-11-02T06:30Z'))
  })
  it('coalesces months of missed occurrences to a single latest instant', () => {
    const schedule = { type: 'daily', time: '09:00', timezone: 'America/New_York' } as const
    const now = utc('2026-05-12T14:00Z')
    expect(latestDue(schedule, utc('2026-01-01T14:00Z'), now)).toBe(utc('2026-05-12T13:00Z'))
    expect(latestDue({ type: 'once', at: 1 }, 1, CATCHUP_WINDOW + 2)).toBe(1)
  })
  it('skips a date-line-deleted day', () => {
    expect(wallTime(utc('2011-12-30T00:00Z'), '09:00', 'Pacific/Apia')).toBeUndefined()
  })
})
