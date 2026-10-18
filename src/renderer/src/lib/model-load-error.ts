/** Only fixed host diagnostics are displayed; arbitrary provider/SSH errors can contain secrets. */
export function modelLoadFailure(error: unknown): { message: string; permanent: boolean } {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /\bunsafe_session_directory(?::(pi-config|desktop-code|sessions|workspace):(symlink|not-directory|owner|changed|write-access):([0-7]{4}))?\b/.exec(raw)
  if (match) {
    const names: Record<string, string> = { 'pi-config': 'global Pi configuration directory (~/.pi)', 'desktop-code': 'desktop session storage directory', sessions: 'private sessions directory', workspace: 'workspace session directory' }
    const name = names[match[1]] || 'session storage directory'
    const reasons: Record<string, string> = { symlink: 'is a symbolic link', 'not-directory': 'is not a directory', owner: 'belongs to another OS user', changed: 'changed during validation', 'write-access': 'allows other users to write' }
    if (match[1] === 'pi-config' && match[2] === 'write-access' && (parseInt(match[3], 8) & 0o002) === 0) return { permanent: true, message: `The connected SSH helper rejected shared-group permissions on the global Pi configuration directory (~/.pi) (mode ${match[3]}). Disconnect and reconnect SSH to load the updated helper; do not change global Pi permissions.` }
    return { permanent: true, message: match[2]
      ? `Remote ${name} ${reasons[match[2]]} (mode ${match[3]}). Check the SSH account/HOME and directory permissions. Global Pi permissions were not changed.`
      : 'Remote session directory validation failed. SSH is connected, but Pi/model discovery could not start. Check directory ownership/permissions and retry; no local models were substituted.' }
  }
  return { permanent: false, message: 'The model list could not be loaded. Retry to query this execution host again.' }
}
