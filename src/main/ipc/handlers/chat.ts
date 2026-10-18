import { app } from 'electron'
import { CHAT_EVENT_CHANNEL } from '../../../../packages/shared/chat-types'
import { ChatService } from '../../chat/service'
import { createChatBackend } from '../../chat/sdk'
import { ChatStore } from '../../chat/store'
import { chatSchemas } from '../../chat/validation'
import { getMainWindow } from '../../window'
import { registerHandlerWithSchema } from '../registry'

let service: ChatService | undefined
let shutdownPromise: Promise<{ settled: boolean }> | undefined
const running = new Set<string>()

/** Central app close guard must decide before any Chat shutdown begins. */
export const chatRuntime = {
  get hasActiveWork(): boolean { return service?.hasActiveWork ?? false },
  shutdown(waitMs = 5000): Promise<{ settled: boolean }> {
    if (!service) return Promise.resolve({ settled: true })
    return shutdownPromise ??= new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), waitMs)
      timer.unref?.()
      void service!.shutdown().then(() => { clearTimeout(timer); resolve({ settled: true }) }, () => { clearTimeout(timer); resolve({ settled: false }) })
    })
  },
}

export function getChatService(): ChatService {
  return service ??= new ChatService({
    store: new ChatStore(app.getPath('userData')),
    backend: createChatBackend(),
    emit(event) {
      if (event.kind === 'session') {
        if (event.session.status === 'running') running.add(event.session.id)
        else if (running.delete(event.session.id)) {
          const session = event.session
          void import('../../product-notifications').then(({ notifyProductCompletion }) => notifyProductCompletion({ key: `chat:${session.id}:${session.updatedAt}`, title: session.title, failed: session.status === 'failed' })).catch(() => {})
        }
      }
      const window = getMainWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(CHAT_EVENT_CHANNEL, event)
      }
    },
  })
}

/** Prevent native paths, provider payloads, or credentials leaking via rejected IPC promises. */
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new Error(/^CHAT_[A-Z_]+$/.test(message) ? message : 'CHAT_OPERATION_FAILED')
  }
}

export function registerChatHandlers(): void {
  registerHandlerWithSchema('ipc:chat.list', chatSchemas.list, async () => safe(() => getChatService().list()))
  registerHandlerWithSchema('ipc:chat.create', chatSchemas.create, async (request) => safe(() => getChatService().create(request)))
  registerHandlerWithSchema('ipc:chat.open', chatSchemas.open, async (request) => safe(() => getChatService().open(request)))
  registerHandlerWithSchema('ipc:chat.send', chatSchemas.send, async (request) => safe(() => getChatService().send(request)))
  registerHandlerWithSchema('ipc:chat.setThinking', chatSchemas.setThinking, async (request) => safe(() => getChatService().setThinking(request)))
  registerHandlerWithSchema('ipc:chat.abort', chatSchemas.abort, async (request) => safe(() => getChatService().abort(request)))
  registerHandlerWithSchema('ipc:chat.rename', chatSchemas.rename, async (request) => safe(() => getChatService().rename(request)))
  registerHandlerWithSchema('ipc:chat.delete', chatSchemas.delete, async (request) => safe(() => getChatService().delete(request)))
  registerHandlerWithSchema('ipc:chat.models', chatSchemas.models, async () => safe(() => getChatService().models()))

  // No independent before-quit hook: the central guard owns ask/wait/cancel/now semantics.
}
