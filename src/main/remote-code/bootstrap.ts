import type { SshProfile } from '@shared/ssh-workspace'
import { quotePosix, REMOTE_STARTUP_MARKERS as M } from '../ssh/command'

/** Only error categories are returned; never remote exception messages, paths or credentials. */
export function hostImportFailureScript(): string {
  return `e=>{const c=e&&e.code;const n=e&&e.name;const m=n==='SyntaxError'?${JSON.stringify(M.hostSyntaxFailed)}:['ERR_MODULE_NOT_FOUND','ERR_UNKNOWN_BUILTIN_MODULE','ERR_UNSUPPORTED_ESM_URL_SCHEME','ERR_UNSUPPORTED_RESOLVE_REQUEST','ERR_UNKNOWN_FILE_EXTENSION'].includes(c)?${JSON.stringify(M.hostModuleFailed)}:['EACCES','EPERM'].includes(c)?${JSON.stringify(M.hostPermissionFailed)}:['EMFILE','ENFILE','ENOMEM'].includes(c)?${JSON.stringify(M.hostResourceFailed)}:${JSON.stringify(M.hostLoadFailed)};process.stderr.write(${JSON.stringify(M.hostImportFailed + '\n')}+m+'\\n');process.exitCode=70}`
}
/** Version-verified, single-file Node host. No login profile or Pi needed before workspace trust. */
export function hostBootstrap(profile: SshProfile, source: string): string {
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  const launch = `process.stderr.on('error',()=>{});process.stderr.write(${JSON.stringify(M.hostRuntime + '\n')});import(${JSON.stringify(url)}).catch(${hostImportFailureScript()})`
  const signal = (marker: string) => `printf '%s\\n' ${quotePosix(marker)} >&2`
  const script = `${signal(M.shell)}
_node=${quotePosix(profile.nodePath)}
case "$_node" in '~/'*) _node="$HOME/\${_node#\\~/}" ;; esac
_bin=; _version=; _seen_binary=; _last_version=; _major=0; _minor=0; _patch=0
_node_probe() {
  "$1" -p '"__PI_DESKTOP_NODE_PROBE_V1__:"+process.release.name+":"+process.versions.node' </dev/null 2>/dev/null &
  _probe_pid=$!
  (
    _delay_pid=
    trap 'kill "$_delay_pid" 2>/dev/null || true; exit 0' TERM INT
    /bin/sleep 2 & _delay_pid=$!; wait "$_delay_pid"
    kill -TERM "$_probe_pid" 2>/dev/null || exit 0
    /bin/sleep 1 & _delay_pid=$!; wait "$_delay_pid"
    kill -KILL "$_probe_pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  _watchdog=$!
  wait "$_probe_pid"; _probe_status=$?
  kill -TERM "$_watchdog" 2>/dev/null || true
  wait "$_watchdog" 2>/dev/null || true
  return "$_probe_status"
}
_probe_node() {
  [ -f "$1" ] && [ -x "$1" ] || return 0
  _seen_binary=1
  # Node hooks and wrappers must not consume the queued RPC handshake while probing.
  if _out=$(_node_probe "$1"); then :; else return 0; fi
  case "$_out" in __PI_DESKTOP_NODE_PROBE_V1__:node:*) _v=\${_out#__PI_DESKTOP_NODE_PROBE_V1__:node:} ;; *) return 0 ;; esac
  case "$_v" in ''|*[!0-9.]*|*.*.*.*) return 0 ;; esac
  [ "\${#_v}" -le 15 ] || return 0
  _a=\${_v%%.*}; _tail=\${_v#*.}; _b=\${_tail%%.*}; _c=\${_tail#*.}
  [ -n "$_a" ] && [ -n "$_b" ] && [ -n "$_c" ] && [ "$_v" = "$_a.$_b.$_c" ] || return 0
  _last_version=$_v
  if [ "$_a" -lt 22 ] || { [ "$_a" -eq 22 ] && [ "$_b" -lt 19 ]; }; then return 0; fi
  if [ -z "$_bin" ] || [ "$_a" -gt "$_major" ] || { [ "$_a" -eq "$_major" ] && [ "$_b" -gt "$_minor" ]; } || { [ "$_a" -eq "$_major" ] && [ "$_b" -eq "$_minor" ] && [ "$_c" -gt "$_patch" ]; }; then
    _bin=$1; _version=$_v; _major=$_a; _minor=$_b; _patch=$_c
  fi
}
_path_node=$(command -v "$_node" 2>/dev/null || true)
[ -z "$_path_node" ] || _probe_node "$_path_node"
if [ -z "$_bin" ] && [ "$_node" = node ]; then
  for _candidate in "$HOME/.local/share/pi-node/current/bin/node" "$HOME/.local/bin/node" "$HOME/.nvm/current/bin/node" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node /bin/node; do
    _probe_node "$_candidate"
    [ -z "$_bin" ] || break
  done
  if [ -z "$_bin" ]; then
    # Numeric comparison, not lexical glob order (v9 must not beat v24).
    for _candidate in "$HOME"/.nvm/versions/node/*/bin/node; do _probe_node "$_candidate"; done
  fi
fi
if [ -z "$_bin" ]; then
  _exit=78
  if [ -n "$_last_version" ]; then
    printf '%s%s\\n' ${quotePosix(M.nodeVersion)} "$_last_version" >&2
    ${signal(M.nodeUnsupported)}
  elif [ -n "$_seen_binary" ]; then ${signal(M.nodeProbeFailed)}
  else ${signal(M.nodeMissing)}; _exit=127; fi
  exit "$_exit"
fi
printf '%s%s\\n' ${quotePosix(M.nodeVersion)} "$_version" >&2
PATH="\${_bin%/*}:$PATH"; export PATH
${signal(M.hostStarting)}
exec "$_bin" --input-type=module -e ${quotePosix(launch)}
`
  return `exec /bin/sh -c ${quotePosix(script)}`
}
