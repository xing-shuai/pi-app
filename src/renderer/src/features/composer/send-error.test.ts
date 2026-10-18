import { expect, it } from 'vitest'
import { composerSendErrorDescription } from './send-error'
it('explains the session initialization guard without an opaque internal token', () => {
  expect(composerSendErrorDescription(new Error("Error invoking remote method 'ipc:prompt.send': Error: EPHEMERAL_SANDBOX_DRAFT"))).toContain('initialization')
})
it('keeps a useful cause but does not expose common credentials or unlimited output', () => {
  expect(composerSendErrorDescription(new Error('HTTP 401, Authorization: Bearer private-key api_key=other-private'))).not.toContain('private')
  expect(composerSendErrorDescription('x'.repeat(900))).toHaveLength(800)
  expect(composerSendErrorDescription(new Error('Model was not found'))).toBe('Model was not found')
})
