import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { ChatSessionInfo, ChatThinkingLevel } from '../../../packages/shared/chat-types'
import { CHAT_LIMITS, chatIdSchema, chatModelSchema, chatThinkingLevelSchema, chatTitleSchema } from './validation'

const infoSchema = z.object({
  id: chatIdSchema,
  title: chatTitleSchema,
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  model: chatModelSchema.optional(),
  thinkingLevel: chatThinkingLevelSchema.default('off'),
  effectiveThinkingLevel: chatThinkingLevelSchema.default('off'),
  thinkingLevels: z.array(chatThinkingLevelSchema).max(7).optional(),
  status: z.enum(['idle', 'running', 'failed']),
  // Only application-defined error codes, never provider payloads or credentials.
  error: z.enum(['CHAT_INTERRUPTED', 'CHAT_TURN_FAILED', 'CHAT_OPEN_FAILED']).optional(),
}).strict()
const recordSchema = infoSchema.extend({ cwd: z.string(), sessionFile: z.string() }).strict()
const diskSchema = z.object({ version: z.literal(1), sessions: z.array(recordSchema).max(CHAT_LIMITS.sessions) }).strict()
export type ChatRecord = z.infer<typeof recordSchema>
export function publicSession(record: ChatRecord): ChatSessionInfo {
  const { cwd: _cwd, sessionFile: _file, ...info } = record
  return info
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

/** Async, single-writer atomic metadata. Paths are generated here, never accepted from IPC. */
export class ChatStore {
  readonly root: string
  private records = new Map<string, ChatRecord>()
  private initialization?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private readonly metadata: string

  constructor(userData: string) {
    this.root = resolve(userData, 'chat-workspaces')
    this.metadata = join(this.root, 'metadata.json')
  }

  init(): Promise<void> {
    return this.initialization ??= this.load()
  }

  private async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.checkDirectory(this.root)
    let content: string
    try {
      const stat = await lstat(this.metadata)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('CHAT_INVALID_METADATA')
      await chmod(this.metadata, 0o600)
      content = await readFile(this.metadata, 'utf8')
    } catch (error) {
      if (!missing(error)) throw new Error('CHAT_INVALID_METADATA')
      return
    }
    const parsed = diskSchema.safeParse(JSON.parse(content))
    if (!parsed.success) throw new Error('CHAT_INVALID_METADATA')
    let interrupted = false
    for (const stored of parsed.data.sessions) {
      this.assertPaths(stored)
      if (this.records.has(stored.id)) throw new Error('CHAT_INVALID_METADATA')
      const record = { ...stored }
      if (record.status === 'running') {
        record.status = 'failed'
        record.error = 'CHAT_INTERRUPTED'
        interrupted = true
      }
      this.records.set(record.id, record)
    }
    if (interrupted) await this.persist(this.records)
  }

  private assertPaths(record: ChatRecord): void {
    chatIdSchema.parse(record.id)
    if (record.cwd !== join(this.root, record.id) || record.sessionFile !== join(record.cwd, 'session.jsonl')) {
      throw new Error('CHAT_INVALID_PATH')
    }
  }

  private async checkDirectory(path: string): Promise<void> {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('CHAT_INVALID_PATH')
    await chmod(path, 0o700)
  }

  async authorize(record: ChatRecord): Promise<void> {
    this.assertPaths(record)
    await this.checkDirectory(this.root)
    await this.checkDirectory(record.cwd)
    const stat = await lstat(record.sessionFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > CHAT_LIMITS.transcriptBytes) throw new Error('CHAT_INVALID_TRANSCRIPT')
    if (await realpath(record.sessionFile) !== record.sessionFile) throw new Error('CHAT_INVALID_PATH')
    await chmod(record.sessionFile, 0o600)
  }

  private async persist(records: Map<string, ChatRecord>): Promise<void> {
    await this.checkDirectory(this.root)
    const content = JSON.stringify({ version: 1, sessions: [...records.values()] })
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('CHAT_METADATA_LIMIT')
    const temp = join(this.root, `.metadata-${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(content)
        await handle.sync()
      } finally { await handle.close() }
      await rename(temp, this.metadata)
      // Directory fsync is not supported on Windows. File fsync + rename still applies there.
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await rm(temp, { force: true }).catch(() => {}) }
  }

  private mutate<T>(fn: (next: Map<string, ChatRecord>) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      await this.init()
      const next = new Map([...this.records].map(([id, record]) => [id, { ...record }]))
      const value = await fn(next)
      await this.persist(next)
      this.records = next
      return value
    })
    this.tail = result.catch(() => {})
    return result
  }

  async list(): Promise<ChatRecord[]> {
    await this.init()
    await this.tail
    return [...this.records.values()].map((record) => ({ ...record })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<ChatRecord> {
    chatIdSchema.parse(id)
    await this.init()
    await this.tail
    const record = this.records.get(id)
    if (!record) throw new Error('CHAT_NOT_FOUND')
    return { ...record }
  }

  create(input: { title?: string; model?: string; thinkingLevel?: ChatThinkingLevel; thinkingLevels?: ChatThinkingLevel[] }): Promise<ChatRecord> {
    return this.mutate(async (next) => {
      if (next.size >= CHAT_LIMITS.sessions) throw new Error('CHAT_SESSION_LIMIT')
      const id = randomUUID()
      const cwd = join(this.root, id)
      const now = Date.now()
      const record: ChatRecord = { id, cwd, sessionFile: join(cwd, 'session.jsonl'), title: input.title ?? 'New chat', model: input.model, createdAt: now, updatedAt: now, status: 'idle', thinkingLevel: input.thinkingLevel ?? 'off', effectiveThinkingLevel: input.thinkingLevel ?? 'off', thinkingLevels: input.thinkingLevels }
      recordSchema.parse(record)
      await mkdir(cwd, { mode: 0o700 })
      const handle = await open(record.sessionFile, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(now).toISOString(), cwd }) + '\n')
        await handle.sync()
      } finally { await handle.close() }
      next.set(id, record)
      return { ...record }
    })
  }

  update(id: string, change: (record: ChatRecord) => void): Promise<ChatRecord> {
    return this.mutate((next) => {
      const record = next.get(id)
      if (!record) throw new Error('CHAT_NOT_FOUND')
      change(record)
      record.updatedAt = Date.now()
      recordSchema.parse(record)
      this.assertPaths(record)
      return { ...record }
    })
  }

  remove(id: string): Promise<void> {
    return this.mutate((next) => { if (!next.delete(id)) throw new Error('CHAT_NOT_FOUND') })
  }

  async removeWorkspace(record: ChatRecord): Promise<void> {
    this.assertPaths(record)
    await this.checkDirectory(this.root)
    // Never recursively follow a substituted workspace symlink.
    await this.checkDirectory(record.cwd)
    await rm(record.cwd, { recursive: true, force: true })
  }

  async flush(): Promise<void> { await this.init(); await this.tail }
}
