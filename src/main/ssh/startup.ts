import { REMOTE_STARTUP_MARKERS } from './command'

const HOST_KEY_ERRORS = ['host key verification failed', 'remote host identification has changed']
const signals = Object.entries(REMOTE_STARTUP_MARKERS).map(([key, value]) => [key, value.toLowerCase()] as const)
const phrases = [...HOST_KEY_ERRORS, ...signals.map(([, value]) => value)]

/** Only fixed-phrase prefixes/booleans survive a chunk. Never retain password-mode raw stderr. */
export class SshStartupSignals {
  private prefix = ''
  private numericPrefix = ''
  nodeVersion?: string
  readonly seen = new Set<keyof typeof REMOTE_STARTUP_MARKERS>()
  hostKeyFailure = false
  push(chunk: string): void {
    const text = this.numericPrefix + this.prefix + chunk.toLowerCase()
    this.numericPrefix = ''
    const token = REMOTE_STARTUP_MARKERS.nodeVersion.toLowerCase()
    const versionAt = text.lastIndexOf(token)
    if (versionAt >= 0) {
      const tail = text.slice(versionAt + token.length)
      const version = /^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\r?\n/.exec(tail)
      if (version) this.nodeVersion = version[1]
      // Retain only a fixed prefix plus bounded numeric version, never raw diagnostic text.
      if (/^[0-9.]{0,15}\r?$/.test(tail)) this.numericPrefix = token + tail
    }
    this.hostKeyFailure ||= HOST_KEY_ERRORS.some((phrase) => text.includes(phrase))
    for (const [key, phrase] of signals) if (text.includes(phrase)) this.seen.add(key as keyof typeof REMOTE_STARTUP_MARKERS)
    this.prefix = ''
    for (const phrase of phrases) for (let length = 1; length < phrase.length; length++) {
      if (length > this.prefix.length && text.endsWith(phrase.slice(0, length))) this.prefix = phrase.slice(0, length)
    }
  }
  clearPrefix(): void { this.prefix = ''; this.numericPrefix = '' }
  failure(code: number | null, rpcReady: boolean, localSshVerified: boolean): string | undefined {
    const exit = code === null ? 'signal' : String(code)
    const version = this.nodeVersion ? ` (Node ${this.nodeVersion})` : ''
    if (rpcReady) return `SSH connection closed (${exit}). The network or remote Pi process stopped; pending operation outcomes may be unknown.`
    if (code === 5 && !this.seen.has('shell')) return undefined // sshpass's authentication failure, not a remote program exit.
    if (!this.seen.has('shell') && (this.hostKeyFailure || code === 6 || code === 7)) return 'SSH host key verification failed. Verify the host using your trusted OpenSSH known_hosts setup before connecting.'
    if (this.seen.has('cwdMissing')) return 'SSH reached the remote shell, but the remote workspace is missing or inaccessible. Check the absolute remote folder path.'
    if (this.seen.has('nodeUnsupported')) return `Remote Node${version} is too old for this helper. Select an actual Node 22.19+ executable in Advanced runtime paths. No Pi process has started.`
    if (this.seen.has('nodeProbeFailed')) return 'The configured remote executable could not report a valid Node version. Check the actual Node binary, wrappers and NODE_OPTIONS startup hooks; Pi has not started.'
    if (this.seen.has('nodeMissing')) return 'SSH reached the remote shell, but the configured remote Node executable was not found. Set its absolute path; this is not a missing local SSH client.'
    if (this.seen.has('piMissing')) return 'SSH reached the remote shell, but Pi was not found on the remote machine. Install Pi remotely or set Remote Pi executable to its absolute path.'
    if (this.seen.has('hostInputInvalid')) return 'The remote helper received invalid RPC input before handshake. A remote login script or SSH wrapper may be modifying stdin. Pi has not started.'
    if (this.seen.has('hostInputClosed')) return 'The remote helper standard input closed before handshake. SSH must keep its RPC stdin open; check server login scripts or forced-command wrappers that redirect stdin. Pi has not started.'
    if (this.seen.has('hostSignalled')) return 'The remote helper was interrupted by a signal before handshake. Check the remote SSH forced command, login shell or supervisor; Pi has not started.'
    if (this.seen.has('hostHomeFailed')) return `The helper loaded${version}, but the remote HOME directory is missing or inaccessible. Check the SSH account's HOME/permissions; this is not a Pi installation error.`
    if (this.seen.has('hostPermissionFailed')) return `Remote helper startup was denied by filesystem permissions${version}. Check the remote account and runtime directory permissions; Pi has not started.`
    if (this.seen.has('hostResourceFailed')) return `Remote helper startup exhausted OS resources${version}. Check process/file-descriptor/memory limits on the SSH host.`
    if (this.seen.has('hostSyntaxFailed')) return `The bundled helper could not be parsed${version}. Use Node 22.19+ and verify the application helper artifact; Pi has not started.`
    if (this.seen.has('hostModuleFailed')) return `The helper could not resolve a required Node built-in module${version}. Choose an official Node 22.19+ binary rather than a compatibility launcher.`
    if (this.seen.has('hostInitFailed')) return `The helper module loaded${version}, but host initialization failed. Check remote HOME and OS resources; Pi has not started.`
    if (this.seen.has('hostImportFailed') || this.seen.has('hostLoadFailed')) return `Remote Node could not import the bundled helper${version}. Verify the Node executable and application helper artifact; Pi has not started.`
    if (this.seen.has('hostStarting') && !this.seen.has('hostRuntime')) return `The configured remote Node executable exited (${exit}) before running JavaScript. Choose the actual Node binary and check wrappers or NODE_OPTIONS startup hooks that exit early; Pi has not started.`
    if (this.seen.has('hostRuntime')) return `Remote Node started JavaScript but the helper exited (${exit}) before handshake. Check remote Node compatibility or server-side SSH stdin handling; Pi has not started.`
    if (this.seen.has('starting')) return code === 127
      ? 'Remote Pi could not start (exit 127). Check the remote Pi shebang, Node executable and PATH. OpenSSH was already able to reach the remote startup script.'
      : `Remote Pi exited (${exit}) before its RPC was ready. Check the remote Pi/Node version and startup configuration.`
    if (this.seen.has('shell')) return `The remote startup script stopped (${exit}) before Pi RPC was ready. Check the remote workspace and Pi/Node executable paths.`
    if (code === 127) return `${localSshVerified ? 'OpenSSH was found locally. ' : ''}SSH exited with code 127 before RPC readiness. Check the remote login shell and Pi/Node paths; exit 127 alone does not prove that local ssh is missing.`
    return undefined
  }
}
export function stripStartupMarkers(line: string): string {
  let value = line
  for (const marker of Object.values(REMOTE_STARTUP_MARKERS)) value = value.split(marker).join('')
  return value
}
