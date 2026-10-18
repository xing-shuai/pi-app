import type { ChatEvent, ChatMessage, ChatSessionInfo } from '../../../packages/shared/chat-types'
import type { ChatBackend, ChatRuntime, RuntimeEvent } from './sdk'
import { ChatStore, publicSession } from './store'
import type { ChatRecord } from './store'
import { CHAT_LIMITS, chatSchemas } from './validation'

interface Active { runtime: ChatRuntime; touched: number; messages?: ChatMessage[] }
interface Turn { cancelled: boolean; failed: boolean; runtime?: ChatRuntime; done: Promise<void> }
export interface ChatServiceOptions {
  store: ChatStore
  backend: ChatBackend
  emit: (event: ChatEvent) => void
  maxActive?: number
}

/** Session operations serialize, but a model turn never holds the session lock. */
export class ChatService {
  private readonly store: ChatStore
  private readonly backend: ChatBackend
  private readonly emitEvent: (event: ChatEvent) => void
  private readonly maxActive: number
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly active = new Map<string, Active>()
  private readonly turns = new Map<string, Turn>()
  private activation: Promise<unknown> = Promise.resolve()
  private closing = false
  private shutdownPromise?: Promise<void>
  private clock = 0
  private revisions = new Map<string, number>()
  get hasActiveWork(): boolean { return this.turns.size > 0 }

  constructor(options: ChatServiceOptions) {
    this.store = options.store
    this.backend = options.backend
    this.emitEvent = options.emit
    this.maxActive = options.maxActive ?? CHAT_LIMITS.active
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1 || this.maxActive > CHAT_LIMITS.active) throw new Error('CHAT_INVALID_LIMIT')
  }

  private emit(event: ChatEvent): void {
    if (event.kind === 'messages' || event.kind === 'delta') {
      const revision = (this.revisions.get(event.id) || 0) + 1
      this.revisions.set(event.id, revision)
      event = { ...event, revision }
    }
    try { this.emitEvent(event) } catch { /* A closed renderer must not fail persistence or a turn. */ }
  }
  private session(record: ChatRecord): ChatSessionInfo {
    const session = publicSession(record)
    this.emit({ kind: 'session', session })
    return session
  }
  private checkOpen(): void { if (this.closing) throw new Error('CHAT_CLOSED') }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.checkOpen()
      return operation()
    })
    this.locks.set(id, result)
    void result.finally(() => { if (this.locks.get(id) === result) this.locks.delete(id) }).catch(() => {})
    return result
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.activation.catch(() => {}).then(operation)
    this.activation = result.catch(() => {})
    return result
  }
  private activate(record: ChatRecord): Promise<Active> {
    return this.exclusive(async () => {
      this.checkOpen()
      await this.store.authorize(record)
      let slot = this.active.get(record.id)
      if (!slot) {
        if (this.active.size >= this.maxActive) {
          const idle = [...this.active].filter(([id]) => !this.turns.has(id)).sort((a, b) => a[1].touched - b[1].touched)[0]
          if (!idle) throw new Error('CHAT_BUSY_LIMIT')
          idle[1].runtime.dispose()
          this.active.delete(idle[0])
        }
        const runtime = await this.backend.open(record)
        if (this.closing) { runtime.dispose(); throw new Error('CHAT_CLOSED') }
        slot = { runtime, touched: ++this.clock }
        this.active.set(record.id, slot)
      }
      slot.touched = ++this.clock
      const runtime = slot.runtime
      if (record.model !== runtime.model || record.effectiveThinkingLevel !== runtime.thinkingLevel || JSON.stringify(record.thinkingLevels) !== JSON.stringify(runtime.thinkingLevels)) {
        try {
          this.session(await this.store.update(record.id, (stored) => {
            if (runtime.model) stored.model = runtime.model
            stored.effectiveThinkingLevel = runtime.thinkingLevel
            stored.thinkingLevels = runtime.thinkingLevels
          }))
        } catch (error) {
          runtime.dispose()
          this.active.delete(record.id)
          throw error
        }
      }
      return slot
    })
  }

  async list() {
    chatSchemas.list.parse({})
    this.checkOpen()
    return { sessions: (await this.store.list()).map(publicSession) }
  }
  create(input: unknown) {
    const request = chatSchemas.create.parse(input)
    // This also serializes creation against shutdown; IDs are allocated by the store.
    return this.serial('$create', async () => {
      const level = request.thinkingLevel ?? 'off'
      // Legacy model-less/off creation stays lazy. Non-off requires a concrete model.
      if (!request.model && level !== 'off') throw new Error('CHAT_MODEL_REQUIRED')
      const thinkingLevels = request.model ? await this.backend.thinkingLevels(request.model) : undefined
      if (thinkingLevels && !thinkingLevels.includes(level)) throw new Error('CHAT_THINKING_UNSUPPORTED')
      return { session: this.session(await this.store.create({ ...request, thinkingLevel: level, thinkingLevels })) }
    })
  }
  open(input: unknown) {
    const { id } = chatSchemas.open.parse(input)
    return this.serial(id, async () => {
      let record = await this.store.get(id)
      try {
        const slot = await this.activate(record)
        const messages = slot.messages ?? slot.runtime.history()
        record = await this.store.get(id)
        const session = this.session(record)
        this.emit({ kind: 'messages', id, messages })
        return { session, messages, revision: this.revisions.get(id) || 0 }
      } catch {
        if (!this.turns.has(id)) {
          record = await this.store.update(id, (stored) => { stored.status = 'failed'; stored.error = 'CHAT_OPEN_FAILED' })
          this.session(record)
        }
        this.emit({ kind: 'error', id, error: 'CHAT_OPEN_FAILED' })
        throw new Error('CHAT_OPEN_FAILED')
      }
    })
  }
  setThinking(input: unknown) {
    const { id, level } = chatSchemas.setThinking.parse(input)
    return this.serial(id, async () => {
      const record = await this.store.get(id)
      if (this.turns.has(id) || record.status === 'running') throw new Error('CHAT_SESSION_BUSY')
      if (record.status !== 'idle') throw new Error('CHAT_SESSION_NOT_IDLE')
      const slot = await this.activate(record)
      if (!slot.runtime.thinkingLevels.includes(level)) throw new Error('CHAT_THINKING_UNSUPPORTED')
      try {
        const effective = slot.runtime.setThinkingLevel(level)
        if (effective !== level) throw new Error('CHAT_THINKING_UNSUPPORTED')
        const updated = await this.store.update(id, (stored) => {
          stored.thinkingLevel = level
          stored.effectiveThinkingLevel = effective
          stored.thinkingLevels = slot.runtime.thinkingLevels
        })
        return { session: this.session(updated) }
      } catch (error) {
        // A failed metadata write must not leave a live runtime using an uncommitted level.
        // Reopening explicitly reapplies the authoritative requested metadata, not JSONL.
        await this.exclusive(async () => {
          if (this.active.get(id) === slot) {
            slot.runtime.dispose()
            this.active.delete(id)
          }
        })
        throw error
      }
    })
  }
  send(input: unknown): Promise<{ accepted: true }> {
    const request = chatSchemas.send.parse(input)
    const { id } = request
    return this.serial(id, async () => {
      await this.store.get(id)
      if (this.turns.has(id)) throw new Error('CHAT_SESSION_BUSY')
      if (this.turns.size >= this.maxActive) throw new Error('CHAT_BUSY_LIMIT')
      // Reserve before any await, so concurrent sends cannot oversubscribe the pool.
      const turn: Turn = { cancelled: false, failed: false, done: Promise.resolve() }
      this.turns.set(id, turn)
      try {
        const record = await this.store.update(id, (stored) => {
          stored.status = 'running'
          delete stored.error
          if (stored.title === 'New chat') stored.title = request.text.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Image conversation'
        })
        this.session(record)
        // Scheduling (rather than awaiting prompt) gives an immediate busy-before-ACK boundary.
        turn.done = new Promise<void>((resolve) => {
          setImmediate(() => { void this.run(record, request, turn).catch(() => {
            this.turns.delete(id)
            this.emit({ kind: 'error', id, error: 'CHAT_TURN_FAILED' })
          }).finally(resolve) })
        })
        return { accepted: true }
      } catch (error) {
        this.turns.delete(id)
        throw error
      }
    })
  }

  private onRuntime(id: string, slot: Active, turn: Turn, event: RuntimeEvent): void {
    if (event.kind === 'failure') { turn.failed = true; return }
    if (event.kind === 'messages') {
      slot.messages = event.messages
      this.emit({ kind: 'messages', id, messages: event.messages })
    } else {
      slot.messages = slot.messages?.map((message) => message.id === event.messageId ? { ...message, text: (message.text + event.delta).slice(0, CHAT_LIMITS.textChars) } : message)
      this.emit({ kind: 'delta', id, messageId: event.messageId, delta: event.delta })
    }
  }

  private async run(record: ChatRecord, request: ReturnType<typeof chatSchemas.send.parse>, turn: Turn): Promise<void> {
    const id = record.id
    let slot: Active | undefined
    let unsubscribe: (() => void) | undefined
    try {
      if (turn.cancelled || this.closing) return
      slot = await this.activate(record)
      turn.runtime = slot.runtime
      if (turn.cancelled || this.closing) return
      slot.messages = undefined
      unsubscribe = slot.runtime.subscribe((event) => this.onRuntime(id, slot!, turn, event))
      await slot.runtime.prompt(request.text, request.images)
    } catch {
      if (!turn.cancelled && !this.closing) turn.failed = true
    } finally {
      try { unsubscribe?.() } catch { /* A faulty subscriber must not strand busy state. */ }
      if (slot) {
        slot.messages = undefined
        try { this.emit({ kind: 'messages', id, messages: slot.runtime.history() }) }
        catch { if (!turn.cancelled) turn.failed = true }
      }
      try {
        const updated = await this.store.update(id, (stored) => {
          stored.status = turn.failed && !turn.cancelled ? 'failed' : 'idle'
          if (slot?.runtime.model) stored.model = slot.runtime.model
          if (stored.status === 'failed') stored.error = 'CHAT_TURN_FAILED'
          else delete stored.error
        })
        this.session(updated)
        if (updated.status === 'failed') this.emit({ kind: 'error', id, error: 'CHAT_TURN_FAILED' })
      } catch {
        // Do not persist raw filesystem/provider errors, which may contain secrets or paths.
        this.emit({ kind: 'error', id, error: 'CHAT_PERSIST_FAILED' })
      } finally { this.turns.delete(id) }
    }
  }

  private async stop(id: string): Promise<void> {
    const turn = this.turns.get(id)
    if (!turn) return
    turn.cancelled = true
    try { await turn.runtime?.abort() } catch { /* Still join finalization. */ }
    await turn.done
  }
  abort(input: unknown) {
    const { id } = chatSchemas.abort.parse(input)
    return this.serial(id, async () => { await this.store.get(id); await this.stop(id); return { ok: true as const } })
  }
  rename(input: unknown) {
    const { id, title } = chatSchemas.rename.parse(input)
    return this.serial(id, async () => ({ session: this.session(await this.store.update(id, (stored) => { stored.title = title })) }))
  }
  delete(input: unknown) {
    const { id } = chatSchemas.delete.parse(input)
    return this.serial(id, async () => {
      const record = await this.store.get(id)
      await this.stop(id)
      await this.exclusive(async () => {
        this.active.get(id)?.runtime.dispose()
        this.active.delete(id)
      })
      // Remove the allowlist entry first: a crash during cleanup cannot resurrect this session.
      await this.store.remove(id)
      this.emit({ kind: 'deleted', id })
      this.revisions.delete(id)
      await this.store.removeWorkspace(record).catch(() => {
        this.emit({ kind: 'error', id, error: 'CHAT_DELETE_CLEANUP_FAILED' })
      })
      return { ok: true as const }
    })
  }
  async models() {
    this.checkOpen()
    try { return { models: await this.backend.models() } } catch { throw new Error('CHAT_MODELS_FAILED') }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = (async () => {
      try { this.backend.dispose?.() } catch { /* Continue session cleanup. */ }
      for (const turn of this.turns.values()) {
        turn.cancelled = true
        void turn.runtime?.abort().catch(() => {})
      }
      await Promise.allSettled([...this.locks.values()])
      await Promise.allSettled([...this.turns.keys()].map((id) => this.stop(id)))
      await this.exclusive(async () => {
        for (const slot of this.active.values()) {
          try { slot.runtime.dispose() } catch { /* Dispose every session, even if one fails. */ }
        }
        this.active.clear()
      })
      await this.store.flush()
    })()
    return this.shutdownPromise
  }
}
