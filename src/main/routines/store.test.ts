import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineStore, type RoutineLedger } from './store'

let dir: string
const empty = (): RoutineLedger => ({ version: 2, routines: [], runs: [], consumed: {} })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routine-store-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('private atomic routine ledger', () => {
  it('persists independently and creates secure directory/file permissions', () => {
    const store = new RoutineStore(join(dir, 'routines'))
    expect(store.load()).toEqual(empty())
    store.save(empty())
    expect(new RoutineStore(join(dir, 'routines')).load()).toEqual(empty())
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'routines')).mode & 0o777).toBe(0o700)
      expect(statSync(store.file).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(join(dir, 'routines'))).toEqual(['ledger.json'])
  })
  it.each(['{bad-json', '{"version":999,"routines":[],"runs":[]}', '{"version":2,"routines":[],"runs":[],"consumed":{},"secret":"bad"}'])('fails closed on corrupt/unsupported data, without resetting it', (raw) => {
    const store = new RoutineStore(dir)
    writeFileSync(store.file, raw)
    expect(() => store.load()).toThrow(/corrupt/)
    expect(readFileSync(store.file, 'utf8')).toBe(raw)
    expect(() => store.save(empty())).toThrow(/disabled/)
  })
  it('atomically migrates explicit v1 ledgers to v2', () => {
    const store = new RoutineStore(dir)
    const routine = { id: 'routine-1', name: 'Test', description: '', prompt: 'Saved', surface: 'chat', permissionMode: 'read-only',
      enabled: true, schedule: { type: 'once', at: 10 }, createdAt: 0, updatedAt: 0, nextRunAt: 10 }
    writeFileSync(store.file, JSON.stringify({ version: 1, routines: [routine], runs: [
      { id: 'run-1', routineId: routine.id, scheduledAt: 10, status: 'failed', output: '', trigger: 'scheduled' },
      { id: 'run-2', routineId: routine.id, scheduledAt: 20, status: 'succeeded', output: '', trigger: 'manual' },
    ] }))
    expect(store.load().consumed).toEqual({ 'routine-1': 10 })
    expect(JSON.parse(readFileSync(store.file, 'utf8')).version).toBe(2)
    expect(store.load().runs).toHaveLength(2)
    expect(store.load().routines[0].onlineWeather).toBeUndefined()
  })
  it.each([undefined, false, true])('round-trips optional weather permission without changing old v2 records (%s)', (onlineWeather) => {
    const store = new RoutineStore(dir)
    const routine = { id: 'routine', name: 'Weather', description: '', prompt: 'latest Hangzhou weather', surface: 'chat', permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: 0, updatedAt: 0, ...(onlineWeather === undefined ? {} : { onlineWeather }) }
    writeFileSync(store.file, JSON.stringify({ ...empty(), routines: [routine] }))
    const ledger = store.load()
    expect(ledger.routines[0].onlineWeather).toBe(onlineWeather)
    store.save(ledger)
    expect(store.load().routines[0].onlineWeather).toBe(onlineWeather)
  })
  it.each([{ onlineWeather: 'true' }, { onlineWeather: 1 }, { weatherPermission: true }])('fails closed on invalid/unknown capability fields: %j', (patch) => {
    const store = new RoutineStore(dir)
    const routine = { id: 'routine', name: 'Weather', description: '', prompt: 'Weather', surface: 'chat', permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: 0, updatedAt: 0, ...patch }
    const raw = JSON.stringify({ ...empty(), routines: [routine] })
    writeFileSync(store.file, raw)
    expect(() => store.load()).toThrow(/corrupt/)
    expect(readFileSync(store.file, 'utf8')).toBe(raw)
  })
  it('does not clobber valid data on invalid transactions and stays failed closed', () => {
    const store = new RoutineStore(dir)
    store.save(empty())
    const original = readFileSync(store.file, 'utf8')
    expect(() => store.save({ ...empty(), consumed: { orphan: 3 } })).toThrow(/disabled/)
    expect(readFileSync(store.file, 'utf8')).toBe(original)
    expect(() => store.save(empty())).toThrow(/disabled/)
    expect(readdirSync(dir)).toEqual(['ledger.json'])
  })
  it('fails closed on I/O failures', () => {
    const store = new RoutineStore(dir)
    mkdirSync(store.file)
    expect(() => store.save(empty())).toThrow(/disabled/)
    expect(() => store.save(empty())).toThrow(/disabled/)
  })
  it('rejects symlinked store directories and ledger files (including dangling symlinks)', () => {
    const store = new RoutineStore(dir)
    symlinkSync(join(dir, 'missing'), store.file)
    expect(() => store.load()).toThrow(/corrupt/)
    const link = join(dir, 'linked-dir')
    symlinkSync(dir, link, 'dir')
    expect(() => new RoutineStore(link)).toThrow(/Unsafe/)
  })
})
