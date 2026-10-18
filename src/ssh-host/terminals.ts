import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { HostEvent } from '../../packages/shared/ssh-host-types'
import { Files } from './files'
import { executable, fail, HostError, integer, Processes, text, type RecordValue } from './common'

type Terminal = { id: string; workspaceId: string; child: ChildProcessWithoutNullStreams; tty: string; shellPid: number; closing: boolean }
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
// Runs on the remote host, not in Node. pty.spawn forks a new session with a real
// controlling slave tty, relays bytes through its master, and waits for the shell.
// -I keeps user Python startup paths/environment out of both probe and relay.
const pythonPty = `import os, pty, sys
status = pty.spawn(sys.argv[1:])
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))`
export class Terminals {
  readonly terminals = new Map<string, Terminal>()
  private script?: string
  private python?: string
  private stty?: string
  private tty?: string
  private available = false
  private disposed = false
  private creating = 0
  constructor(readonly files: Files, readonly processes: Processes, readonly event: (event: HostEvent) => void) {}
  async supported(): Promise<boolean> {
    this.available = false; this.script = undefined; this.python = undefined
    if (!['linux', 'darwin'].includes(process.platform)) return false
    try {
      this.stty = await executable('stty', this.files.home, this.processes.env)
      this.tty = await executable('tty', this.files.home, this.processes.env)
    } catch { return false }
    try {
      const script = await executable('script', this.files.home, this.processes.env)
      const valid = process.platform !== 'linux' || await this.processes.run(script, ['--version'], this.files.home, undefined, 1500).then((version) => version.code === 0 && version.out.includes('util-linux'))
      if (valid) this.script = script
    } catch { /* script is optional; try the stdlib PTY backend below */ }
    if (!this.script) {
      try {
        const python = await executable('python3', this.files.home, this.processes.env)
        const probe = await this.processes.run(python, ['-I', '-c', 'import pty, termios, fcntl'], this.files.home, undefined, 1500)
        if (probe.code === 0) this.python = python
      } catch { /* no usable PTY backend */ }
    }
    this.available = Boolean(this.script || this.python)
    return this.available
  }
  private async profile(): Promise<RecordValue> {
    const command = await executable(this.processes.env.SHELL || '/bin/bash', this.files.home, this.processes.env, true)
    return { id: 'remote-default', label: 'Remote shell', name: 'Remote shell', kind: 'bash', command, path: command, args: ['-i'], isDefault: true }
  }
  async profiles(): Promise<unknown> { return { profiles: this.available ? [await this.profile()] : [] } }
  async create(args: RecordValue): Promise<unknown> {
    const ws = this.files.workspace(args)
    if (!this.available || (!this.script && !this.python) || !this.stty || !this.tty) fail('pty_unavailable')
    if (this.disposed) fail('host_closed')
    if (this.terminals.size + this.creating >= 8) fail('terminal_limit')
    this.creating++
    try { return await this.createInner(ws.id, ws.root, args) } finally { this.creating-- }
  }
  private async createInner(workspaceId: string, root: string, args: RecordValue): Promise<unknown> {
    const cols = integer(args.cols, 80, 1000), rows = integer(args.rows, 24, 1000), profile = await this.profile()
    if (this.disposed) fail('host_closed')
    const id = randomUUID(), marker = `PI_TTY_${randomUUID()}:`
    // Only fixed shell code plus shell-quoted, host-resolved executables. No request is evaluated here.
    const controlled = `printf '\\036${marker}%s:%s\\037' "$$" "$(${quote(this.tty!)})"; ${quote(this.stty!)} rows ${rows} cols ${cols}; exec ${quote(profile.command)} -i`
    const argv = this.script
      ? process.platform === 'linux' ? ['-q', '-e', '-f', '-c', controlled, '/dev/null'] : ['-q', '/dev/null', '/bin/sh', '-c', controlled]
      : ['-I', '-c', pythonPty, '/bin/sh', '-c', controlled]
    const child = this.processes.start((this.script || this.python)!, argv, root, { ...this.processes.env, SHELL: '/bin/sh', TERM: this.processes.env.TERM || 'xterm-256color', HOME: this.files.home })
    const terminal: Terminal = { id, workspaceId, child, tty: '', shellPid: 0, closing: false }
    this.terminals.set(id, terminal)
    const decoder = new StringDecoder('utf8')
    let prefix = '', ready = false
    const emit = (data: string) => { if (data) this.event({ type: 'host_event', kind: 'terminal-data', workspaceId, terminalId: id, data }) }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostError('pty_start_timeout')), 5000)
      const failure = () => { clearTimeout(timer); reject(new HostError('pty_start_failed')) }
      child.once('error', failure)
      child.once('close', (code) => {
        clearTimeout(timer); if (!ready) reject(new HostError('pty_start_failed'))
        if (ready) emit(decoder.end())
        this.terminals.delete(id)
        // Both backends own a separate shell session: clean its jobs as well as the relay's group.
        void this.signalShell(terminal, 'SIGKILL')
        this.event({ type: 'host_event', kind: 'terminal-exit', workspaceId, terminalId: id, code })
      })
      child.stdout.on('data', (chunk: Buffer) => {
        const value = decoder.write(chunk)
        if (ready) { emit(value); return }
        prefix += value
        if (prefix.length > 65536) { failure(); return }
        const start = prefix.indexOf(`\x1e${marker}`), end = prefix.indexOf('\x1f', start)
        if (start < 0 || end < 0) return
        const sentinel = prefix.slice(start + marker.length + 1, end)
        const match = /^(\d+):(\/dev\/(?:pts\/\d+|ttys[\da-zA-Z]+))$/.exec(sentinel)
        if (!match || +match[1] <= 1) { failure(); return }
        terminal.shellPid = +match[1]; terminal.tty = match[2]
        ready = true; clearTimeout(timer); child.off('error', failure)
        const rest = prefix.slice(end + 1); prefix = ''; emit(rest); resolve()
      })
    }).catch(async (error) => { await this.killTerminal(terminal); throw error })
    return { id, pid: child.pid, profile }
  }
  private terminal(args: RecordValue): Terminal {
    const ws = this.files.workspace(args), terminal = this.terminals.get(text(args.id))
    if (!terminal || terminal.workspaceId !== ws.id || terminal.closing) fail('terminal_not_found')
    return terminal
  }
  async write(args: RecordValue): Promise<unknown> {
    const terminal = this.terminal(args), data = text(args.data)
    const bytes = Buffer.byteLength(data)
    if (bytes > 1024 * 1024 || terminal.child.stdin.writableLength + bytes > 2 * 1024 * 1024) fail('terminal_input_overflow')
    if (terminal.child.stdin.destroyed) fail('terminal_closed')
    terminal.child.stdin.write(data)
    return { ok: true }
  }
  async resize(args: RecordValue): Promise<unknown> {
    const terminal = this.terminal(args)
    const cols = integer(args.cols, 80, 1000), rows = integer(args.rows, 24, 1000)
    if (!/^\/dev\/(pts\/\d+|ttys[\da-zA-Z]+)$/.test(terminal.tty) || !(await lstat(terminal.tty)).isCharacterDevice()) fail('invalid_tty')
    const result = await this.processes.run(this.stty!, [process.platform === 'linux' ? '-F' : '-f', terminal.tty, 'rows', String(rows), 'cols', String(cols)], this.files.home)
    if (result.code) fail('pty_resize_failed')
    return { ok: true }
  }
  async kill(args: RecordValue): Promise<unknown> { await this.killTerminal(this.terminal(args)); return { ok: true } }
  private async signalShell(terminal: Terminal, signal: NodeJS.Signals): Promise<void> {
    const sid = terminal.shellPid
    if (sid <= 1) return
    // A deliberately detached (new-session) job is outside this cleanup guarantee.
    if (process.platform === 'linux') {
      const groups = new Set<number>()
      for (const pid of await readdir('/proc').catch(() => [])) {
        if (!/^\d+$/.test(pid)) continue
        const value = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
        if (+fields[3] === sid && +fields[2] > 1) groups.add(+fields[2])
      }
      for (const group of groups) { try { process.kill(-group, signal) } catch { /* gone */ } }
    } else { try { process.kill(-sid, signal) } catch { /* gone */ } }
  }
  private async killTerminal(terminal: Terminal): Promise<void> {
    if (terminal.closing) return
    terminal.closing = true
    await this.signalShell(terminal, 'SIGHUP')
    await this.processes.stop(terminal.child)
    await this.signalShell(terminal, 'SIGKILL')
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.terminals.values()].map((t) => this.killTerminal(t))) }
}
