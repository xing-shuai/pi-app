import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { skipAgentNameOnboarding as sharedPolicy } from '../../packages/shared/extension-input'
import { skipAgentNameOnboarding } from './onboarding'
import { Sessions } from './sessions'
import type { Files } from './files'
import type { Processes } from './common'
it('keeps the standalone helper cancellation policy aligned without shared runtime imports', () => {
  for (const [title, value] of [['Agent name: (default: project)', { defaultValue: 'project' }], ['Allow shell?', { defaultValue: 'yes' }], ['Agent name: (default: other)', { defaultValue: 'project' }], ['Branch?', 'main'], ['Agent name: (default: project)', null]] as const) {
    expect(skipAgentNameOnboarding(title, value)).toBe(sharedPolicy(title, value))
  }
})
it('cancels pre-handshake optional input using its original ID but forwards real permission prompts', () => {
  const event = vi.fn(), stream = new PassThrough(), writes: string[] = []
  stream.on('data', (chunk) => writes.push(chunk.toString()))
  const sessions = new Sessions({} as Files, {} as Processes, event)
  const runtime = { child: { stdin: stream }, workspace: { id: 'root' }, id: 'runtime', pending: new Map() }
  const receive = (sessions as unknown as { receive: (runtime: unknown, record: Record<string, unknown>) => void }).receive.bind(sessions)
  receive(runtime, { type: 'extension_ui_request', method: 'input', id: 'original-id', title: 'Agent name: (default: project)', placeholder: { defaultValue: 'project' } })
  expect(writes.map((line) => JSON.parse(line))).toEqual([{ type: 'extension_ui_response', id: 'original-id', cancelled: true }])
  expect(event).not.toHaveBeenCalled()
  receive(runtime, { type: 'extension_ui_request', method: 'confirm', id: 'approval-id', title: 'Allow command?', message: 'Changes files' })
  expect(event).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ method: 'confirm', id: 'approval-id' }) }))
  expect(writes).toHaveLength(1)
  stream.destroy()
})
