import type { SshProfile } from '@shared/ssh-workspace'

/** Never interpolate user data into a local shell. The remote command still needs POSIX quoting. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export const REMOTE_STARTUP_MARKERS = {
  shell: '__PI_DESKTOP_REMOTE_SHELL_V1__',
  cwdMissing: '__PI_DESKTOP_REMOTE_CWD_MISSING_V1__',
  piMissing: '__PI_DESKTOP_REMOTE_PI_MISSING_V1__',
  nodeMissing: '__PI_DESKTOP_REMOTE_NODE_MISSING_V1__',
  starting: '__PI_DESKTOP_REMOTE_RPC_STARTING_V1__',
  hostStarting: '__PI_DESKTOP_REMOTE_HOST_STARTING_V1__',
  hostRuntime: '__PI_DESKTOP_REMOTE_HOST_NODE_RUNNING_V1__',
  hostInputClosed: '__PI_DESKTOP_REMOTE_HOST_STDIN_CLOSED_V1__',
  hostInputInvalid: '__PI_DESKTOP_REMOTE_HOST_INPUT_INVALID_V1__',
  hostLoadFailed: '__PI_DESKTOP_REMOTE_HOST_LOAD_FAILED_V1__',
  hostSignalled: '__PI_DESKTOP_REMOTE_HOST_SIGNALLED_V1__',
  nodeVersion: '__PI_DESKTOP_REMOTE_NODE_VERSION_V1__:',
  nodeUnsupported: '__PI_DESKTOP_REMOTE_NODE_UNSUPPORTED_V1__',
  nodeProbeFailed: '__PI_DESKTOP_REMOTE_NODE_PROBE_FAILED_V1__',
  hostImportFailed: '__PI_DESKTOP_REMOTE_HOST_IMPORT_FAILED_V1__',
  hostInitFailed: '__PI_DESKTOP_REMOTE_HOST_INIT_FAILED_V1__',
  hostHomeFailed: '__PI_DESKTOP_REMOTE_HOST_HOME_FAILED_V1__',
  hostSyntaxFailed: '__PI_DESKTOP_REMOTE_HOST_SYNTAX_FAILED_V1__',
  hostModuleFailed: '__PI_DESKTOP_REMOTE_HOST_MODULE_FAILED_V1__',
  hostPermissionFailed: '__PI_DESKTOP_REMOTE_HOST_PERMISSION_FAILED_V1__',
  hostResourceFailed: '__PI_DESKTOP_REMOTE_HOST_RESOURCE_FAILED_V1__',
} as const

/** Fixed stderr signals, never stdout: keep RPC JSONL clean and password-mode diagnostics private. */
export function remoteStartupCommand(profile: SshProfile, sessionFile?: string): string {
  const signal = (marker: string) => `printf '%s\\n' ${quotePosix(marker)} >&2`
  return `${signal(REMOTE_STARTUP_MARKERS.shell)}
if ! cd ${quotePosix(profile.cwd)}; then ${signal(REMOTE_STARTUP_MARKERS.cwdMissing)}; exit 72; fi
_pi_node=${quotePosix(profile.nodePath)}
_pi_node_bin=$(command -v "$_pi_node" 2>/dev/null || true)
if [ -z "$_pi_node_bin" ] && [ "$_pi_node" = node ]; then
  for _pi_candidate in "$HOME/.local/share/pi-node/current/bin/node" "$HOME/.local/bin/node" "$HOME/.nvm/current/bin/node" /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -f "$_pi_candidate" ] && [ -x "$_pi_candidate" ]; then _pi_node_bin=$_pi_candidate; break; fi
  done
fi
_pi_add_path() {
  case "$1" in
    /*) PATH="\${1%/*}:$PATH" ;;
    */*) PATH="$PWD/\${1%/*}:$PATH" ;;
  esac
  export PATH
}
if [ -n "$_pi_node_bin" ] && [ -f "$_pi_node_bin" ] && [ -x "$_pi_node_bin" ]; then
  _pi_add_path "$_pi_node_bin"
elif [ "$_pi_node" != node ]; then
  ${signal(REMOTE_STARTUP_MARKERS.nodeMissing)}; exit 127
fi
_pi_program=${quotePosix(profile.piPath)}
_pi_bin=$(command -v "$_pi_program" 2>/dev/null || true)
if [ -z "$_pi_bin" ] && [ "$_pi_program" = pi ]; then
  for _pi_candidate in "$HOME/.pi/agent/bin/pi" "$HOME/.local/bin/pi" "$HOME/.local/share/pi-node/current/bin/pi" "$HOME/.npm-global/bin/pi" /usr/local/bin/pi /opt/homebrew/bin/pi; do
    if [ -f "$_pi_candidate" ] && [ -x "$_pi_candidate" ]; then _pi_bin=$_pi_candidate; break; fi
  done
fi
if [ -z "$_pi_bin" ] || [ ! -f "$_pi_bin" ] || [ ! -x "$_pi_bin" ]; then ${signal(REMOTE_STARTUP_MARKERS.piMissing)}; exit 127; fi
if [ "$_pi_node" = node ] && [ -f "\${_pi_bin%/*}/node" ] && [ -x "\${_pi_bin%/*}/node" ]; then _pi_add_path "\${_pi_bin%/*}/node"; fi
${signal(REMOTE_STARTUP_MARKERS.starting)}
exec "$_pi_bin" --mode rpc${sessionFile ? ` --session ${quotePosix(sessionFile)}` : ''}`
}

export function sshArgs(profile: SshProfile, sessionFile?: string, remoteCommand?: string): string[] {
  const args = [
    '-T', '-o', profile.authMethod === 'password' ? 'BatchMode=no' : 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
    '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes',
    '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no', '-o', 'RemoteCommand=none',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  ]
  if (profile.authMethod === 'password') args.push(
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1',
  )
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.user) args.push('-l', profile.user)
  if (profile.identityFile) args.push('-i', profile.identityFile)
  // A host helper has its own explicit runtime lookup. Login profiles can consume/close RPC
  // stdin (or exec another shell), so do not source a second login environment for this mode.
  const shell = remoteCommand === undefined ? 'sh -lc' : '/bin/sh -c'
  args.push('--', profile.host, `${shell} ${quotePosix(remoteCommand ?? remoteStartupCommand(profile, sessionFile))}`)
  return args
}

/** File browsing runs through remote Pi's bash RPC, never through local fs. */
export function remoteFilesCommand(profile: SshProfile, action: 'list' | 'read', path: string): string {
  const script = `
const fs = require('node:fs');
const p = require('node:path');
const root = fs.realpathSync(${JSON.stringify(profile.cwd)});
const requested = ${JSON.stringify(path)};
if (p.isAbsolute(requested)) throw Error('Relative paths only');
const target = fs.realpathSync(p.resolve(root, requested));
const relative = p.relative(root, target);
if (relative === '..' || relative.startsWith('../') || p.isAbsolute(relative)) throw Error('Path outside workspace');
const action = ${JSON.stringify(action)};
let result;
if (action === 'list') {
  const entries = fs.readdirSync(target, {withFileTypes:true}).filter(e => !e.isSymbolicLink()).slice(0, 500)
    .map(e => ({name:e.name, path:p.join(relative, e.name), directory:e.isDirectory()}))
    .sort((a,b) => Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name));
  result = {path:relative, entries};
} else {
  if (!fs.statSync(target).isFile() || fs.statSync(target).size > 4096) throw Error('Prototype preview supports text files up to 4 KiB');
  const text = fs.readFileSync(target, 'utf8');
  if (text.includes('\\u0000')) throw Error('Binary file cannot be previewed');
  result = {path:relative, text};
}
process.stdout.write(JSON.stringify(result));
`
  // Commands run from the configured project even if an extension changes its shell cwd.
  return `cd ${quotePosix(profile.cwd)} && ${quotePosix(profile.nodePath)} -e ${quotePosix(script)}`
}
