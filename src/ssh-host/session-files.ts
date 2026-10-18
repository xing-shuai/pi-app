// Private session metadata belongs to the host, never to Pi's SDK-owned JSONL header.
// Keep this module node:-only: the host is bundled as a standalone single file.
import { constants, type Stats } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { fail } from './common'

export const SESSION_LIMIT = 256 * 1024 * 1024
export const PURPOSE_SUFFIX = '.desktop-purpose'
export const OPENED_SUFFIX = '.desktop-opened'
export function privateFile(info: Stats, max: number): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && info.nlink === 1 && (info.mode & 0o077) === 0 && info.size <= max
}
export function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}
export async function checkedFile(path: string, max = SESSION_LIMIT, requirePrivateMode = true) {
  // Listing can describe owner-held legacy files with loose modes; deletion and
  // private sidecars still require owner-only permissions and refuse them.
  const valid = (info: Stats) => privateFile(info, max) || (!requirePrivateMode && info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && info.nlink === 1 && info.size <= max)
  const before = await lstat(path)
  if (!valid(before)) fail('unsafe_session_file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!valid(info) || !sameFile(before, info)) fail('session_file_changed')
    return { handle, info }
  } catch (error) { await handle.close(); throw error }
}
export async function sidecar(path: string): Promise<{ info: Stats; value: string } | undefined> {
  try {
    const { handle, info } = await checkedFile(path, 512)
    try { return { info, value: await handle.readFile('utf8') } } finally { await handle.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function purpose(path: string, sessionId: string): Promise<'utility' | 'user' | undefined> {
  const entry = await sidecar(path + PURPOSE_SUFFIX)
  if (!entry) return undefined
  try {
    const data = JSON.parse(entry.value)
    if (data.version === 1 && data.sessionId === sessionId && ['utility', 'user'].includes(data.purpose)) return data.purpose
  } catch { /* Unknown provenance must remain visible. */ }
  fail('unsafe_session_sidecar')
}
export async function markPurpose(path: string, sessionId: string, value: 'utility' | 'user'): Promise<void> {
  const handle = await open(path + PURPOSE_SUFFIX, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((error) => {
    if (error.code === 'EEXIST') return null
    throw error
  })
  if (!handle) { await sidecar(path + PURPOSE_SUFFIX); return }
  try { await handle.writeFile(JSON.stringify({ version: 1, sessionId, purpose: value })) } finally { await handle.close() }
}
export async function markOpened(path: string): Promise<void> {
  const handle = await open(path + OPENED_SUFFIX, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((error) => {
    if (error.code === 'EEXIST') return null
    throw error
  })
  if (!handle) { const entry = await sidecar(path + OPENED_SUFFIX); if (entry?.value !== '') fail('unsafe_session_sidecar'); return }
  await handle.close()
}
export async function unlinkChecked(path: string, info: Stats): Promise<void> {
  const current = await lstat(path)
  if (!privateFile(current, SESSION_LIMIT) || !sameFile(current, info)) fail('session_file_changed')
  await unlink(path)
}
