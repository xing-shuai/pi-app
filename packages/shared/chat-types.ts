/** Chat is intentionally independent of Code sessions and SDK runtime imports. */
export const CHAT_EVENT_CHANNEL = 'ipc:chat-event' as const

/** Values understood by the bundled Pi SDK; each model exposes only a subset. */
export type ChatThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ChatSessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model?: string
  /** Requested level. Missing on pre-thinking records means off. */
  thinkingLevel?: ChatThinkingLevel
  /** Actual SDK level after restore/clamping; this is the value to display. */
  effectiveThinkingLevel?: ChatThinkingLevel
  thinkingLevels?: ChatThinkingLevel[]
  status: 'idle' | 'running' | 'failed'
  error?: string
}

export interface ChatImage { data: string; mimeType: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  images?: ChatImage[]
}

export type ChatEvent =
  | { kind: 'session'; session: ChatSessionInfo }
  | { kind: 'messages'; id: string; messages: ChatMessage[]; revision?: number }
  | { kind: 'delta'; id: string; messageId: string; delta: string; revision?: number }
  | { kind: 'deleted'; id: string }
  | { kind: 'error'; id: string; error: string }

export interface ChatModelInfo {
  id: string
  provider: string
  name: string
  reasoning?: boolean
  thinkingLevels?: ChatThinkingLevel[]
}
