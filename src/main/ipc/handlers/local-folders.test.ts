// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const f = vi.hoisted(() => ({ home: '', handlers: new Map<string, (req: unknown) => Promise<unknown>>() }))
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => f.home }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir), realpath: vi.fn(actual.realpath), access: vi.fn(actual.access) }
})
vi.mock('../registry', () => ({ registerHandler: (channel: string, handler: (req: unknown) => Promise<unknown>) => f.handlers.set(channel, handler) }))
import { browseLocalFolders, localFolderPathSchema, registerLocalFolderHandlers, resolveLocalFolder } from './local-folders'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'pi-local-picker-'))
  f.home = root; f.handlers.clear(); vi.mocked(fs.opendir).mockClear()
  registerLocalFolderHandlers()
})
afterEach(async () => { vi.mocked(fs.opendir).mockReset(); vi.mocked(fs.realpath).mockReset(); vi.mocked(fs.access).mockReset(); await fs.rm(root, { recursive: true, force: true }) })

describe('local directory-only IPC', () => {
  it('registers the two literal narrow endpoints and defaults to canonical HOME', async () => {
    expect([...f.handlers.keys()]).toEqual(['ipc:local.folders.browse', 'ipc:local.folders.resolve'])
    const value = await f.handlers.get('ipc:local.folders.browse')!({})
    expect(value).toEqual({ path: await fs.realpath(root), home: await fs.realpath(root), parent: path.dirname(await fs.realpath(root)), entries: [], roots: expect.any(Array), truncated: false })
    expect(await f.handlers.get('ipc:local.folders.resolve')!({ path: '~' })).toEqual({ path: await fs.realpath(root), name: path.basename(root) })
  })
  it('lists only sorted directories; hidden folders require opt-in and files are never returned', async () => {
    for (const name of ['zeta', 'alpha', '.hidden', 'folder10', 'folder2']) await fs.mkdir(path.join(root, name))
    await fs.writeFile(path.join(root, 'private.txt'), 'never read this file')
    const result = await browseLocalFolders({ path: '~' })
    expect(result.entries.map((entry) => entry.name)).toEqual(['alpha', 'folder2', 'folder10', 'zeta'])
    expect(result.entries.every((entry) => entry.directory === true && path.isAbsolute(entry.path))).toBe(true)
    expect((await browseLocalFolders({ includeHidden: true })).entries.map((entry) => entry.name)).toContain('.hidden')
    expect((await browseLocalFolders({ path: '~/alpha' })).path).toBe(path.join(await fs.realpath(root), 'alpha'))
  })
  it('bounds output to the first 500 sorted directories, not the first 500 files', async () => {
    await Promise.all(Array.from({ length: 507 }, (_, index) => fs.mkdir(path.join(root, `dir${506 - index}`))))
    const value = await browseLocalFolders()
    expect(value.entries).toHaveLength(500); expect(value.truncated).toBe(true)
    expect(value.entries[0].name).toBe('dir0'); expect(value.entries.at(-1)?.name).toBe('dir499')
  })
  it('canonicalizes HOME, navigated directory symlinks, and the confirmed selection', async () => {
    const target = path.join(root, 'target'), alias = path.join(root, 'alias')
    await fs.mkdir(target)
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await fs.symlink(path.join(root, 'missing'), path.join(root, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
    const value = await browseLocalFolders()
    expect(value.entries.find((entry) => entry.name === 'alias')).toEqual({ name: 'alias', path: alias, directory: true, symlink: true })
    expect(value.entries.map((entry) => entry.name)).not.toContain('broken')
    expect((await browseLocalFolders({ path: alias })).path).toBe(await fs.realpath(target))
    expect(await resolveLocalFolder({ path: alias })).toEqual({ path: await fs.realpath(target), name: 'target' })
    f.home = alias
    expect((await browseLocalFolders()).home).toBe(await fs.realpath(target))
  })
  it('uses null parent at a filesystem root', async () => {
    const rootPath = path.parse(root).root
    const value = await browseLocalFolders({ path: rootPath })
    expect(value.path).toBe(rootPath); expect(value.parent).toBeNull()
    expect(value.roots.some((entry) => entry.path === rootPath)).toBe(true)
  })
  it('rejects invalid bounds, relative/control paths, virtual SSH paths, UNC and extra fields before filesystem IO', async () => {
    const badPaths = ['', 'relative', '~another-user', '/a\u0000b', '/a\nb', '/a\tb', '/a\u007fb', '/' + 'a'.repeat(4096), '/__pi_ssh__', '/__pi_ssh__/host/project', '/tmp/../__pi_ssh__/host', '\\__pi_ssh__\\host', '//server/share', '\\\\server\\share']
    for (const value of badPaths) {
      await expect(browseLocalFolders({ path: value })).rejects.toThrow('Invalid local folder request')
      await expect(resolveLocalFolder({ path: value })).rejects.toThrow('Invalid local folder request')
    }
    for (const raw of [{ includeHidden: 'yes' }, { path: '~', arbitraryRead: '/etc/passwd' }, { profileId: 'remote' }, null]) {
      await expect(f.handlers.get('ipc:local.folders.resolve')!(raw)).rejects.toThrow('Invalid local folder request')
      await expect(f.handlers.get('ipc:local.folders.browse')!(raw)).rejects.toThrow('Invalid local folder request')
    }
    expect(fs.opendir).not.toHaveBeenCalled()
  })
  it('rejects canonical targets in the reserved SSH namespace even behind a local alias', async () => {
    const alias = path.join(root, 'reserved-link')
    await fs.symlink(path.join(root, 'missing'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await browseLocalFolders()).entries).toEqual([])
    // Simulate an existing link whose realpath reaches the reserved namespace.
    vi.mocked(fs.realpath).mockResolvedValueOnce(path.join(path.parse(root).root, '__pi_ssh__', 'host', 'project'))
    await expect(resolveLocalFolder({ path: alias })).rejects.toThrow('Invalid local folder request')
  })
  it('enforces the exact 4096-character boundary without trimming native paths', () => {
    const prefix = path.parse(root).root
    expect(localFolderPathSchema.safeParse(prefix + 'a'.repeat(4096 - prefix.length)).success).toBe(true)
    expect(localFolderPathSchema.safeParse(prefix + 'a'.repeat(4097 - prefix.length)).success).toBe(false)
    expect(localFolderPathSchema.parse(path.join(root, ' folder with spaces '))).toBe(path.join(root, ' folder with spaces '))
  })
  it('returns safe readable errors for permissions, absent folders and files without exposing raw OS details', async () => {
    await fs.writeFile(path.join(root, 'file'), 'secret')
    await expect(resolveLocalFolder({ path: path.join(root, 'file') })).rejects.toThrow('not a file')
    await expect(browseLocalFolders({ path: path.join(root, 'missing') })).rejects.toThrow('no longer exists')
    vi.mocked(fs.opendir).mockRejectedValueOnce(Object.assign(new Error('secret-system-message'), { code: 'EACCES' }))
    await expect(browseLocalFolders()).rejects.toThrow('Permission denied. Choose a readable local folder.')
    vi.mocked(fs.access).mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'EPERM' }))
    await expect(resolveLocalFolder({ path: root })).rejects.toThrow('Permission denied. Choose a readable local folder.')
  })
})
