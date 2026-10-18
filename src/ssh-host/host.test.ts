// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { spawn, execFileSync } from 'node:child_process'
import { createHost, startHost, type Host } from './host'
import { MAX_FRAME, readJsonl, writeRecord, type RecordValue } from './common'
import { hash } from './files'

let temp: string, home: string, root: string
const hosts: Host[] = []
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'pi-ssh-host-')); home = join(temp, 'home'); root = join(temp, 'work'); await mkdir(home); await mkdir(root) })
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.dispose())); await rm(temp, { recursive: true, force: true }) })
async function setup(extra: Parameters<typeof createHost>[0] = {}) {
  const host = await createHost({ home, pty: false, ...extra }); hosts.push(host)
  const workspace = await host.operation('workspace.register', { path: root, trusted: true }) as RecordValue
  const op = (name: string, args: RecordValue = {}) => host.operation(name, { workspaceId: workspace.id, ...args }) as Promise<RecordValue>
  return { host, workspace, op }
}
async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { if (Date.now() > deadline) throw new Error('wait timeout'); await new Promise((r) => setTimeout(r, 10)) }
}
async function fakePi(): Promise<string> {
  const file = join(temp, 'fake-pi')
  await writeFile(file, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2), file = args[args.indexOf('--session') + 1];
const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
let busy = false, buffer = '', dialog;
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (c, data, success = true) => emit({id:c.id,type:'response',command:c.type,success,data});
process.stdin.on('data', b => { buffer += b; let i; while ((i=buffer.indexOf('\n'))>=0) {
 const c = JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
 if(c.type==='get_state') reply(c,{sessionId:header.id,sessionFile:file,isStreaming:busy,model:{id:'fake',apiKey:'DO_NOT_LEAK',headers:{Authorization:'DO_NOT_LEAK'}},thinkingLevel:'low'});
 else if(c.type==='prompt') {
  busy=true; emit({type:'agent_start'});
  fs.appendFileSync(file,JSON.stringify({type:'message',message:{role:'user',content:c.message}})+'\n');
  if(c.message==='timeout') continue;
  if(c.message==='dialog') {dialog=c;emit({type:'extension_ui_request',id:'remote-dialog',method:'confirm',title:'Continue?'});}
  reply(c,{disposition:'started'}); emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'a\u2028b\u2029é'}});
  emit({type:'agent_end',willRetry:true});
 } else if(c.type==='extension_ui_response') {
  emit({type:'entry_appended',entry:{type:'custom',data:{dialogId:c.id,confirmed:c.confirmed}}});
 } else if(c.type==='abort') {busy=false;emit({type:'agent_settled'});reply(c);}
 else if(c.type==='get_messages') setTimeout(()=>reply(c,{messages:['ok']}),20);
 else if(c.type==='bash') {emit({type:'bash_execution_update',id:c.id,delta:'output'});reply(c,{exitCode:0,output:'output'});}
 else if(c.type==='get_session_stats') reply(c,{umask:process.umask()});
 else reply(c,{});
}});
process.stdin.on('end',()=>process.exit(0));
`)
  await chmod(file, 0o700)
  return file
}

describe('trust and contained files', () => {
  it('handshakes and browses without any Pi or workspace startup', async () => {
    let spawns = 0
    const host = await createHost({ home, pty: false, spawn: ((...args: Parameters<typeof spawn>) => { spawns++; return spawn(...args) }) as typeof spawn }); hosts.push(host)
    const reply = await host.handle({ id: 'hello', type: 'get_state' })
    expect(reply).toMatchObject({ id: 'hello', type: 'response', command: 'get_state', success: true, data: { isStreaming: false, host: { home, workspaces: [] } } })
    await mkdir(join(home, 'z')); await mkdir(join(home, 'a')); await writeFile(join(home, 'not-a-dir'), 'x')
    expect(await host.operation('browse', {})).toMatchObject({ path: home, entries: [{ name: 'a', directory: true }, { name: 'z', directory: true }] })
    await expect(host.operation('workspace.register', { path: root, trusted: false })).rejects.toThrow('workspace_untrusted')
    await expect(host.operation('session.start', { workspaceId: 'unknown' })).rejects.toThrow('workspace_untrusted')
    expect(spawns).toBe(0)
    expect((await host.handle({ id: 'x', type: 'host', op: 'fs.list', args: { workspaceId: 'unknown' } })).errorCode).toBe('workspace_untrusted')
  })
  it('bounds browse at 500 sorted directories and expands home without trust', async () => {
    const host = await createHost({ home, pty: false }); hosts.push(host)
    await Promise.all(Array.from({ length: 503 }, (_, i) => mkdir(join(home, `dir-${String(i).padStart(4, '0')}`))))
    const result = await host.operation('browse', { path: '~' }) as RecordValue
    expect(result.entries).toHaveLength(500)
    expect(result.entries[0]).toMatchObject({ name: 'dir-0000', path: join(home, 'dir-0000') })
    expect(result.entries[499].name).toBe('dir-0499')
  })
  it('reads bounded text, lists, searches, writes hashes and detects conflicts', async () => {
    const { op, workspace } = await setup()
    expect(workspace.id).toBe(hash(root))
    await writeFile(join(root, 'hello.txt'), 'aébc')
    await writeFile(join(root, '.hidden'), 'hidden'); await mkdir(join(root, 'dir'))
    expect(await op('fs.list')).toMatchObject({ ok: true, totalCount: 2, entries: [{ name: 'dir', isDirectory: true }, { name: 'hello.txt', isDirectory: false }] })
    expect(await op('fs.read', { path: 'hello.txt', maxBytes: 2 })).toMatchObject({ ok: true, text: 'a', truncated: true })
    expect(await op('fs.write', { path: 'hello.txt', text: 'updated', expectedHash: 'wrong' })).toEqual({ ok: false, error: 'conflict' })
    expect(await op('fs.write', { path: 'hello.txt', text: 'updated', expectedHash: hash('aébc') })).toEqual({ ok: true, hash: hash('updated') })
    expect(await op('fs.create', { relativePath: 'nested/new' })).toEqual({ ok: true })
    expect(await op('fs.rename', { relativePath: 'nested/new', newName: '..' })).toEqual({ ok: false, error: 'invalid_name' })
    expect(await op('fs.rename', { relativePath: 'nested/new', newName: 'next' })).toEqual({ ok: true, newRelativePath: 'nested/next' })
    expect(await op('fs.search', { query: 'nested/n' })).toMatchObject({ ok: true, entries: [{ path: 'nested/next' }] })
    await writeFile(join(root, 'binary'), Buffer.from([1, 0, 2]))
    expect(await op('fs.read', { path: 'binary' })).toMatchObject({ ok: false, error: 'binary' })
    await writeFile(join(root, 'pic.png'), Buffer.from([137, 80, 78, 71]))
    expect(await op('fs.image', { path: 'pic.png' })).toMatchObject({ ok: true, mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw==' })
    await writeFile(join(root, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1, 65))
    expect(await op('fs.image', { path: 'large.png' })).toEqual({ ok: false, error: 'too_large' })
    const large = await op('fs.read', { path: 'large.png', maxBytes: 20 * 1024 * 1024 })
    expect(large.text.length).toBe(1024 * 1024)
    expect(large.truncated).toBe(true)
    const results = await Promise.all([op('fs.write', { path: 'hello.txt', text: 'first', expectedHash: hash('updated') }), op('fs.write', { path: 'hello.txt', text: 'second', expectedHash: hash('updated') })])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })
  it('rejects traversals, symlink escapes, dangling targets and target-parent escapes', async () => {
    const { op } = await setup()
    await writeFile(join(home, 'secret'), 'private')
    await symlink(home, join(root, 'escape')); await symlink(join(home, 'missing'), join(root, 'dangling'))
    for (const path of ['../home/secret', '/etc/passwd', 'escape/secret', 'dangling']) {
      expect(await op('fs.read', { path })).toMatchObject({ ok: false })
      expect(await op('fs.write', { path, text: 'bad' })).toMatchObject({ ok: false })
    }
    expect(await op('fs.create', { relativePath: 'escape/new' })).toMatchObject({ ok: false, error: 'outside_workspace' })
    expect(await op('fs.create', { relativePath: 'escape/newdir', isDirectory: true })).toMatchObject({ ok: false })
    expect(await op('fs.rename', { relativePath: 'escape/secret', newName: 'renamed' })).toMatchObject({ ok: false })
    expect(await op('fs.search', { query: '../' })).toMatchObject({ ok: false, error: 'outside_workspace' })
    expect(await readFile(join(home, 'secret'), 'utf8')).toBe('private')
    await expect(stat(join(home, 'new'))).rejects.toThrow()
  })
})

describe('real Git argv operations', () => {
  function git(...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } }) }
  it('reads status, stages/unstages whole files and patches, switches branches and lists worktrees', async () => {
    const { op } = await setup({ env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
    git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
    await writeFile(join(root, 'file.txt'), 'first\nsecond\n'); git('add', '.'); git('commit', '-m', 'initial')
    await writeFile(join(root, 'file.txt'), 'first\nchanged\n')
    expect(await op('git.status')).toMatchObject({ snapshot: { isRepo: true, branch: 'main' }, branchStatus: { isRepo: true, branch: 'main', dirty: 1 } })
    const patch = await op('git.diff') as unknown as string
    expect(patch).toContain('+changed')
    expect(await op('git.stage', { files: [{ path: 'file.txt', patch }] })).toEqual({ ok: true })
    expect(git('diff', '--cached')).toContain('+changed')
    expect(await op('git.unstage', { files: [{ path: 'file.txt', hunkPatches: [patch] }] })).toEqual({ ok: true })
    expect(git('diff', '--cached')).toBe('')
    expect(await op('git.stage', { files: [{ path: 'file.txt' }] })).toEqual({ ok: true })
    expect(await op('git.unstage', { files: [{ path: 'file.txt' }] })).toEqual({ ok: true })
    expect(await op('git.branches')).toMatchObject({ branches: [{ name: 'main', current: true, remote: false }] })
    expect(await op('git.switch', { name: '-bad', create: true })).toMatchObject({ ok: false, reason: 'invalid-name' })
    expect(await op('git.switch', { name: 'feature', create: true })).toEqual({ ok: true, branch: 'feature', stashed: false })
    expect(await op('git.worktrees')).toMatchObject({ ok: true, repositoryPath: root, trees: [{ path: root, isMain: true }] })
    await expect(op('git.stage', { files: [{ path: '../outside' }] })).rejects.toThrow('outside_workspace')
    await expect(op('git.stage', { files: [{ path: 'file.txt', patch: patch.replaceAll('file.txt', '../outside') }] })).rejects.toThrow('invalid_patch')
    await symlink(home, join(root, 'escape'))
    await expect(op('git.stage', { files: [{ path: 'escape/secret' }] })).rejects.toThrow('outside_workspace')
  })
})

describe('Pi subprocess RPC', () => {
  it('rejects private session symlinks, wrong-workspace headers and malformed child stdout', async () => {
    const events: RecordValue[] = [], { op, workspace } = await setup({ event: (event) => events.push(event) })
    const piPath = await fakePi(), session = await op('session.start', { piPath })
    await op('session.close', { runtimeId: session.runtimeId })
    const dir = join(home, '.pi/desktop-code/sessions', workspace.id)
    const wrong = join(dir, 'wrong.jsonl'), linked = join(dir, 'linked.jsonl')
    await writeFile(wrong, JSON.stringify({ type: 'session', id: 'wrong', cwd: home, timestamp: new Date().toISOString() }) + '\n')
    await symlink(session.sessionFile, linked)
    expect((await op('session.list')).sessions).toHaveLength(1)
    await expect(op('session.start', { piPath, sessionFile: wrong })).rejects.toThrow('session_not_allowed')
    await expect(op('session.start', { piPath, sessionFile: linked })).rejects.toThrow('session_not_allowed')
    const broken = join(temp, 'broken-pi')
    await writeFile(broken, `#!${process.execPath}\nprocess.stdout.write('not protocol\\n');setInterval(()=>{},1000)\n`, { mode: 0o700 })
    await expect(op('session.start', { piPath: broken })).rejects.toThrow('pi_protocol_error')
    await waitFor(() => events.filter((event) => event.kind === 'session-exit').length === 2)
  })
  it('uses private real sessions, correlates concurrent replies and waits for settled, not acceptance/end', async () => {
    const events: RecordValue[] = [], { host, op, workspace } = await setup({ event: (event) => events.push(event) })
    const piPath = await fakePi()
    expect(await op('session.list')).toEqual({ sessions: [] })
    await expect(op('session.start', { piPath: join(temp, 'absent') })).rejects.toThrow('executable_not_found')
    const session = await op('session.start', { piPath })
    expect(session).toMatchObject({ cwd: root, model: 'fake', isStreaming: false })
    expect(session.sessionFile).toContain(join(home, '.pi/desktop-code/sessions', workspace.id))
    expect((await stat(session.sessionFile)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, '.pi/desktop-code/sessions', workspace.id))).mode & 0o777).toBe(0o700)
    await expect(op('session.start', { piPath, sessionFile: session.sessionFile })).rejects.toThrow('session_in_use')
    await expect(op('session.start', { piPath, sessionFile: '/etc/passwd' })).rejects.toThrow('session_not_allowed')
    const rpc = (command: RecordValue) => op('session.rpc', { runtimeId: session.runtimeId, command })
    expect(await rpc({ type: 'get_session_stats' })).toMatchObject({ data: { umask: 0o077 } })
    await rpc({ type: 'bash', id: 'client-bash', command: 'unused fake command' })
    expect(events.find((event) => event.event?.type === 'bash_execution_update')?.event.id).toBe('client-bash')
    const responses = await Promise.all([rpc({ type: 'get_messages', id: 'client-one' }), rpc({ type: 'get_state', id: 'client-two' })])
    expect(responses[0]).toMatchObject({ type: 'response', command: 'get_messages', success: true, data: { messages: ['ok'] } })
    expect(JSON.stringify(responses)).not.toContain('DO_NOT_LEAK')
    expect(await rpc({ type: 'prompt', message: 'hello' })).toMatchObject({ command: 'prompt', data: { disposition: 'started' } })
    await waitFor(() => events.some((event) => event.event?.type === 'agent_end'))
    expect((await op('session.list')).sessions[0]).toMatchObject({ title: 'hello', status: 'busy' })
    await expect(rpc({ type: 'new_session' })).rejects.toThrow('session_busy')
    await rpc({ type: 'abort' })
    expect((await op('session.list')).sessions[0].status).toBe('idle')
    await rpc({ type: 'prompt', message: 'dialog' })
    await waitFor(() => events.some((event) => event.event?.type === 'extension_ui_request'))
    expect(await rpc({ type: 'extension_ui_response', id: 'remote-dialog', confirmed: true })).toMatchObject({ success: true })
    await waitFor(() => events.some((event) => event.event?.entry?.data?.dialogId === 'remote-dialog'))
    await expect(rpc({ type: 'switch_session', sessionPath: '/etc/passwd' })).rejects.toThrow('rpc_command_not_allowed')
    await expect(host.operation('session.rpc', { workspaceId: 'wrong', runtimeId: session.runtimeId, command: { type: 'get_state' } })).rejects.toThrow('workspace_untrusted')
    const other = join(temp, 'other'); await mkdir(other)
    const otherWorkspace = await host.operation('workspace.register', { path: other, trusted: true }) as RecordValue
    await expect(host.operation('session.rpc', { workspaceId: otherWorkspace.id, runtimeId: session.runtimeId, command: { type: 'get_state' } })).rejects.toThrow('runtime_not_found')
    await op('session.close', { runtimeId: session.runtimeId })
    await waitFor(() => events.some((event) => event.kind === 'session-exit'))
    expect(events.some((event) => event.event?.assistantMessageEvent?.delta === 'a\u2028b\u2029é')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('DO_NOT_LEAK')
  })
  it('keeps a timed-out turn busy and caps live runtimes without evicting it', async () => {
    const { op } = await setup({ piTimeoutMs: 2000 }), piPath = await fakePi()
    const sessions = []
    for (let i = 0; i < 4; i++) sessions.push(await op('session.start', { piPath, fresh: true }))
    await expect(op('session.start', { piPath })).rejects.toThrow('runtime_limit')
    const session = sessions[0]
    await expect(op('session.rpc', { runtimeId: session.runtimeId, command: { type: 'prompt', message: 'timeout' } })).rejects.toThrow('pi_timeout')
    await expect(op('session.rpc', { runtimeId: session.runtimeId, command: { type: 'new_session' } })).rejects.toThrow('session_busy')
    await op('session.rpc', { runtimeId: session.runtimeId, command: { type: 'abort' } })
  })
})

describe('strict wire transport and EOF', () => {
  it('handles fragmented UTF8 and Unicode separators, rejects CRLF, malformed UTF8 and oversized tails', () => {
    for (const invalid of [Buffer.from('{}\r\n'), Buffer.from('\ufeff{}\n'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]), Buffer.alloc(MAX_FRAME + 1, 32)]) {
      const input = new PassThrough(); let bad = false
      readJsonl(input, () => {}, () => { bad = true }); input.write(invalid)
      expect(bad).toBe(true)
    }
    const input = new PassThrough(), records: RecordValue[] = []
    readJsonl(input, (r) => records.push(r), () => { throw new Error('invalid') })
    const line = Buffer.from(JSON.stringify({ text: 'a\u2028b\u2029é' }) + '\n')
    for (const byte of line) input.write(Buffer.from([byte]))
    expect(records).toEqual([{ text: 'a\u2028b\u2029é' }])
    const partial = new PassThrough(); let partialBad = false
    readJsonl(partial, () => {}, () => { partialBad = true })
    partial.end('{"id":"unterminated"}')
    // The end event is asynchronous; the transport's EOF handler also closes the host regardless.
    partial.on('end', () => expect(partialBad).toBe(true))
    const blocked = new Writable({ write(_chunk, _encoding, _callback) {} })
    expect(() => { for (let i = 0; i < 100; i++) writeRecord(blocked, { data: 'a'.repeat(1024 * 1024) }) }).toThrow('output_overflow')
    blocked.destroy()
  })
  it('dispatches concurrent IDs and EOF disposes a live Pi child', async () => {
    const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough(), records: RecordValue[] = []
    readJsonl(output, (record) => records.push(record), () => { throw new Error('invalid output') })
    const pids: number[] = [], exits: RecordValue[] = []
    const running = await startHost({ home, pty: true, input, output, diagnostics,
      env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash' }, event: (event) => exits.push(event),
      spawn: ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); if (child.pid) pids.push(child.pid); return child }) as typeof spawn,
    }); hosts.push(running.host)
    input.write(JSON.stringify({ id: 'hello', type: 'get_state' }) + '\n')
    await waitFor(() => records.some((r) => r.id === 'hello'))
    const workspace = await running.host.operation('workspace.register', { path: root, trusted: true }) as RecordValue
    const piPath = await fakePi(), session = await running.host.operation('session.start', { workspaceId: workspace.id, piPath }) as RecordValue
    if (running.host.state().capabilities.pty) await running.host.operation('terminal.create', { workspaceId: workspace.id, cols: 80, rows: 24 })
    // Closing must cause a real child exit; session.close thereafter is not a detached persistence API.
    input.write(JSON.stringify({ id: 'slow', type: 'host', op: 'session.rpc', args: { workspaceId: workspace.id, runtimeId: session.runtimeId, command: { type: 'get_messages' } } }) + '\n')
    input.write(JSON.stringify({ id: 'fast', type: 'get_state' }) + '\n')
    await waitFor(() => records.some((r) => r.id === 'fast') && records.some((r) => r.id === 'slow'))
    expect(records.findIndex((r) => r.id === 'fast')).toBeLessThan(records.findIndex((r) => r.id === 'slow'))
    input.end(); await new Promise((r) => setTimeout(r, 20)); await running.dispose()
    expect((await running.host.handle({ id: 'closed', type: 'get_state' })).errorCode).toBe('host_closed')
    await waitFor(() => exits.some((event) => event.kind === 'session-exit'))
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    if (running.host.state().capabilities.pty) expect(exits.some((event) => event.kind === 'terminal-exit')).toBe(true)
  })
})

it('creates a genuine remote-side PTY, suppresses sentinel, echoes input and resizes the tty', async (context) => {
  const events: RecordValue[] = [], { host, op } = await setup({ pty: true, env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash', TERM: 'xterm' }, event: (event) => events.push(event) })
  if (!host.state().capabilities.pty) context.skip('Neither script nor Python stdlib PTY backend is available')
  const terminal = await op('terminal.create', { cols: 80, rows: 24 })
  await op('terminal.resize', { id: terminal.id, cols: 91, rows: 37 })
  await op('terminal.write', { id: terminal.id, data: "printf '__PTY_%s__\\n' \"$(test -t 0 && echo yes)\"; stty size\n" })
  const output = () => events.filter((e) => e.kind === 'terminal-data').map((e) => e.data).join('')
  await waitFor(() => output().includes('__PTY_yes__') && output().includes('37 91'))
  expect(output()).not.toContain('PI_TTY_')
  await op('terminal.kill', { id: terminal.id })
  await waitFor(() => events.some((e) => e.kind === 'terminal-exit'))
})
