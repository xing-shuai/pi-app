import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSession, ModelRuntime, ResourceLoader, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ChatImage, ChatMessage, ChatModelInfo, ChatThinkingLevel } from '../../../packages/shared/chat-types'
import type { ChatRecord } from './store'
import { CHAT_LIMITS, chatImageSchema, splitChatModel } from './validation'

export type ChatSdk = typeof import('@earendil-works/pi-coding-agent')
export type RuntimeEvent =
  | { kind: 'messages'; messages: ChatMessage[] }
  | { kind: 'delta'; messageId: string; delta: string }
  | { kind: 'failure' }
export interface ChatRuntime {
  model?: string
  readonly thinkingLevel: ChatThinkingLevel
  readonly thinkingLevels: ChatThinkingLevel[]
  setThinkingLevel(level: ChatThinkingLevel): ChatThinkingLevel
  history(): ChatMessage[]
  subscribe(listener: (event: RuntimeEvent) => void): () => void
  prompt(text: string, images?: ChatImage[]): Promise<void>
  abort(): Promise<void>
  dispose(): void
}
export interface ChatBackend {
  open(record: ChatRecord): Promise<ChatRuntime>
  models(): Promise<ChatModelInfo[]>
  thinkingLevels(model: string): Promise<ChatThinkingLevel[]>
  dispose?(): void
}

/** Deliberately does not import agent-dir.ts, sdk-loader, config-store, or WSL selection. */
export function hostChatAgentDir(env = process.env, home = homedir()): string {
  let dir = env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent')
  if (dir === '~') dir = home
  else if (dir.startsWith('~/') || (process.platform === 'win32' && dir.startsWith('~\\'))) dir = join(home, dir.slice(2))
  return resolve(dir)
}

/** No DefaultResourceLoader: even reload/extend cannot discover or execute anything. */
export function chatResourceLoader(sdk: Pick<ChatSdk, 'createExtensionRuntime'>): ResourceLoader {
  const runtime = sdk.createExtensionRuntime()
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'You are a helpful conversational assistant. You have no tools, filesystem access, shell, browser, or external integrations. Use only this conversation and attachments supplied by the user. Do not claim to have performed external actions.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

/** Display raw active-branch user/assistant text, not model context summaries or tool data. */
export function chatHistory(entries: readonly SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = message.content
    const text = typeof content === 'string' ? content : content
      .filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('')
    const images: ChatImage[] = []
    if (message.role === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'image' || images.length >= CHAT_LIMITS.imageCount) continue
        const safe = chatImageSchema.safeParse({ data: block.data, mimeType: block.mimeType })
        if (safe.success) images.push(safe.data)
      }
    }
    messages.push({ id: entry.id, role: message.role, text: text.slice(0, CHAT_LIMITS.textChars), ...(images.length ? { images } : {}) })
  }
  return messages.slice(-CHAT_LIMITS.historyMessages)
}

function assertNoTools(session: AgentSession): void {
  if (session.getActiveToolNames().length !== 0 || session.agent.state.tools.length !== 0) {
    session.dispose()
    throw new Error('CHAT_TOOL_POLICY_VIOLATION')
  }
}

export async function createIsolatedChatSession(sdk: ChatSdk, modelRuntime: ModelRuntime, record: ChatRecord, agentDir: string): Promise<AgentSession> {
  const model = record.model ? modelRuntime.getModel(...splitChatModel(record.model)) : undefined
  if (record.model && !model) throw new Error('CHAT_MODEL_UNAVAILABLE')
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [],
    enableSkillCommands: false, enableInstallTelemetry: false,
    defaultProjectTrust: 'never', cacheWarming: 'off',
    compaction: { enabled: false }, retry: { enabled: false },
    // IPC already enforces byte/MIME/count caps. Do not invoke image-conversion
    // workers or Photon WASM fallback discovery from the process working folder.
    images: { autoResize: false, blockImages: false },
  })
  const { session } = await sdk.createAgentSession({
    cwd: record.cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader: chatResourceLoader(sdk),
    settingsManager,
    sessionManager: sdk.SessionManager.open(record.sessionFile, record.cwd, record.cwd),
    noTools: 'all',
    tools: [],
    customTools: [],
    // Metadata is authoritative even when the JSONL has a different last level.
    // On capability changes the SDK clamps; the service records the effective value.
    thinkingLevel: record.thinkingLevel ?? 'off',
  })
  assertNoTools(session)
  return session
}

export function wrapChatSession(session: AgentSession): ChatRuntime {
  const history = () => chatHistory(session.sessionManager.getBranch())
  let controller: AbortController | undefined
  const stream = session.agent.streamFunction
  // SDK abort() only aborts an already-started agent run. Keep cancellation live
  // through async auth/image preflight too, so it cannot start a late request.
  session.agent.streamFunction = (model, context, options) => {
    assertNoTools(session)
    if (controller?.signal.aborted) throw new Error('CHAT_ABORTED')
    return stream(model, context, { ...options, signal: controller
      ? options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      : options?.signal })
  }
  return {
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    get thinkingLevel() { return session.thinkingLevel },
    get thinkingLevels(): ChatThinkingLevel[] { return session.model ? session.getAvailableThinkingLevels() : ['off'] },
    setThinkingLevel(level) {
      if (session.isStreaming) throw new Error('CHAT_SESSION_BUSY')
      if (!session.model || !session.getAvailableThinkingLevels().includes(level)) throw new Error('CHAT_THINKING_UNSUPPORTED')
      session.setThinkingLevel(level, { persist: false })
      return session.thinkingLevel
    },
    history,
    subscribe(listener) {
      let pendingId: string | undefined
      let pendingText = ''
      let alive = true
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          pendingId = randomUUID()
          pendingText = ''
          listener({ kind: 'messages', messages: [...history(), { id: pendingId, role: 'assistant', text: '', pending: true }] })
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          if (!pendingId) pendingId = randomUUID()
          const delta = event.assistantMessageEvent.delta.slice(0, Math.max(0, CHAT_LIMITS.textChars - pendingText.length))
          pendingText += delta
          if (delta) listener({ kind: 'delta', messageId: pendingId, delta })
        }
        if (event.type === 'message_end') {
          if (event.message.role === 'assistant' && event.message.stopReason === 'error') listener({ kind: 'failure' })
          // Public message_end precedes the SDK's JSONL append. Read on the
          // next microtask so the snapshot includes the authoritative entry.
          queueMicrotask(() => { if (alive) listener({ kind: 'messages', messages: history() }) })
          if (event.message.role === 'assistant') pendingId = undefined
        }
      })
      return () => { alive = false; unsubscribe() }
    },
    async prompt(text, images) {
      assertNoTools(session)
      controller = new AbortController()
      await session.prompt(text, { expandPromptTemplates: false, images: images?.map((image) => ({ type: 'image', ...image })) })
      assertNoTools(session)
    },
    abort: () => { controller?.abort(); return session.abort() },
    dispose: () => { controller?.abort(); session.dispose() },
  }
}

/** Only the bundled package is imported, on first Chat use, never global/selected SDKs. */
export function createChatBackend(loadSdk: () => Promise<ChatSdk> = () => import('@earendil-works/pi-coding-agent'), agentDir = hostChatAgentDir()): ChatBackend {
  let initialized: Promise<{ sdk: ChatSdk; runtime: ModelRuntime; supported: typeof import('@earendil-works/pi-ai').getSupportedThinkingLevels }> | undefined
  const lifecycle = new AbortController()
  const get = () => {
    if (lifecycle.signal.aborted) return Promise.reject(new Error('CHAT_CLOSED'))
    return initialized ??= (async () => {
      const sdk = await loadSdk()
      if (lifecycle.signal.aborted) throw new Error('CHAT_CLOSED')
      const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false, signal: lifecycle.signal })
      const { getSupportedThinkingLevels: supported } = await import('@earendil-works/pi-ai')
      return { sdk, runtime, supported }
    })().catch((error) => { initialized = undefined; throw error })
  }
  return {
    async open(record) {
      const { sdk, runtime } = await get()
      return wrapChatSession(await createIsolatedChatSession(sdk, runtime, record, agentDir))
    },
    async models() {
      const { runtime, supported } = await get()
      return (await runtime.getAvailable(undefined, { signal: lifecycle.signal })).slice(0, 10_000).map((model) => ({ id: model.id, provider: model.provider, name: model.name || model.id, reasoning: !!model.reasoning, thinkingLevels: supported(model) }))
    },
    async thinkingLevels(modelId) {
      const { runtime, supported } = await get()
      const model = runtime.getModel(...splitChatModel(modelId))
      if (!model) throw new Error('CHAT_MODEL_UNAVAILABLE')
      return supported(model)
    },
    dispose: () => lifecycle.abort(),
  }
}
