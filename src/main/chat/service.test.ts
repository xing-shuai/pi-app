import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent, ChatMessage, ChatThinkingLevel } from '../../../packages/shared/chat-types'
import type { ChatBackend, ChatRuntime, RuntimeEvent } from './sdk'
import { ChatService } from './service'
import { ChatStore } from './store'
import type { ChatRecord } from './store'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
class FakeRuntime implements ChatRuntime {
  model = 'test/vendor/model'
  thinkingLevel: ChatThinkingLevel = 'off'
  thinkingLevels: ChatThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']
  setThinkingLevel = vi.fn((level: ChatThinkingLevel) => { this.thinkingLevel = level; return level })
  messages: ChatMessage[] = []
  listener?: (event: RuntimeEvent) => void
  finished = deferred()
  prompt = vi.fn(async (text: string) => {
    this.messages.push({ id: 'user', role: 'user', text })
    this.listener?.({ kind: 'messages', messages: [...this.messages, { id: 'partial', role: 'assistant', text: '', pending: true }] })
    this.listener?.({ kind: 'delta', messageId: 'partial', delta: 'Hello' })
    await this.finished.promise
    this.messages.push({ id: 'assistant', role: 'assistant', text: 'Hello' })
  })
  abort = vi.fn(async () => { this.finished.resolve() })
  dispose = vi.fn()
  history() { return this.messages }
  subscribe(listener: (event: RuntimeEvent) => void) { this.listener = listener; return () => { this.listener = undefined } }
}

describe('isolated Chat lifecycle', () => {
  let dir: string
  let store: ChatStore
  let service: ChatService
  let events: ChatEvent[]
  let runtimes: Map<string, FakeRuntime>
  let backend: ChatBackend
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-service-'))
    store = new ChatStore(dir)
    events = []
    runtimes = new Map()
    backend = {
      open: vi.fn(async (record: ChatRecord) => {
        const runtime = new FakeRuntime()
        runtime.thinkingLevel = record.thinkingLevel
        runtimes.set(record.id, runtime)
        return runtime
      }),
      models: vi.fn(async () => []),
      thinkingLevels: vi.fn(async (): Promise<ChatThinkingLevel[]> => ['off', 'minimal', 'low', 'medium', 'high']),
    }
    service = new ChatService({ store, backend, emit: (event) => events.push(event), maxActive: 2 })
  })
  afterEach(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }) })
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15))

  it('marks busy and ACKs before lazy initialization or the model turn; rejects duplicates', async () => {
    const { session } = await service.create({})
    const opening = deferred<ChatRuntime>()
    vi.mocked(backend.open).mockImplementation(() => opening.promise)
    expect(await service.send({ id: session.id, text: 'First prompt' })).toEqual({ accepted: true })
    expect((await service.list()).sessions[0]).toMatchObject({ status: 'running', title: 'First prompt' })
    expect(events.some((event) => event.kind === 'session' && event.session.status === 'running')).toBe(true)
    await expect(service.send({ id: session.id, text: 'duplicate' })).rejects.toThrow('CHAT_SESSION_BUSY')
    await expect(service.setThinking({ id: session.id, level: 'high' })).rejects.toThrow('CHAT_SESSION_BUSY')
    const runtime = new FakeRuntime()
    opening.resolve(runtime)
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledOnce())
    const opened = await service.open({ id: session.id })
    expect(opened.messages.at(-1)).toMatchObject({ text: 'Hello', pending: true })
    expect(events.some((event) => event.kind === 'delta' && event.delta === 'Hello')).toBe(true)
    await service.abort({ id: session.id })
    expect(runtime.abort).toHaveBeenCalledOnce()
    expect((await service.list()).sessions[0].status).toBe('idle')
    expect((await service.open({ id: session.id })).messages.at(-1)).toMatchObject({ id: 'assistant', text: 'Hello' })
  })

  it('serializes concurrent opens and delete against lazy creation; no late prompt after cancellation', async () => {
    const { session } = await service.create({})
    const opening = deferred<ChatRuntime>()
    vi.mocked(backend.open).mockImplementation(() => opening.promise)
    await service.send({ id: session.id, text: 'cancel before startup' })
    await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce())
    const deletion = service.delete({ id: session.id })
    await settle()
    const runtime = new FakeRuntime()
    opening.resolve(runtime)
    await deletion
    expect(runtime.prompt).not.toHaveBeenCalled()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect((await service.list()).sessions).toEqual([])
    await expect(service.open({ id: session.id })).rejects.toThrow('CHAT_NOT_FOUND')
    expect(events.at(-1)).toEqual({ kind: 'deleted', id: session.id })
  })

  it('bounds concurrent turns, evicts only idle runtimes, and deduplicates concurrent open', async () => {
    const ids = await Promise.all([1, 2, 3].map(async () => (await service.create({})).session.id))
    await Promise.all([service.open({ id: ids[0] }), service.open({ id: ids[0] })])
    expect(backend.open).toHaveBeenCalledTimes(1)
    await service.open({ id: ids[1] })
    await service.open({ id: ids[2] })
    expect(runtimes.get(ids[0])!.dispose).toHaveBeenCalledOnce()
    await Promise.all(ids.slice(1).map((id) => service.send({ id, text: 'hello' })))
    await expect(service.send({ id: ids[0], text: 'third' })).rejects.toThrow('CHAT_BUSY_LIMIT')
    expect((await service.list()).sessions.filter((session) => session.status === 'running')).toHaveLength(2)
    await Promise.all(ids.slice(1).map((id) => service.abort({ id })))
  })

  it('sanitizes provider failures, preserves rename during a turn, and clears busy', async () => {
    const { session } = await service.create({})
    await service.open({ id: session.id })
    runtimes.get(session.id)!.prompt.mockRejectedValue(new Error('SECRET_KEY /home/private'))
    await service.send({ id: session.id, text: 'hello' })
    await service.rename({ id: session.id, title: 'Renamed' })
    await vi.waitFor(async () => expect((await service.list()).sessions[0].status).toBe('failed'))
    expect((await service.list()).sessions[0]).toMatchObject({ title: 'Renamed', error: 'CHAT_TURN_FAILED' })
    expect(JSON.stringify(events)).not.toContain('SECRET_KEY')
    expect(await readFile(join(store.root, 'metadata.json'), 'utf8')).not.toContain('SECRET_KEY')
  })

  it('restores recorded private paths and interrupt state after restart, without exposing paths', async () => {
    const { session } = await service.create({ model: 'provider/vendor/model' })
    const record = await store.get(session.id)
    await store.update(session.id, (stored) => { stored.status = 'running' })
    const restarted = new ChatStore(dir)
    const restored = await restarted.get(session.id)
    expect(restored).toMatchObject({ cwd: record.cwd, sessionFile: record.sessionFile, status: 'failed', error: 'CHAT_INTERRUPTED' })
    expect(record.cwd).toBe(join(dir, 'chat-workspaces', session.id))
    expect(JSON.stringify((await service.list()).sessions)).not.toContain(dir)
    if (process.platform !== 'win32') {
      expect((await stat(record.cwd)).mode & 0o777).toBe(0o700)
      expect((await stat(record.sessionFile)).mode & 0o777).toBe(0o600)
      expect((await stat(join(store.root, 'metadata.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('validates new-chat thinking against actual backend capabilities and persists both values', async () => {
    vi.mocked(backend.thinkingLevels).mockResolvedValueOnce(['off'])
    await expect(service.create({ model: 'test/plain', thinkingLevel: 'high' })).rejects.toThrow('CHAT_THINKING_UNSUPPORTED')
    await expect(service.create({ thinkingLevel: 'high' })).rejects.toThrow('CHAT_MODEL_REQUIRED')
    expect((await service.list()).sessions).toEqual([])
    await expect(service.create({ model: 'test/reasoning', thinkingLevel: 'max' })).rejects.toThrow('CHAT_THINKING_UNSUPPORTED')
    const { session } = await service.create({ model: 'test/reasoning', thinkingLevel: 'high' })
    expect(session).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'high' })
    expect((await new ChatStore(dir).get(session.id))).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'high' })
    await service.open({ id: session.id })
    expect(runtimes.get(session.id)?.thinkingLevel).toBe('high')
  })

  it('changes only idle chats, rejects unsupported levels, and keeps SDK and metadata synchronized', async () => {
    const { session } = await service.create({})
    const result = await service.setThinking({ id: session.id, level: 'high' })
    expect(result.session).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'high' })
    const runtime = runtimes.get(session.id)!
    expect(runtime.setThinkingLevel).toHaveBeenCalledWith('high')
    await expect(service.setThinking({ id: session.id, level: 'max' })).rejects.toThrow('CHAT_THINKING_UNSUPPORTED')
    expect((await store.get(session.id)).thinkingLevel).toBe('high')
    await service.send({ id: session.id, text: 'hello' })
    await expect(service.setThinking({ id: session.id, level: 'off' })).rejects.toThrow('CHAT_SESSION_BUSY')
    await service.abort({ id: session.id })
    await store.update(session.id, (record) => { record.status = 'failed' })
    await expect(service.setThinking({ id: session.id, level: 'off' })).rejects.toThrow('CHAT_SESSION_NOT_IDLE')
  })

  it('reports the actual effective level after capability changes without overwriting the request', async () => {
    const { session } = await service.create({ model: 'test/reasoning', thinkingLevel: 'high' })
    vi.mocked(backend.open).mockImplementationOnce(async (record) => {
      const runtime = new FakeRuntime()
      runtime.thinkingLevels = ['off']
      runtime.thinkingLevel = 'off'
      runtimes.set(record.id, runtime)
      return runtime
    })
    const opened = await service.open({ id: session.id })
    expect(opened.session).toMatchObject({ thinkingLevel: 'high', effectiveThinkingLevel: 'off', thinkingLevels: ['off'] })
    expect((await new ChatStore(dir).get(session.id)).effectiveThinkingLevel).toBe('off')
  })

  it('disposes an uncommitted runtime when thinking persistence fails', async () => {
    const { session } = await service.create({})
    await service.open({ id: session.id })
    const runtime = runtimes.get(session.id)!
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('CHAT_PERSIST_FAILED'))
    await expect(service.setThinking({ id: session.id, level: 'high' })).rejects.toThrow('CHAT_PERSIST_FAILED')
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect((await store.get(session.id)).thinkingLevel).toBe('off')
    expect((await service.open({ id: session.id })).session.effectiveThinkingLevel).toBe('off')
  })

  it('shutdown aborts and disposes exactly once, rejects later work', async () => {
    const { session } = await service.create({})
    await service.send({ id: session.id, text: 'hello' })
    await vi.waitFor(() => expect(runtimes.get(session.id)?.prompt).toHaveBeenCalledOnce())
    const runtime = runtimes.get(session.id)!
    await Promise.all([service.shutdown(), service.shutdown()])
    expect(runtime.abort).toHaveBeenCalled()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    await expect(service.create({})).rejects.toThrow('CHAT_CLOSED')
  })
})
