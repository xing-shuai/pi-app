import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from './store'
import { CHAT_LIMITS, chatSchemas, splitChatModel } from './validation'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'chat-store-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('Chat metadata policy', () => {
  it('serializes mutations, atomically saves valid JSON, and leaves no temporary files', async () => {
    const store = new ChatStore(dir)
    const records = await Promise.all(Array.from({ length: 10 }, (_, index) => store.create({ title: `Chat ${index}` })))
    await Promise.all(records.map((record) => store.update(record.id, (stored) => { stored.title += ' renamed' })))
    const restored = await new ChatStore(dir).list()
    expect(restored).toHaveLength(10)
    expect(restored.every((record) => record.title.endsWith(' renamed'))).toBe(true)
    const disk = JSON.parse(await readFile(join(store.root, 'metadata.json'), 'utf8'))
    expect(disk.sessions).toHaveLength(10)
    expect((await readdir(store.root)).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('persists requested/effective thinking and defaults old metadata to off', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({ model: 'test/reasoning', thinkingLevel: 'high' })
    expect(await new ChatStore(dir).get(record.id)).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'high' })
    await store.update(record.id, (stored) => { stored.effectiveThinkingLevel = 'medium' })
    expect(await new ChatStore(dir).get(record.id)).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'medium' })
    const file = join(store.root, 'metadata.json')
    const disk = JSON.parse(await readFile(file, 'utf8'))
    delete disk.sessions[0].thinkingLevel
    delete disk.sessions[0].effectiveThinkingLevel
    await writeFile(file, JSON.stringify(disk))
    expect(await new ChatStore(dir).get(record.id)).toMatchObject({ thinkingLevel: 'off', effectiveThinkingLevel: 'off' })
    disk.sessions[0].thinkingLevel = 'unlimited'
    await writeFile(file, JSON.stringify(disk))
    await expect(new ChatStore(dir).list()).rejects.toThrow('CHAT_INVALID_METADATA')
  })

  it('rolls back rejected mutations and continues accepting valid serialized writes', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({ title: 'Original' })
    await expect(store.update(record.id, (stored) => { stored.title = '' })).rejects.toThrow()
    expect((await store.get(record.id)).title).toBe('Original')
    await store.update(record.id, (stored) => { stored.title = 'Valid' })
    expect((await new ChatStore(dir).get(record.id)).title).toBe('Valid')
  })

  it('enforces the persisted session-count bound before creating more workspaces', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({})
    const sessions = Array.from({ length: CHAT_LIMITS.sessions }, () => {
      const id = randomUUID()
      const cwd = join(store.root, id)
      return { ...record, id, cwd, sessionFile: join(cwd, 'session.jsonl') }
    })
    await writeFile(join(store.root, 'metadata.json'), JSON.stringify({ version: 1, sessions }))
    await expect(new ChatStore(dir).create({})).rejects.toThrow('CHAT_SESSION_LIMIT')
  })

  it('rejects recorded paths outside its native allowlist and corrupt metadata', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({})
    const file = join(store.root, 'metadata.json')
    await writeFile(file, JSON.stringify({ version: 1, sessions: [{ ...record, cwd: '/arbitrary/project' }] }))
    await expect(new ChatStore(dir).list()).rejects.toThrow('CHAT_INVALID_PATH')
    await writeFile(file, '{not JSON')
    await expect(new ChatStore(dir).list()).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects symlinked session files instead of reading or overwriting targets', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({})
    const target = join(dir, 'secret')
    await writeFile(target, 'secret')
    await rm(record.sessionFile)
    await symlink(target, record.sessionFile)
    await expect(store.authorize(record)).rejects.toThrow('CHAT_INVALID_TRANSCRIPT')
    expect(await readFile(target, 'utf8')).toBe('secret')
  })

  it('rejects oversized transcripts before SDK synchronous loading', async () => {
    const store = new ChatStore(dir)
    const record = await store.create({})
    const { open } = await import('node:fs/promises')
    const file = await open(record.sessionFile, 'r+')
    await file.truncate(CHAT_LIMITS.transcriptBytes + 1)
    await file.close()
    await expect(store.authorize(record)).rejects.toThrow('CHAT_INVALID_TRANSCRIPT')
  })
})

describe('Chat IPC request bounds', () => {
  const id = '7a497265-9a19-44a8-8c69-f20feb97c8b0'
  const png = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  it('accepts base64 images with MIME signatures and splits only the first model slash', () => {
    expect(chatSchemas.send.parse({ id, text: '', images: [png] }).images).toEqual([png])
    expect(splitChatModel('openrouter/vendor/model/id')).toEqual(['openrouter', 'vendor/model/id'])
  })
  it('rejects paths, unknown capabilities, empty prompts and malformed image payloads', () => {
    for (const input of [
      { id: '../../session', text: 'hello' }, { id, text: 'hello', cwd: '/tmp' }, { id, text: ' ' },
      { id, text: 'x'.repeat(CHAT_LIMITS.textChars + 1) },
      { id, text: '', images: [{ ...png, data: 'file:///etc/passwd' }] },
      { id, text: '', images: [{ ...png, mimeType: 'image/svg+xml' }] },
      { id, text: '', images: [{ ...png, mimeType: 'image/jpeg' }] },
      { id, text: '', images: Array(5).fill(png) },
    ]) expect(chatSchemas.send.safeParse(input).success).toBe(false)
    expect(chatSchemas.create.safeParse({ sessionFile: '/tmp/session.jsonl' }).success).toBe(false)
    expect(chatSchemas.models.safeParse({ workspaceId: '/project' }).success).toBe(false)
  })
  it('rejects per-image and aggregate size overflow without pathological regex recursion', () => {
    const data = Buffer.concat([Buffer.from(png.data, 'base64'), Buffer.alloc(CHAT_LIMITS.imageBytes)]).toString('base64')
    expect(chatSchemas.send.safeParse({ id, text: '', images: [{ ...png, data }] }).success).toBe(false)
    const large = Buffer.concat([Buffer.from(png.data, 'base64'), Buffer.alloc(4 * 1024 * 1024)]).toString('base64')
    expect(chatSchemas.send.safeParse({ id, text: '', images: Array(4).fill({ ...png, data: large }) }).success).toBe(false)
  })
})
