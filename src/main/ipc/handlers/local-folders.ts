import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import type { LocalFolderBrowseRequest, LocalFolderBrowseResult, LocalFolderEntry, LocalFolderResolveResult, LocalFolderRoot } from '@shared/local-folder-types'
import { registerHandler } from '../registry'

const MAX_DIRECTORIES = 500
const invalidRequest = () => new Error('Invalid local folder request')

function reserved(value: string): boolean {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/').replace(/^[a-z]:/i, ''))
  const candidate = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return candidate === '/__pi_ssh__' || candidate.startsWith('/__pi_ssh__/')
}
function validPath(value: string): boolean {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(value) || reserved(value)) return false
  // Never probe network shares or Windows device namespaces while browsing this computer.
  if (/^[\\/]{2}/.test(value)) return false
  return value === '~' || value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\')) || path.isAbsolute(value)
}
export const localFolderPathSchema = z.string().min(1).max(4096).refine(validPath)
export const localFolderBrowseSchema = z.object({ path: localFolderPathSchema.optional(), includeHidden: z.boolean().optional() }).strict()
export const localFolderResolveSchema = z.object({ path: localFolderPathSchema }).strict()

function expand(value: string): string {
  const expanded = value === '~' ? homedir() : /^~[\\/]/.test(value) ? path.join(homedir(), value.slice(2)) : value
  if (!validPath(expanded)) throw invalidRequest()
  return path.normalize(expanded)
}
function readableError(reason: unknown): Error {
  const code = (reason as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return new Error('Permission denied. Choose a readable local folder.')
  if (code === 'ENOENT') return new Error('This local folder no longer exists.')
  if (code === 'ENOTDIR') return new Error('Choose a local directory, not a file.')
  return new Error('Could not read this local folder.')
}
async function canonicalDirectory(value: string): Promise<string> {
  const expanded = expand(value)
  let canonical: string
  try {
    canonical = await fs.realpath(expanded)
    if (!validPath(canonical)) throw invalidRequest()
    if (!(await fs.stat(canonical)).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' })
    await fs.access(canonical, constants.R_OK)
  } catch (reason) {
    if (reason instanceof Error && reason.message === 'Invalid local folder request') throw reason
    throw readableError(reason)
  }
  return canonical
}
async function localRoots(current: string): Promise<LocalFolderRoot[]> {
  if (process.platform !== 'win32') return [{ name: 'Filesystem', path: path.parse(current).root }]
  const roots: LocalFolderRoot[] = []
  // Filesystem access only: no shell, process launch, network enumeration, or SDK startup.
  await Promise.all(Array.from({ length: 26 }, async (_, i) => {
    const drive = `${String.fromCharCode(65 + i)}:\\`
    try { await fs.access(drive, constants.R_OK); roots.push({ name: drive, path: drive }) } catch { /* Unavailable drives are not shortcuts. */ }
  }))
  return roots.sort((a, b) => a.path.localeCompare(b.path))
}
const compare = (a: LocalFolderEntry, b: LocalFolderEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name)

export async function browseLocalFolders(raw: LocalFolderBrowseRequest = {}): Promise<LocalFolderBrowseResult> {
  const parsed = localFolderBrowseSchema.safeParse(raw)
  if (!parsed.success) throw invalidRequest()
  const home = await canonicalDirectory(homedir())
  const current = await canonicalDirectory(parsed.data.path ?? home)
  const entries: LocalFolderEntry[] = []
  let truncated = false
  try {
    const directory = await fs.opendir(current)
    for await (const entry of directory) {
      if (!parsed.data.includeHidden && entry.name.startsWith('.')) continue
      const entryPath = path.join(current, entry.name)
      if (!validPath(entryPath)) continue
      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        // Follow existing directory links only; broken, unreadable and reserved targets stay hidden.
        try {
          const target = await fs.realpath(entryPath)
          isDirectory = validPath(target) && (await fs.stat(target)).isDirectory()
        } catch { isDirectory = false }
      }
      if (!isDirectory) continue
      const value: LocalFolderEntry = { name: entry.name, path: entryPath, directory: true, ...(entry.isSymbolicLink() ? { symlink: true } : {}) }
      // Keep just the first 500 sorted directories, even in very large directories.
      let lo = 0, hi = entries.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(entries[mid], value) < 0) lo = mid + 1; else hi = mid }
      entries.splice(lo, 0, value)
      if (entries.length > MAX_DIRECTORIES) { entries.pop(); truncated = true }
    }
  } catch (reason) { throw readableError(reason) }
  const parent = path.dirname(current)
  return { path: current, home, parent: parent === current ? null : parent, entries, roots: await localRoots(current), truncated }
}
export async function resolveLocalFolder(raw: { path: string }): Promise<LocalFolderResolveResult> {
  const parsed = localFolderResolveSchema.safeParse(raw)
  if (!parsed.success) throw invalidRequest()
  const canonical = await canonicalDirectory(parsed.data.path)
  return { path: canonical, name: path.basename(canonical) || path.parse(canonical).root }
}

export function registerLocalFolderHandlers(): void {
  registerHandler('ipc:local.folders.browse', async (raw) => browseLocalFolders(raw))
  registerHandler('ipc:local.folders.resolve', async (raw) => resolveLocalFolder(raw))
}
