// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { executable, type RecordValue } from './common'
import { startHost } from './host'

let temp: string, home: string, root: string, bin: string
let running: Awaited<ReturnType<typeof startHost>> | undefined
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'pi-python-pty-'))
  home = join(temp, 'home'); root = join(home, 'work'); bin = join(home, 'bin')
  await mkdir(root, { recursive: true }); await mkdir(bin)
})
afterEach(async () => { await running?.dispose(); running = undefined; await rm(temp, { recursive: true, force: true }) })
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('PTY assertion timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function live(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    // An orphan may briefly await reaping by init; a zombie is not a live job.
    if (process.platform === 'linux') {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8')
      return value.slice(value.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
    }
    return true
  } catch { return false }
}
async function fixture(names = ['python3', 'stty', 'tty', 'bash']) {
  const paths: Record<string, string> = {}
  for (const name of names) {
    paths[name] = await executable(name, home, process.env)
    await symlink(paths[name], join(bin, name))
  }
  const events: RecordValue[] = [], calls: Parameters<typeof spawn>[] = []
  const input = new PassThrough(), output = new PassThrough()
  output.resume()
  running = await startHost({ home, pty: true, input, output, diagnostics: new PassThrough(),
    env: { PATH: bin, HOME: home, SHELL: paths.bash, TERM: 'xterm', LANG: 'C.UTF-8' },
    event: (event) => events.push(event),
    spawn: ((...args: Parameters<typeof spawn>) => { calls.push(args); return spawn(...args) }) as typeof spawn,
  })
  const host = running.host
  const workspace = await host.operation('workspace.register', { path: root, trusted: true }) as RecordValue
  const op = (name: string, args: RecordValue = {}) => host.operation(name, { workspaceId: workspace.id, ...args }) as Promise<RecordValue>
  const outputText = () => events.filter((event) => event.kind === 'terminal-data').map((event) => event.data).join('')
  return { host, op, input, output, events, calls, paths, outputText }
}

describe('Python stdlib remote PTY fallback (no script in PATH)', () => {
  it.runIf(process.platform === 'linux')('bounds optional utility probes instead of consuming the 30-second handshake budget', async () => {
    for (const name of ['stty', 'tty', 'bash']) await symlink(await executable(name, home, process.env), join(bin, name))
    for (const name of ['script', 'python3']) await writeFile(join(bin, name), '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 })
    const input = new PassThrough(), output = new PassThrough(); output.resume()
    const started = Date.now()
    running = await startHost({ home, pty: true, input, output, diagnostics: new PassThrough(), env: { PATH: bin, HOME: home, SHELL: join(bin, 'bash') } })
    expect(Date.now() - started).toBeLessThan(10000)
    expect(running.host.state().capabilities.pty).toBe(false)
  })
  it('probes only stdlib imports, allocates a tty, preserves profiles, resizes, echoes and decodes UTF8', async () => {
    const { host, op, events, calls, paths, outputText } = await fixture()
    // These are mandatory real PTY assertions, never an availability-based skip.
    expect(host.state().capabilities.pty).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(paths.python3)
    expect(calls[0][1]).toEqual(['-I', '-c', 'import pty, termios, fcntl'])
    const profiles = await host.operation('terminal.profiles', {}) as RecordValue
    expect(profiles.profiles).toEqual([expect.objectContaining({ id: 'remote-default', label: 'Remote shell', name: 'Remote shell', command: paths.bash, path: paths.bash, args: ['-i'], isDefault: true })])
    const terminal = await op('terminal.create', { cols: 80, rows: 24 })
    expect(terminal.profile).toEqual(profiles.profiles[0])
    const relay = calls.find((call) => call[0] === paths.python3 && call[1]?.[2] !== 'import pty, termios, fcntl')!
    expect(relay[1]?.slice(0, 2)).toEqual(['-I', '-c'])
    expect(relay[1]?.[2]).toContain('pty.spawn(sys.argv[1:])')
    expect(relay[1]?.slice(3, 5)).toEqual(['/bin/sh', '-c'])
    await op('terminal.write', { id: terminal.id, data: "if test -t 0 && test -t 1 && test -t 2; then printf '__TTY_yes_%s__\\n' \"$(stty size)\"; fi\n" })
    await waitFor(() => outputText().includes('__TTY_yes_24 80__'))
    await op('terminal.resize', { id: terminal.id, cols: 91, rows: 37 })
    // Non-ASCII is emitted in separate writes with a delay, exercising streaming decoding.
    await op('terminal.write', { id: terminal.id, data: "printf '__SIZE_%s__\\n' \"$(stty size)\"; printf '__ECHO_%s__\\n' 'héllo界'; python3 -I -c 'import os,time; os.write(1, bytes([240,159])); time.sleep(0.05); os.write(1, bytes([153,130,10]))'\n" })
    await waitFor(() => outputText().includes('__SIZE_37 91__') && outputText().includes('__ECHO_héllo界__') && outputText().includes('🙂'))
    expect(outputText()).not.toContain('PI_TTY_')
    expect(outputText()).not.toContain('\ufffd')
    // PTY line discipline really echoes input, rather than just a pipe executing it.
    expect(outputText()).toContain("printf '__SIZE_%s__")
    for (const call of calls) {
      expect(call[2]?.env?.HOME).toBe(home)
      expect([home, root]).toContain(call[2]?.cwd)
    }
    await op('terminal.kill', { id: terminal.id })
    await waitFor(() => events.some((event) => event.kind === 'terminal-exit' && event.terminalId === terminal.id))
    await waitFor(async () => !await live(terminal.pid))
  })

  it.each(['EOF', 'input-close', 'output-close', 'terminal.kill'] as const)('%s kills the relay, session shell and a HUP/TERM-resistant child job', async (stop) => {
    const { host, op, input, output, events, outputText } = await fixture()
    expect(host.state().capabilities.pty).toBe(true)
    const terminal = await op('terminal.create')
    await op('terminal.write', { id: terminal.id, data: "python3 -I -c 'import os,signal,time; signal.signal(signal.SIGHUP, signal.SIG_IGN); signal.signal(signal.SIGTERM, signal.SIG_IGN); print(\"__JOB_%s__\" % os.getpid(), flush=True); time.sleep(60)' &\nprintf '__SHELL_%s__\\n' \"$$\"\n" })
    await waitFor(() => /__JOB_\d+__/.test(outputText()) && /__SHELL_\d+__/.test(outputText()))
    const job = +/__JOB_(\d+)__/.exec(outputText())![1], shell = +/__SHELL_(\d+)__/.exec(outputText())![1]
    expect(await live(job)).toBe(true); expect(await live(shell)).toBe(true)
    if (stop !== 'terminal.kill') {
      if (stop === 'EOF') input.end()
      else if (stop === 'input-close') input.destroy()
      else output.destroy()
      // The transport itself must close the host, not an explicit terminal.kill/dispose.
      await waitFor(async () => (await host.handle({ id: 'closed', type: 'get_state' })).errorCode === 'host_closed')
    } else await op('terminal.kill', { id: terminal.id })
    await waitFor(() => events.some((event) => event.kind === 'terminal-exit' && event.terminalId === terminal.id))
    await waitFor(async () => !await live(terminal.pid) && !await live(shell) && !await live(job))
    expect(outputText()).not.toContain('PI_TTY_')
  })

  it('reports the real shell exit status and reaps the Python relay', async () => {
    const { host, op, events } = await fixture()
    expect(host.state().capabilities.pty).toBe(true)
    const terminal = await op('terminal.create')
    await op('terminal.write', { id: terminal.id, data: 'exit 37\n' })
    await waitFor(() => events.some((event) => event.kind === 'terminal-exit' && event.terminalId === terminal.id))
    expect(events.find((event) => event.kind === 'terminal-exit' && event.terminalId === terminal.id)?.code).toBe(37)
    await waitFor(async () => !await live(terminal.pid))
    await expect(op('terminal.write', { id: terminal.id, data: 'no' })).rejects.toThrow('terminal_not_found')
  })

  it('reports unavailable without either backend, with no pipe-only terminal', async () => {
    const { host, op, calls } = await fixture(['stty', 'tty', 'bash'])
    expect(host.state().capabilities.pty).toBe(false)
    expect(await host.operation('terminal.profiles', {})).toEqual({ profiles: [] })
    await expect(op('terminal.create')).rejects.toThrow('pty_unavailable')
    expect(calls).toHaveLength(0)
  })

  it('rejects Python without the required stdlib modules at capability time', async () => {
    await writeFile(join(bin, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const { host, op, calls } = await fixture(['stty', 'tty', 'bash'])
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual(['-I', '-c', 'import pty, termios, fcntl'])
    expect(host.state().capabilities.pty).toBe(false)
    await expect(op('terminal.create')).rejects.toThrow('pty_unavailable')
  })

  it('keeps supported script preferred without probing Python', async () => {
    // This is only a selection test; genuine PTY execution above uses real Python.
    await writeFile(join(bin, 'script'), '#!/bin/sh\nprintf "script from util-linux\\n"\n', { mode: 0o700 })
    const { host, calls } = await fixture()
    expect(host.state().capabilities.pty).toBe(true)
    expect(calls.every((call) => call[0] === join(bin, 'script'))).toBe(true)
    expect(calls).toHaveLength(process.platform === 'linux' ? 1 : 0)
  })
})
