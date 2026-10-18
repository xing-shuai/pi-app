import type { SshRecord } from '@shared/ssh-workspace'

export type RemoteMessage = { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; pending?: boolean }
export type RemoteChatState = { messages: RemoteMessage[]; streamingId?: string; busy: boolean }
export const emptyRemoteChat: RemoteChatState = { messages: [], busy: false }
const LIMIT = 200000
export function recordText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, LIMIT)
  if (!Array.isArray(value)) return ''
  return value.filter((b) => b && typeof b === 'object' && b.type === 'text').map((b) => b.text || '').join('\n').slice(0, LIMIT)
}
export function historyMessages(values: unknown[]): RemoteMessage[] {
  return values.flatMap<RemoteMessage>((v, i) => {
    if (!v || typeof v !== 'object') return []
    const m = v as Record<string, unknown>
    const text = recordText(m.content)
    if (!text || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'toolResult')) return []
    return [{ id: `history-${i}`, role: m.role === 'toolResult' ? 'tool' as const : m.role, text }]
  }).slice(-200)
}
export function reduceRemoteChat(state: RemoteChatState, event: SshRecord): RemoteChatState {
  let next = state
  const replace = (id: string, message: RemoteMessage) => state.messages.map((m) => m.id === id ? message : m)
  if (event.type === 'agent_start') next = { ...state, busy: true }
  if (event.type === 'agent_settled') next = { ...state, busy: false, streamingId: undefined }
  const message = event.message as Record<string, unknown> | undefined
  if (event.type === 'message_start' && message?.role === 'assistant') {
    const id = `assistant-${crypto.randomUUID()}`
    next = { ...state, streamingId: id, messages: [...state.messages, { id, role: 'assistant', text: '', pending: true }] }
  }
  const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
  if (event.type === 'message_update' && delta?.type === 'text_delta' && state.streamingId) {
    next = { ...state, messages: state.messages.map((m) => m.id === state.streamingId ? { ...m, text: (m.text + (delta.delta || '')).slice(0, LIMIT) } : m) }
  }
  if (event.type === 'message_end' && message) {
    const text = recordText(message.content) || (typeof message.errorMessage === 'string' ? message.errorMessage : '')
    if (message.role === 'assistant' && state.streamingId) {
      next = { ...state, streamingId: undefined, messages: replace(state.streamingId, { id: state.streamingId, role: 'assistant', text, pending: false }) }
    } else if (message.role === 'user') {
      next = { ...state, messages: [...state.messages, { id: crypto.randomUUID(), role: 'user', text }] }
    }
  }
  if (event.type === 'tool_execution_start') {
    next = { ...state, messages: [...state.messages, { id: `tool-${event.toolCallId}`, role: 'tool', text: `${event.toolName}\n${JSON.stringify(event.args, null, 2)}`.slice(0, LIMIT), pending: true }] }
  }
  if (event.type === 'tool_execution_end') {
    const result = event.result as { content?: unknown } | undefined
    next = { ...state, messages: state.messages.map((m) => m.id === `tool-${event.toolCallId}` ? { ...m, pending: false, text: `${m.text}\n\n${event.isError ? 'Error: ' : ''}${recordText(result?.content)}`.slice(0, LIMIT) } : m) }
  }
  return { ...next, messages: next.messages.slice(-200) }
}
