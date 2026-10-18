import { useState, type FormEvent } from 'react'
import { sshProfileSchema, type SshAuthCapabilities, type SshProfile } from '@shared/ssh-workspace'
import { CodeLocationModal } from './code-location-modal'

export function profileFromHost(draft: SshProfile, hostInput: string): SshProfile {
  const input = hostInput.trim()
  const at = input.lastIndexOf('@')
  const user = at >= 0 ? input.slice(0, at) : undefined
  let host = at >= 0 ? input.slice(at + 1) : input
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return sshProfileSchema.parse({ ...draft, host, user })
}
export function SshConnectionDialog({ initial, authCapabilities, onSave, onTest, onBrowse, onClose }: {
  initial?: SshProfile
  authCapabilities: SshAuthCapabilities
  onSave: (profile: SshProfile) => Promise<void>
  onTest: (profile: SshProfile) => Promise<string>
  onBrowse: (profile: SshProfile) => Promise<string | undefined>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<SshProfile>(initial || { id: crypto.randomUUID(), name: '', host: '', cwd: '/', piPath: 'pi', nodePath: 'node' })
  const [hostInput, setHostInput] = useState(initial ? `${initial.user ? initial.user + '@' : ''}${initial.host}` : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState('')
  const run = async (fn: (profile: SshProfile) => Promise<void>) => {
    setError(''); setTestResult(''); setBusy(true)
    try { const profile = profileFromHost(draft, hostInput); await fn(profile) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not configure this SSH connection') } finally { setBusy(false) }
  }
  const save = (event: FormEvent) => { event.preventDefault(); if (!busy) void run(onSave) }
  return <CodeLocationModal title={initial ? 'Edit SSH connection' : 'Add SSH connection'} onClose={onClose} className="ssh-connection-reference-dialog" footer={<><button type="button" onClick={onClose}>Cancel</button><button type="submit" form="ssh-connection-reference-form" disabled={busy} className="code-location-primary">{initial ? 'Save connection' : 'Add SSH connection'}</button></>}>
    <p className="code-location-description">Connect to a remote machine to run <span>Pi Code</span>.</p>
    <form id="ssh-connection-reference-form" onSubmit={save}><fieldset disabled={busy}>
      <label>Name<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} /></label><p className="code-location-help">A friendly name for this SSH connection.</p>
      <label>SSH host<input required placeholder="user@myserver.com" value={hostInput} onChange={(event) => setHostInput(event.target.value)} autoCapitalize="none" spellCheck={false} /></label><p className="code-location-help">user@myserver.com or a host from ~/.ssh/config.</p>
      <label>SSH port<input type="number" min={1} max={65535} placeholder="22" value={draft.port || ''} onChange={(event) => setDraft({ ...draft, port: event.target.value ? Number(event.target.value) : undefined })} /></label><p className="code-location-help">Leave empty to use default (22) or your SSH configuration.</p>
      <label>SSH key (optional)<input placeholder="~/.ssh/id_ed25519" value={draft.identityFile || ''} disabled={draft.authMethod === 'password'} onChange={(event) => setDraft({ ...draft, identityFile: event.target.value || undefined })} /></label>
      <p className="code-location-help">Path to a private key. Leave empty to use your SSH configuration or agent.</p>
      <label className="connection-auth-selection">Authentication<select aria-label="SSH authentication" value={draft.authMethod || 'agent'} onChange={(event) => setDraft({ ...draft, authMethod: event.target.value as 'agent' | 'password' })}><option value="agent">Key / SSH Agent</option><option value="password" disabled={!authCapabilities.password}>Password · ask on connect, never saved</option></select></label>
      {!authCapabilities.password && <p className="code-location-help">{authCapabilities.passwordUnavailableReason}</p>}
      <label>Worktree folder<p className="code-location-help">Folder on this host where new sessions can create their Git worktrees. Start with ~/ for your home directory there.</p><div className="code-location-browse-row"><input aria-label="Worktree folder" placeholder="Host default" value={draft.worktreeFolder || ''} onChange={(event) => setDraft({ ...draft, worktreeFolder: event.target.value || undefined })} /><button type="button" onClick={() => void run(async (profile) => { const path = await onBrowse(profile); if (path) setDraft((old) => ({ ...old, worktreeFolder: path })) })}>Browse…</button></div></label><p className="code-location-help">Preference only: automatic session worktree creation is not enabled yet. Existing worktrees can be opened as project folders.</p>
      <details className="code-location-advanced"><summary>Advanced runtime paths</summary><label>Remote Pi executable<input value={draft.piPath} onChange={(event) => setDraft({ ...draft, piPath: event.target.value })} /></label><label>Remote Node executable<input value={draft.nodePath} onChange={(event) => setDraft({ ...draft, nodePath: event.target.value })} /></label><p className="code-location-help">Use absolute remote executable paths if login PATH does not include them. Credentials stay on the remote host.</p></details>
      <button type="button" className="code-location-test" onClick={() => void run(async (profile) => setTestResult(await onTest(profile)))}>Test connection</button>
      {error && <p className="code-location-error" role="alert">{error}</p>}{testResult && <p className="code-location-test-result" role="status">{testResult}</p>}
    </fieldset></form>
  </CodeLocationModal>
}
