import { describe, expect, it } from 'vitest'
import { needsRemotePathReview, sshErrorMessage } from './ssh-error'

describe('actionable SSH error presentation', () => {
  it('removes Electron invoke boilerplate without changing the backend reason', () => {
    expect(sshErrorMessage(new Error("Error invoking remote method 'ipc:ssh.connect': Error: Remote Pi could not start (exit 127)."))).toBe('Remote Pi could not start (exit 127).')
  })
  it('offers remote path editing for startup failures, not password or local-client failures', () => {
    expect(needsRemotePathReview('Remote Pi could not start (exit 127).')).toBe(true)
    expect(needsRemotePathReview('Pi was not found on the remote machine.')).toBe(true)
    expect(needsRemotePathReview('SSH password authentication failed.')).toBe(false)
    expect(needsRemotePathReview('The local OpenSSH client is not executable on PATH.')).toBe(false)
  })
})
