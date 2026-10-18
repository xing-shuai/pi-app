import { describe, expect, it } from 'vitest'
import { emptyRemoteChat, historyMessages, reduceRemoteChat } from './ssh-state'

describe('remote chat projection', () => {
  it('streams and replaces assistant output with authoritative final text', () => {
    let state = reduceRemoteChat(emptyRemoteChat, { type: 'agent_start' })
    state = reduceRemoteChat(state, { type: 'message_start', message: { role: 'assistant' } })
    state = reduceRemoteChat(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })
    expect(state.messages[0].text).toBe('partial')
    state = reduceRemoteChat(state, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ text: 'final', pending: false })
    expect(reduceRemoteChat(state, { type: 'agent_end' }).busy).toBe(true)
    expect(reduceRemoteChat(state, { type: 'agent_settled' }).busy).toBe(false)
  })
  it('projects tool results without injecting local file links', () => {
    let state = reduceRemoteChat(emptyRemoteChat, { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 'pwd' } })
    state = reduceRemoteChat(state, { type: 'tool_execution_end', toolCallId: 'x', result: { content: [{ type: 'text', text: '/remote/project' }] } })
    expect(state.messages[0]).toMatchObject({ role: 'tool', pending: false })
    expect(state.messages[0].text).toContain('/remote/project')
  })
  it('restores user, assistant and tool history but not hidden reasoning', () => {
    expect(historyMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'reply' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'output' }] },
    ]).map((m) => [m.role, m.text])).toEqual([['user', 'hello'], ['assistant', 'reply'], ['tool', 'output']])
  })
})
