import { describe, expect, it } from 'vitest'
import type { AppEvent } from '@shared/app-events'
import { isolatePaths, RemoteProjection } from './projection'
function fixture() {
  const events: AppEvent[] = []
  const projection = new RemoteProjection(() => ({ workspaceId: '/__pi_ssh__/profile/hash/root', sessionId: 'id', sessionFile: '/__pi_ssh__/profile/hash/root/.sessions/key' }), (e) => events.push(e))
  return { events, projection }
}
describe('remote Pi event projection', () => {
  it('does not duplicate streamed thinking on authoritative message_end and recovers retry outcome', () => {
    const { events, projection: p } = fixture()
    p.accept({ type: 'agent_start' })
    p.accept({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Temporary provider failure' } })
    p.accept({ type: 'agent_end', willRetry: true })
    expect(p.active).toBe(true)
    p.accept({ type: 'agent_start' })
    p.accept({ type: 'message_start', message: { role: 'assistant', content: [] } })
    p.accept({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Thinking' } })
    p.accept({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Thinking finished' }, { type: 'text', text: 'Final prose' }], stopReason: 'stop' } })
    p.accept({ type: 'agent_settled' })
    const thinking = events.filter((e) => e.type === 'message' && e.contentKind === 'thinking').map((e) => e.type === 'message' ? e.text : '').join('')
    expect(thinking).toBe('Thinking finished')
    expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'success', settled: true })
  })
  it('records abort as cancelled, never as prompt ACK completion; disconnect does not fake success', () => {
    const { events, projection: p } = fixture()
    p.accept({ type: 'agent_start' }); p.cancelRequested()
    expect(events.some((e) => e.type === 'completion')).toBe(false)
    p.accept({ type: 'agent_settled' })
    expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'cancelled' })
    p.accept({ type: 'agent_start' }); p.exited()
    expect(events.at(-1)).toMatchObject({ type: 'agent_error' })
    expect(p.active).toBe(false)
  })
  it('keeps relative and outside structured tool paths entirely in the remote namespace', () => {
    const result = isolatePaths({ args: { path: 'src/file.ts' }, details: { filePath: '/etc/passwd' }, fullOutputPath: '/tmp/log', content: 'normal tool text' }, '/remote/project', '/__pi_ssh__/id/hash/project') as { args: { path: string }; details: { filePath: string }; fullOutputPath: string; content: string }
    expect(result.args.path).toBe('/__pi_ssh__/id/hash/project/src/file.ts')
    expect(result.details.filePath).toContain('/__pi_ssh__/id/hash/project/.outside/')
    expect(result.fullOutputPath).toContain('/__pi_ssh__/id/hash/project/.outside/')
    expect(result.content).toBe('normal tool text')
  })
})
