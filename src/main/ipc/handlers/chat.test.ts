import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodSchema } from 'zod'
import type { ChatEvent } from '../../../../packages/shared/chat-types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown) => Promise<unknown>>(),
  beforeQuit: undefined as undefined | ((event: { preventDefault(): void }) => void),
  emit: undefined as undefined | ((event: ChatEvent) => void),
  sendEvent: vi.fn(), quit: vi.fn(),
  list: vi.fn(async () => ({ sessions: [] })), create: vi.fn(async () => ({})),
  open: vi.fn(async () => ({})), send: vi.fn(async () => ({ accepted: true })),
  abort: vi.fn(async () => ({ ok: true })), rename: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({ ok: true })), models: vi.fn(async () => ({ models: [] })),
  shutdown: vi.fn(async () => {}), setThinking: vi.fn(async () => ({})),
}))
vi.mock('electron', () => ({ app: {
  getPath: () => '/private/user-data', quit: mocks.quit,
  on: (name: string, callback: typeof mocks.beforeQuit) => { if (name === 'before-quit') mocks.beforeQuit = callback },
} }))
vi.mock('../registry', () => ({ registerHandlerWithSchema: (channel: string, schema: ZodSchema, callback: (request: unknown) => Promise<unknown>) => {
  mocks.handlers.set(channel, async (request) => callback(schema.parse(request)))
} }))
vi.mock('../../window', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.sendEvent } }) }))
vi.mock('../../chat/store', () => ({ ChatStore: class {} }))
vi.mock('../../chat/sdk', () => ({ createChatBackend: vi.fn(() => ({})) }))
vi.mock('../../chat/service', () => ({ ChatService: class {
  constructor(options: { emit: (event: ChatEvent) => void }) { mocks.emit = options.emit }
  list = mocks.list; create = mocks.create; open = mocks.open; send = mocks.send
  abort = mocks.abort; rename = mocks.rename; delete = mocks.delete; models = mocks.models
  shutdown = mocks.shutdown; setThinking = mocks.setThinking
} }))
import { registerChatHandlers, chatRuntime } from './chat'

describe('Chat IPC contract', () => {
  beforeEach(() => { mocks.handlers.clear(); vi.clearAllMocks(); registerChatHandlers() })
  it('registers exactly the required nine validated endpoints, and rejects path capabilities', async () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(['abort', 'create', 'delete', 'list', 'models', 'open', 'rename', 'send', 'setThinking'].map((name) => `ipc:chat.${name}`).sort())
    await expect(mocks.handlers.get('ipc:chat.list')!({})).resolves.toEqual({ sessions: [] })
    await expect(mocks.handlers.get('ipc:chat.open')!({ id: '../../code/session.jsonl' })).rejects.toThrow()
    await expect(mocks.handlers.get('ipc:chat.create')!({ cwd: '/project' })).rejects.toThrow()
    await expect(mocks.handlers.get('ipc:chat.models')!({ agentDir: '/other' })).rejects.toThrow()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('validates and routes thinking requests without accepting extra capabilities', async () => {
    const id = '175a1f7f-75bd-47f0-8188-788282755caf'
    await mocks.handlers.get('ipc:chat.create')!({ thinkingLevel: 'high', model: 'test/model' })
    expect(mocks.create).toHaveBeenCalledWith({ thinkingLevel: 'high', model: 'test/model' })
    await mocks.handlers.get('ipc:chat.setThinking')!({ id, level: 'max' })
    expect(mocks.setThinking).toHaveBeenCalledWith({ id, level: 'max' })
    await expect(mocks.handlers.get('ipc:chat.setThinking')!({ id, level: 'unlimited' })).rejects.toThrow()
    await expect(mocks.handlers.get('ipc:chat.setThinking')!({ id, level: 'high', cwd: '/project' })).rejects.toThrow()
  })
  it('routes only to ipc:chat-event, never Code ipc:events', async () => {
    await mocks.handlers.get('ipc:chat.list')!({})
    mocks.emit!({ kind: 'deleted', id: 'example' })
    expect(mocks.sendEvent).toHaveBeenCalledWith('ipc:chat-event', { kind: 'deleted', id: 'example' })
    expect(mocks.sendEvent).not.toHaveBeenCalledWith('ipc:events', expect.anything())
  })
  it('sanitizes errors and leaves quit approval to the central guard before idempotent shutdown', async () => {
    mocks.models.mockRejectedValueOnce(new Error('/private/path SECRET_KEY'))
    await expect(mocks.handlers.get('ipc:chat.models')!({})).rejects.toThrow('CHAT_OPERATION_FAILED')
    let finish!: () => void
    mocks.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(mocks.beforeQuit).toBeUndefined()
    const first = chatRuntime.shutdown()
    const second = chatRuntime.shutdown()
    expect(first).toBe(second)
    expect(mocks.quit).not.toHaveBeenCalled()
    finish()
    await expect(first).resolves.toEqual({ settled: true })
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })
})
