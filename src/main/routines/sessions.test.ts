import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { pruneRoutineSessions, removeRoutineSessions } from './sessions'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routine-session-cleanup-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
it('bounds private session history without accepting arbitrary paths or touching interactive sessions', () => {
  const keep = '00000000-0000-0000-0000-000000000001', stale = '00000000-0000-0000-0000-000000000002'
  for (const id of [keep, stale, 'not-a-run']) mkdirSync(join(dir, 'routine-runs', id), { recursive: true })
  mkdirSync(join(dir, 'interactive'))
  pruneRoutineSessions(dir, [keep])
  expect(existsSync(join(dir, 'routine-runs', keep))).toBe(true)
  expect(existsSync(join(dir, 'routine-runs', stale))).toBe(false)
  expect(existsSync(join(dir, 'routine-runs', 'not-a-run'))).toBe(true)
  removeRoutineSessions(dir, ['../interactive', join(dir, 'interactive')])
  expect(existsSync(join(dir, 'interactive'))).toBe(true)
})
it('does not follow symlinked run folders or a symlinked session root', () => {
  const target = join(dir, 'target'); mkdirSync(target); writeFileSync(join(target, 'private'), 'keep')
  mkdirSync(join(dir, 'routine-runs'))
  const id = '00000000-0000-0000-0000-000000000003'
  symlinkSync(target, join(dir, 'routine-runs', id), 'dir')
  removeRoutineSessions(dir, [id])
  expect(existsSync(join(target, 'private'))).toBe(true)
  rmSync(join(dir, 'routine-runs'), { recursive: true }); symlinkSync(target, join(dir, 'routine-runs'), 'dir')
  expect(() => pruneRoutineSessions(dir, [])).toThrow(/Unsafe/)
  expect(existsSync(join(target, 'private'))).toBe(true)
})
