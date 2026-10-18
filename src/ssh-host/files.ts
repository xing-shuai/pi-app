import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { HostDirectory, HostWorkspace } from '../../packages/shared/ssh-host-types'
import { fail, integer, text, type RecordValue, Serial, errorCode } from './common'

export const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export function relativeInput(input: unknown, fallback?: string): string {
  const path = text(input, fallback)
  if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) fail('outside_workspace')
  return path
}
/** Canonicalize every existing component, including dangling links and missing target parents. */
export async function under(root: string, input: unknown = '.', missing = false): Promise<string> {
  const path = relativeInput(input)
  if (await realpath(root) !== root) fail('workspace_changed')
  let current = root
  const parts = path.split('/').filter((p) => p && p !== '.')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    try {
      await lstat(current)
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        current = join(current, ...parts.slice(i + 1)); break
      }
      throw error
    }
    current = await realpath(current) // dangling symlinks are NOT missing writable targets
    if (!contained(root, current)) fail('outside_workspace')
  }
  if (!contained(root, current)) fail('outside_workspace')
  return current
}

async function names(path: string, max = 20000): Promise<{ name: string; isDirectory: boolean; symlink: boolean }[]> {
  const result: { name: string; isDirectory: boolean; symlink: boolean }[] = []
  const dir = await opendir(path)
  for await (const ent of dir) {
    if (result.length >= max) fail('directory_too_large')
    result.push({ name: ent.name, isDirectory: ent.isDirectory(), symlink: ent.isSymbolicLink() })
  }
  return result
}
const sorted = <T extends { name: string; isDirectory: boolean }>(entries: T[]): T[] => entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

export class Files {
  readonly workspaces = new Map<string, HostWorkspace>()
  readonly locks = new Map<string, Serial>()
  constructor(readonly home: string) {}
  expand(path: string): string { return path === '~' ? this.home : path.startsWith('~/') ? join(this.home, path.slice(2)) : resolve(this.home, path) }
  async browse(args: RecordValue): Promise<HostDirectory> {
    const path = await realpath(this.expand(text(args.path, this.home)))
    if (!(await stat(path)).isDirectory()) fail('not_a_directory')
    const entries: HostDirectory['entries'] = []
    for (const entry of await names(path)) {
      if (!entry.isDirectory && !entry.symlink) continue
      if (entry.symlink && !(await stat(join(path, entry.name)).catch(() => null))?.isDirectory()) continue
      entries.push({ name: entry.name, path: join(path, entry.name), directory: true, ...(entry.symlink ? { symlink: true } : {}) })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { path, home: this.home, entries: entries.slice(0, 500) }
  }
  async register(args: RecordValue): Promise<HostWorkspace> {
    if (args.trusted !== true) fail('workspace_untrusted')
    const root = await realpath(this.expand(text(args.path)))
    if (!(await stat(root)).isDirectory()) fail('not_a_directory')
    const id = hash(root)
    if (!this.workspaces.has(id) && this.workspaces.size >= 128) fail('workspace_limit')
    const workspace = { id, root, name: basename(root) || root }
    this.workspaces.set(id, workspace)
    if (!this.locks.has(id)) this.locks.set(id, new Serial())
    return workspace
  }
  workspace(args: RecordValue): HostWorkspace {
    const workspace = this.workspaces.get(text(args.workspaceId))
    if (!workspace) fail('workspace_untrusted')
    return workspace
  }
  async bytes(path: string, max: number): Promise<{ data: Buffer; size: number; truncated: boolean }> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) fail('not_a_file')
      const data = Buffer.alloc(Math.min(info.size, max) + 1)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return { data: data.subarray(0, Math.min(offset, max)), size: info.size, truncated: offset > max || info.size > max }
    } finally { await handle.close() }
  }
  async operation(op: string, args: RecordValue): Promise<unknown> {
    const ws = this.workspace(args)
    const execute = async () => {
      try { return await this.perform(ws, op, args) } catch (error) { return { ok: false, error: errorCode(error), ...(op === 'fs.list' || op === 'fs.search' ? { entries: [] } : {}) } }
    }
    return ['fs.write', 'fs.rename', 'fs.create'].includes(op) ? this.locks.get(ws.id)!.run(execute) : execute()
  }
  private async perform(ws: HostWorkspace, op: string, args: RecordValue): Promise<unknown> {
    const root = ws.root
    if (op === 'fs.search') {
      const query = relativeInput(text(args.query, ''))
      const slash = query.lastIndexOf('/')
      const scope = slash >= 0 ? query.slice(0, slash) : '.'
      const needle = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase()
      const start = await under(root, scope)
      const queue = [start], entries: { name: string; path: string; isDirectory: boolean; score: number }[] = []
      let visited = 0
      const deadline = Date.now() + 2500
      while (queue.length && visited < 10000 && Date.now() < deadline) {
        const dir = queue.shift()!
        for (const entry of await names(dir, 20000)) {
          if (++visited > 10000 || Date.now() >= deadline) break
          if (entry.name === '.git' || entry.symlink) continue
          const abs = join(dir, entry.name), path = relative(root, abs)
          await under(root, path)
          if (entry.isDirectory) queue.push(abs)
          const name = entry.name.toLowerCase()
          const score = !needle ? (entry.isDirectory ? 10 : 0) : name === needle ? 100 : name.startsWith(needle) ? 80 : name.includes(needle) ? 50 : path.toLowerCase().includes(needle) ? 30 : -1
          if (score >= 0) entries.push({ name: entry.name, path, isDirectory: entry.isDirectory, score: score + (entry.isDirectory && needle ? 10 : 0) })
        }
      }
      entries.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      return { ok: true, entries: entries.slice(0, integer(args.maxResults, 20, 100)).map(({ score: _score, ...entry }) => entry) }
    }
    if (op === 'fs.list') {
      const path = await under(root, text(args.path, '.'))
      const entries = sorted((await names(path)).filter((e) => args.includeDotfiles === true || !e.name.startsWith('.')))
      const selected = []
      for (const entry of entries.slice(0, 2500)) {
        const rel = relative(root, join(path, entry.name))
        // Do not even stat escaping symlink targets.
        const info = await under(root, rel).then((p) => stat(p)).catch(() => null)
        selected.push({ name: entry.name, path: rel, isDirectory: entry.isDirectory, size: !entry.isDirectory ? info?.size : undefined, mtimeMs: info?.mtimeMs })
      }
      return { ok: true, entries: selected, truncated: entries.length > 2500, totalCount: entries.length }
    }
    if (op === 'fs.read' || op === 'fs.image') {
      const path = await under(root, args.path)
      const max = op === 'fs.image' ? 8 * 1024 * 1024 : integer(args.maxBytes, 1024 * 1024, 1024 * 1024)
      const { data, size, truncated } = await this.bytes(path, max)
      if (op === 'fs.image') {
        if (truncated) fail('too_large')
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path).toLowerCase()]
        if (!mime) fail('unsupported_image')
        return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}`, mimeType: mime }
      }
      if (data.includes(0)) fail('binary')
      const decoder = new StringDecoder('utf8')
      const content = decoder.write(data) + (truncated ? '' : decoder.end())
      return { ok: true, text: content, content, path: relative(root, path), size, truncated, hash: hash(data) }
    }
    if (op === 'fs.write') {
      const content = text(args.text)
      if (Buffer.byteLength(content) > 1024 * 1024) fail('too_large')
      const path = await under(root, args.path, true)
      if (path === root) fail('invalid_name')
      if (args.expectedHash !== undefined) {
        const expected = text(args.expectedHash)
        const existing = await this.bytes(path, 1024 * 1024).catch((e) => { if (errorCode(e) === 'not_found') return null; throw e })
        if (!existing || existing.truncated || hash(existing.data) !== expected) fail('conflict')
      }
      await mkdir(dirname(path), { recursive: true })
      await under(root, relative(root, dirname(path)))
      const temporary = join(dirname(path), `.pi-write-${randomUUID()}`)
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      try {
        const info = await stat(path).catch(() => null)
        if (info && !info.isFile()) fail('not_a_file')
        if (info) await chmod(temporary, info.mode & 0o777)
        await under(root, relative(root, path), true)
        if (args.expectedHash !== undefined) {
          const latest = await this.bytes(path, 1024 * 1024)
          if (latest.truncated || hash(latest.data) !== args.expectedHash) fail('conflict')
        }
        await rename(temporary, path)
      } finally { await unlink(temporary).catch(() => {}) }
      return { ok: true, hash: hash(content) }
    }
    if (op === 'fs.create') {
      const path = await under(root, text(args.relativePath), true)
      if (path === root) fail('invalid_name')
      if (args.isDirectory === true) {
        if (await lstat(path).catch(() => null)) fail('target_exists')
        await mkdir(path, { recursive: true })
        await under(root, relative(root, path))
      } else { await mkdir(dirname(path), { recursive: true }); await under(root, relative(root, dirname(path))); const handle = await open(path, 'wx', 0o600); await handle.close() }
      return { ok: true }
    }
    if (op === 'fs.rename') {
      const name = text(args.newName).trim()
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) fail('invalid_name')
      const path = await under(root, args.relativePath)
      if (path === root) fail('invalid_name')
      const target = await under(root, relative(root, join(dirname(path), name)), true)
      if (await lstat(target).catch(() => null)) fail('target_exists')
      await rename(path, target)
      return { ok: true, newRelativePath: relative(root, target) }
    }
    fail('unsupported_operation')
  }
}
