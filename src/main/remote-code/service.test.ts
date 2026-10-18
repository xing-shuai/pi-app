import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sshProfileSchema, type SshProfile, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import type { HostOperation, HostState } from '@shared/ssh-host-types'
import { SshSafeConnectError } from '../ssh/ssh-workspace'
import { RemoteCodeService, type HostTransport } from './service'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const profile = (id = randomUUID()): SshProfile => sshProfileSchema.parse({ id, name: 'Test host', host: 'test.invalid', cwd: '/' })
class FakeHost implements HostTransport {
  readonly calls: { op: HostOperation; args: Record<string, unknown> }[] = []
  readonly credentials: string[] = []
  hasActiveWork = false
  connected = false
  canonical = '/remote/project'
  n = 0
  started = new Map<string, { sessionId: string; sessionFile: string }>()
  gate?: Promise<void>
  host: HostState = { home: '/remote', platform: 'linux', nodeVersion: 'v22', capabilities: { files: true, git: true, pty: true, sessions: true }, workspaces: [] }
  constructor(readonly emit: (e: SshWorkspaceEvent) => void) {}
  async connect(_profile: SshProfile, _session?: string, credentials?: { password?: string }): Promise<void> {
    if (credentials?.password) this.credentials.push(credentials.password)
    await this.gate; this.connected = true
  }
  disconnect(): void { this.connected = false }
  getHostState(): HostState { return this.host }
  async requestHost(op: HostOperation, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ op, args })
    if (!this.connected) throw new Error('disconnected')
    if (op === 'browse') return { path: this.canonical, home: '/remote', entries: [] }
    if (op === 'workspace.register') return { id: 'host-ws', root: this.canonical, name: 'project' }
    if (op === 'fs.list') return { ok: true, entries: [{ name: 'file', path: 'file', isDirectory: false }], truncated: false, totalCount: 1 }
    if (op === 'session.list') return { sessions: [{ sessionId: 'saved', sessionFile: '/private/saved.jsonl', title: 'Saved', createdAt: 1, updatedAt: 2, modelId: 'remote/model', status: 'idle' }] }
    if (op === 'session.start') { const n = ++this.n; const identity = { sessionId: args.sessionFile === '/private/saved.jsonl' ? 'saved' : `session-${n}`, sessionFile: String(args.sessionFile || `/private/${n}.jsonl`) }; this.started.set(`runtime-${n}`, identity); return { runtimeId: `runtime-${n}`, ...identity, cwd: this.canonical, model: 'remote/model', thinkingLevel: 'medium', isStreaming: false } }
    if (op === 'session.rpc') {
      const command = args.command as Record<string, unknown>
      if (command.type === 'get_messages') return { type: 'response', command: command.type, success: true, data: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Remote history' }] }] } }
      if (command.type === 'get_tree') return { type: 'response', success: true, data: { tree: [{ entry: { type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: 'hello' } }, children: [{ entry: { type: 'message', id: 'assistant', parentId: 'entry', message: { role: 'assistant', content: [{ type: 'text', text: 'Remote history' }] } }, children: [] }] }], leafId: 'assistant' } }
      if (command.type === 'get_available_models') return { type: 'response', success: true, data: { models: [{ id: 'model', provider: 'remote', name: 'Remote model', maxTokens: 200 }] } }
      if (command.type === 'get_state') return { type: 'response', success: true, data: { ...this.started.get(String(args.runtimeId)), cwd: this.canonical, isStreaming: false } }
      return { type: 'response', command: command.type, success: true, data: { disposition: 'started' } }
    }
    if (op === 'terminal.create') return { id: 'native-pty', pid: 10, profile: { id: 'remote-default' } }
    if (op === 'git.status') return { snapshot: { raw: 'remote diff', stagedRaw: '', isRepo: true, branch: 'main', status: '', log: '' }, branchStatus: { isRepo: true, branch: 'main' } }
    return { ok: true }
  }
  event(event: Record<string, unknown>, runtimeId = 'runtime-1'): void { this.emit({ kind: 'record', record: { type: 'host_event', kind: 'pi', workspaceId: 'host-ws', runtimeId, event } }) }
}
function fixture(directory?: string) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'remote-code-test-')); if (!directory) roots.push(dir)
  const hosts: FakeHost[] = []; const events: { channel: string; payload: Record<string, unknown> }[] = []
  const p = profile()
  const local = { recentProjects: ['/local'], currentProject: '/local', theme: 'dark' }
  const service = new RemoteCodeService({ metadataDirectory: dir, profiles: () => [p], bootstrap: async () => 'trusted bundled bootstrap', transport: (emit) => { const h = new FakeHost(emit); hosts.push(h); return h }, localSettings: () => local, saveRightPanelLayout: (prefs, order) => { Object.assign(local, { rightPanelPrefs: prefs, rightPanelOrder: order }) }, emit: (channel, payload) => events.push({ channel, payload: payload as Record<string, unknown> }) })
  const connect = async (activate = true, prof = p) => { await service.connect({ profile: prof, activate }); return hosts.at(-1)! }
  const open = async (prof = p) => { const prep = await service.prepareWorkspace(prof.id, '/chosen-link'); return (await service.openWorkspace(prof.id, prep.path, prep.trustToken)).workspace }
  const invoke = async (method: string, req: unknown = {}) => {
    const result = await service.route('ipc:' + method, req)
    if (!result.handled) throw new Error('fell through to local')
    return result.value as { sessions: { sessionFile: string }[]; session: { sessionFile: string; sessionId: string }; state: Record<string, unknown>; items: unknown[]; id: string }
  }
  return { service, dir, p, hosts, events, local, connect, open, invoke }
}

describe('unified SSH Code service', () => {
  it('tags and reuses one utility runtime for metadata probes, without treating explicit new sessions as utilities', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    await f.invoke('model.list', { workspaceId: ws.workspaceId })
    await f.invoke('model.list', { workspaceId: ws.workspaceId })
    await f.invoke('commands.list', { workspaceId: ws.workspaceId })
    await f.invoke('session.list', { workspaceId: ws.workspaceId })
    const starts = host.calls.filter((call) => call.op === 'session.start')
    expect(starts).toHaveLength(1)
    expect(starts[0].args.utility).toBe(true)
    await f.invoke('session.new', { workspaceId: ws.workspaceId })
    expect(host.calls.filter((call) => call.op === 'session.start').at(-1)?.args).toMatchObject({ fresh: true, utility: false })
  })
  it('keeps remote draft model/effort metadata on a hidden probe, never the selected history', async () => {
    const f = fixture(), host = await f.connect(), ws = await f.open()
    const [saved] = await f.service.listSessionCatalog(ws.workspaceId)
    const values = new Map<string, { model: string; thinking: string }>()
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => {
      const response = await original(op, args)
      if (op !== 'session.rpc') return response
      const id = String(args.runtimeId), q = args.command as Record<string, unknown>
      const current = values.get(id) || { model: 'model', thinking: 'low' }
      if (q.type === 'set_model') { current.model = String(q.modelId); current.thinking = 'off'; values.set(id, current) }
      if (q.type === 'set_thinking_level') { current.thinking = current.model === 'plain' ? 'off' : String(q.level); values.set(id, current) }
      if (q.type === 'get_state') return { success: true, data: { ...host.started.get(id), model: { provider: 'remote', id: current.model }, thinkingLevel: current.thinking } }
      if (q.type === 'get_available_thinking_levels') return { success: true, data: { levels: current.model === 'plain' ? ['off'] : ['off', 'low', 'high'] } }
      return response
    })
    await f.invoke('session.setPendingBind', { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile })
    await f.invoke('runtime.getState', { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile })
    const draft = { workspaceId: ws.workspaceId, draft: true }
    expect(await f.service.route('ipc:model.set', { ...draft, provider: 'remote', modelId: 'plain' })).toMatchObject({ value: { modelId: 'remote/plain', availableThinkingLevels: ['off'] } })
    expect(await f.service.route('ipc:thinkingLevel.set', { ...draft, level: 'high' })).toMatchObject({ value: { level: 'off' } })
    expect(await f.service.route('ipc:model.set', { ...draft, provider: 'remote', modelId: 'reasoning' })).toMatchObject({ value: { availableThinkingLevels: ['off', 'low', 'high'] } })
    expect(await f.service.route('ipc:thinkingLevel.set', { ...draft, level: 'high' })).toMatchObject({ value: { level: 'high' } })
    expect(await f.invoke('runtime.getState', draft)).toMatchObject({ state: { bound: false, sessionFile: null, model: 'remote/reasoning', thinkingLevel: 'high', availableThinkingLevels: ['off', 'low', 'high'] } })
    expect(await f.invoke('runtime.getState', { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile })).toMatchObject({ state: { model: 'remote/model', thinkingLevel: 'low' } })
    const starts = host.calls.filter((call) => call.op === 'session.start')
    expect(starts).toHaveLength(2)
    expect(starts[1].args).toMatchObject({ utility: true, fresh: false })
    expect(host.calls.some((call) => call.op === 'session.rpc' && ['prompt', 'steer', 'follow_up', 'bash'].includes(String((call.args.command as Record<string, unknown>).type)))).toBe(false)
    await expect(f.invoke('model.set', { ...draft, sessionFile: saved.sessionFile, provider: 'remote', modelId: 'wrong' })).rejects.toThrow('Draft metadata requires')
  })
  it('remote deletion requires exact known identities, never dials/starts Pi, and keeps explicit native deletes local', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const [saved] = await f.service.listSessionCatalog(ws.workspaceId)
    const identity = { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile }
    const before = host.calls.length
    await expect(f.invoke('session.delete', { workspaceId: ws.workspaceId })).rejects.toThrow('Exact remote')
    await expect(f.invoke('session.delete', { ...identity, sessionFile: ws.workspaceId + '/.sessions/forged.jsonl' })).rejects.toThrow('Unknown')
    expect(await f.service.route('ipc:session.delete', { workspaceId: '/local', sessionFile: '/local/saved.jsonl' })).toEqual({ handled: false })
    expect(host.calls).toHaveLength(before)
    expect(await f.invoke('session.delete', identity)).toEqual({ ok: true })
    expect(host.calls.at(-1)).toEqual({ op: 'session.delete', args: { workspaceId: 'host-ws', sessionFile: '/private/saved.jsonl', sessionId: 'saved' } })
    expect(host.calls.some((call) => call.op === 'session.start')).toBe(false)
    f.service.disconnect(f.p.id)
    expect(await f.service.listSessionCatalog(ws.workspaceId)).toEqual([])
    expect(f.service.snapshot.targetId).toBe(`ssh:${f.p.id}`)
  })
  it('remote deletion does not retarget a stale virtual key when the same native path has a different session ID', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const [old] = await f.service.listSessionCatalog(ws.workspaceId)
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => {
      if (op === 'session.list') return { sessions: [{ sessionId: 'replacement', sessionFile: '/private/saved.jsonl', title: 'Replacement' }] }
      if (op === 'session.delete') { expect(args.sessionId).toBe('saved'); throw new Error('session_identity_changed') }
      return original(op, args)
    })
    const [replacement] = await f.service.listSessionCatalog(ws.workspaceId)
    expect(replacement.key).not.toBe(old.key)
    await expect(f.invoke('session.delete', { workspaceId: ws.workspaceId, sessionFile: old.sessionFile })).rejects.toThrow('session_identity_changed')
    expect(f.service.snapshot.targetId).toBe(`ssh:${f.p.id}`)
  })
  it('remote deletion explains disconnected entries and propagates host refusal without removing history', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const [saved] = await f.service.listSessionCatalog(ws.workspaceId)
    const identity = { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile }
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation((op, args) => op === 'session.delete' ? Promise.resolve({ ok: false, error: 'unsafe_session_file' }) : original(op, args))
    await expect(f.invoke('session.delete', identity)).rejects.toThrow('unsafe_session_file')
    f.service.disconnect(f.p.id)
    const before = host.calls.length
    await expect(f.invoke('session.delete', identity)).rejects.toThrow('Connect to this SSH host')
    expect(host.calls).toHaveLength(before); expect(host.connected).toBe(false)
    expect(await f.service.listSessionCatalog(ws.workspaceId)).toMatchObject([{ sessionFile: saved.sessionFile, disconnected: true }])
  })
  it('remote deletion refuses accepted work and RPC/start races and does not clear a newer foreground', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const a = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session
    const identity = { workspaceId: ws.workspaceId, sessionFile: a.sessionFile }
    await f.invoke('prompt.send', { ...identity, text: 'hello' })
    await expect(f.invoke('session.delete', identity)).rejects.toThrow('busy')
    host.event({ type: 'agent_settled' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => { if (op === 'session.delete') await gate; return original(op, args) })
    const deleting = f.invoke('session.delete', identity)
    await expect(f.invoke('prompt.send', { ...identity, text: 'race' })).rejects.toThrow('deletion is in progress')
    const b = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session
    release(); expect(await deleting).toEqual({ ok: true })
    expect((await f.invoke('runtime.getState', { workspaceId: ws.workspaceId })).state.sessionFile).toBe(b.sessionFile)
    expect(host.calls.filter((call) => call.op === 'session.delete')).toHaveLength(1)
    await expect(f.invoke('session.getMessages', identity)).rejects.toThrow('Unknown')
  })
  it('remote deletion refuses runtime handshakes and outstanding read RPCs', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const [saved] = await f.service.listSessionCatalog(ws.workspaceId)
    const identity = { workspaceId: ws.workspaceId, sessionFile: saved.sessionFile }
    let release!: () => void
    let gate = new Promise<void>((resolve) => { release = resolve })
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => {
      const result = await original(op, args)
      if (op === 'session.rpc' && (args.command as Record<string, unknown>).type === 'get_state') await gate
      return result
    })
    const starting = f.invoke('session.getMessages', identity)
    await vi.waitFor(() => expect(host.calls.some((call) => call.op === 'session.start')).toBe(true))
    await expect(f.invoke('session.delete', identity)).rejects.toThrow('busy')
    release(); await starting
    gate = new Promise<void>((resolve) => { release = resolve })
    const read = f.invoke('runtime.getState', identity)
    await vi.waitFor(() => expect(host.calls.filter((call) => call.op === 'session.rpc' && (call.args.command as Record<string, unknown>).type === 'get_state')).toHaveLength(2))
    await expect(f.invoke('session.delete', identity)).rejects.toThrow('busy')
    release(); await read
    expect(host.calls.some((call) => call.op === 'session.delete')).toBe(false)
  })
  it('remote hydration and clearing pending binds do not create or adopt utilities or lose the explicit current runtime', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    expect(await f.invoke('session.getMessages', { workspaceId: ws.workspaceId })).toMatchObject({ items: [] })
    await f.invoke('session.tree', { workspaceId: ws.workspaceId })
    expect(host.calls.some((call) => call.op === 'session.start')).toBe(false)
    await f.invoke('model.list', { workspaceId: ws.workspaceId })
    await f.invoke('session.setEphemeralDraft', { workspaceId: ws.workspaceId, active: true })
    await f.invoke('model.list', { workspaceId: ws.workspaceId })
    expect(host.calls.filter((call) => call.op === 'session.start')).toHaveLength(1)
    expect((await f.invoke('runtime.getState', { workspaceId: ws.workspaceId })).state).toBeNull()
    const created = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session
    await f.invoke('session.setPendingBind', { sessionFile: null, workspaceId: ws.workspaceId })
    expect((await f.invoke('runtime.getState', { workspaceId: ws.workspaceId })).state.sessionFile).toBe(created.sessionFile)
    await f.invoke('prompt.send', { workspaceId: ws.workspaceId, text: 'first message' })
    expect(host.calls.filter((call) => call.op === 'session.start')).toHaveLength(2)
    expect(host.calls.some((call) => call.op === 'session.adopt')).toBe(false)
  })
  it('preserves validated password-mode transport stages but never arbitrary echoed errors', async () => {
    const f = fixture(), profile = { ...f.p, authMethod: 'password' as const }
    const message = 'SSH reached the remote shell, but the configured remote Node executable was not found.'
    const spy = vi.spyOn(FakeHost.prototype, 'connect').mockRejectedValueOnce(new SshSafeConnectError(message))
    try {
      await expect(f.service.connect({ profile, password: 'not-a-real-secret' })).rejects.toThrow(message)
      spy.mockRejectedValueOnce(new Error('not-a-real-secret'))
      await expect(f.service.connect({ profile, password: 'not-a-real-secret' })).rejects.toThrow('verify credentials and remote Node.js')
      expect(f.service.snapshot.connections[0].error).not.toContain('not-a-real-secret')
    } finally { spy.mockRestore() }
  })
  it('preserves shared Review preferences without scanning local adapters for SSH roots', async () => {
    const f = fixture(); const host = await f.connect(); const workspace = await f.open()
    Object.assign(f.local, { rightPanelPrefs: { review: true, files: true }, rightPanelOrder: ['review', 'files'] })
    host.calls.length = 0
    expect(await f.invoke('rightPanels.catalog', { workspaceId: workspace.workspaceId })).toMatchObject({ catalog: expect.arrayContaining([expect.objectContaining({ id: 'review' })]), prefs: { review: true, files: true }, adapterPanels: [] })
    expect(host.calls).toHaveLength(0)
    Object.assign(f.local, { rightPanelPrefs: { browser: true, 'adapter:private': true }, rightPanelOrder: ['browser', 'adapter:private'] })
    await f.invoke('rightPanels.saveLayout', { workspaceId: workspace.workspaceId, prefs: { review: true }, order: ['review'] })
    expect(f.local).toMatchObject({ rightPanelPrefs: { review: true, browser: true, 'adapter:private': true }, rightPanelOrder: expect.arrayContaining(['browser', 'adapter:private']) })
  })
  it('rejects local terminal IDs in explicit SSH requests and cross-workspace remote IDs', async () => {
    const f = fixture(); await f.connect(); const first = await f.open()
    await expect(f.invoke('terminal.kill', { workspaceId: first.workspaceId, id: 'local-pty' })).rejects.toThrow('Remote terminal ID')
    const term = await f.invoke('terminal.create', { workspaceId: first.workspaceId })
    const otherProfile = { ...f.p, id: randomUUID(), name: 'Other host', host: 'other.invalid' }
    await f.connect(true, otherProfile); const second = await f.open(otherProfile)
    await expect(f.invoke('terminal.resize', { workspaceId: second.workspaceId, id: term.id, cols: 80, rows: 24 })).rejects.toThrow('workspace mismatch')
    f.service.local()
    await expect(f.invoke('extension.respondUI', { workspaceId: first.workspaceId, id: 'local-dialog', confirmed: true })).rejects.toThrow('Remote extension dialog ID')
  })
  it('changes virtual identities when a profile UUID is reused for a different host', async () => {
    const f = fixture(); await f.connect(); const before = await f.open()
    f.service.disconnect(f.p.id)
    const changed = { ...f.p, host: 'different.invalid' }
    await f.connect(true, changed); const after = await f.open(changed)
    expect(after.workspaceId).not.toBe(before.workspaceId)
    await expect(f.invoke('workspace.fs.listDir', { workspaceRoot: before.workspaceId })).rejects.toThrow('Unknown reserved')
  })
  it('does not commit a terminal from an old connection after an awaited reply', async () => {
    const f = fixture(); const host = await f.connect(); const workspace = await f.open()
    const original = host.requestHost.bind(host)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    host.requestHost = async (op, args) => { const data = await original(op, args); if (op === 'terminal.create') await blocked; return data }
    const pending = f.invoke('terminal.create', { workspaceId: workspace.workspaceId })
    await vi.waitFor(() => expect(host.calls.some((call) => call.op === 'terminal.create')).toBe(true))
    f.service.disconnect(f.p.id, true); release()
    await expect(pending).rejects.toThrow('connection changed')
    expect(f.service.terminalCount).toBe(0)
  })
  it('does not start Pi at connection/browse time, and blocks all mutable/read workspace work until trust', async () => {
    const f = fixture(); const host = await f.connect()
    expect(f.service.snapshot.targetId).toBe(`ssh:${f.p.id}`)
    expect(await f.invoke('session.list')).toEqual({ sessions: [] })
    expect(await f.invoke('model.list')).toEqual({ models: [] })
    for (const method of ['prompt.send', 'workspace.fs.listDir', 'review.getDiff', 'terminal.create']) await expect(f.invoke(method, { text: 'hello' })).rejects.toThrow('trust')
    await f.service.browse(f.p.id)
    await expect(f.service.openWorkspace(f.p.id, '/remote/project')).rejects.toThrow('trust')
    expect(host.calls.every((c) => c.op === 'browse')).toBe(true)
    const ws = await f.open()
    expect(ws.workspaceId).toMatch(/^\/__pi_ssh__\//)
    expect(host.calls.some((c) => c.op === 'session.start')).toBe(false)
    await f.invoke('workspace.fs.listDir', { workspaceRoot: ws.workspaceId })
    expect(host.calls.at(-1)?.op).toBe('fs.list')
  })
  it('requires a one-use canonical path token and rechecks original symlinks', async () => {
    const f = fixture(); const host = await f.connect()
    const prep = await f.service.prepareWorkspace(f.p.id, '/link')
    host.canonical = '/remote/other'
    await expect(f.service.openWorkspace(f.p.id, prep.path, prep.trustToken)).rejects.toThrow('trust')
    host.canonical = prep.path
    await expect(f.service.openWorkspace(f.p.id, prep.path, prep.trustToken)).rejects.toThrow('trust')
    expect(host.calls.some((c) => c.op === 'workspace.register')).toBe(false)
  })
  it('expires tokens and rejects an original symlink retargeted while the canonical path still exists', async () => {
    const f = fixture(); const host = await f.connect()
    const prep = await f.service.prepareWorkspace(f.p.id, '/link')
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => op === 'browse' && args.path === '/link' ? { path: '/changed', home: '/remote', entries: [] } : original(op, args))
    await expect(f.service.openWorkspace(f.p.id, prep.path, prep.trustToken)).rejects.toThrow('changed since')
    const next = await f.service.prepareWorkspace(f.p.id, '/remote/project')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    try { await expect(f.service.openWorkspace(f.p.id, next.path, next.trustToken)).rejects.toThrow('trust') } finally { vi.restoreAllMocks() }
    expect(host.calls.some((c) => c.op === 'workspace.register')).toBe(false)
  })
  it('bounds concurrent connections and restores persisted trusted roots without starting Pi', async () => {
    const f = fixture(); await f.connect(); const ws = await f.open()
    for (let i = 0; i < 3; i++) await f.connect(false, profile())
    await expect(f.connect(false, profile())).rejects.toThrow('four')
    await f.service.shutdown()
    const second = fixture(f.dir)
    const host = await second.connect(true, f.p)
    expect(second.service.snapshot.selectedWorkspace?.workspaceId).toBe(ws.workspaceId)
    expect(host.calls).toHaveLength(0)
    await second.invoke('workspace.fs.listDir', { workspaceRoot: ws.workspaceId })
    expect(host.calls.map((c) => c.op)).toEqual(['workspace.register', 'fs.list'])
  })
  it('rejects token replay across hosts, and isolates same-native-path hosts/sessions', async () => {
    const f = fixture(); await f.connect(); const second = profile(); await f.connect(false, second)
    const prep = await f.service.prepareWorkspace(f.p.id, '/link')
    await expect(f.service.openWorkspace(second.id, prep.path, prep.trustToken)).rejects.toThrow('trust')
    const a = await f.open(); const b = await f.open(second)
    expect(a.nativePath).toBe(b.nativePath); expect(a.workspaceId).not.toBe(b.workspaceId)
    const sa = (await f.invoke('session.list', { workspaceId: a.workspaceId })).sessions[0]
    const sb = (await f.invoke('session.list', { workspaceId: b.workspaceId })).sessions[0]
    expect(sa.sessionFile).not.toBe(sb.sessionFile)
    await f.invoke('prompt.send', { sessionFile: sa.sessionFile, text: 'first only' })
    expect(f.hosts[0].calls.at(-1)?.args.command).toMatchObject({ type: 'prompt', message: 'first only' })
    expect(f.hosts[1].calls.some((c) => c.op === 'session.rpc')).toBe(false)
  })
  it('persists private validated trust but no passwords; local root restore does not mutate config', async () => {
    const f = fixture()
    await expect(f.connect(true, { ...f.p, authMethod: 'password' })).rejects.toThrow('transient password')
    // Credentials are accepted by fake transport only transiently; no service metadata contains them.
    await f.service.connect({ profile: { ...f.p, authMethod: 'password' }, password: 'transient-only', activate: true })
    const ws = await f.open()
    const file = join(f.dir, 'metadata.json')
    expect(readFileSync(file, 'utf8')).not.toContain('transient-only')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await f.invoke('settings.get', { key: 'currentProject' })).toEqual({ settings: { currentProject: ws.workspaceId } })
    await f.invoke('settings.set', { key: 'currentProject', value: ws.workspaceId })
    expect(f.local.currentProject).toBe('/local')
    expect(f.service.local()).toMatchObject({ recentProjects: ['/local'], currentProject: '/local', snapshot: { targetId: 'local' } })
    expect(f.hosts.at(-1)?.connected).toBe(true)
    writeFileSync(file, '{"version":1,"roots":[{"password":"bad"}]}')
    expect(() => fixture(f.dir)).toThrow('metadata is invalid')
  })
  it('reuses matching live connections; changed params/password demand disconnect; browse-only does not activate', async () => {
    const f = fixture(); const host = await f.connect(false)
    expect(f.service.snapshot.targetId).toBe('local')
    await f.service.connect({ profile: f.p, activate: false })
    expect(f.hosts).toHaveLength(1)
    await expect(f.service.connect({ profile: { ...f.p, host: 'other.invalid' } })).rejects.toThrow('Disconnect')
    await expect(f.service.connect({ profile: f.p, password: 'new' })).rejects.toThrow('Disconnect')
    expect(host.calls).toHaveLength(0)
  })
  it('pins explicit local identities even with remote selected; unknown virtual keys fail closed even when local selected', async () => {
    const f = fixture(); await f.connect(); const ws = await f.open()
    for (const [method, req] of [['prompt.send', { sessionFile: '/local/session', text: 'local' }], ['review.getDiff', { cwd: '/local' }], ['workspace.open', { path: '/local' }], ['terminal.create', { cwd: '/local' }], ['model.list', { scope: 'settings' }]] as const) expect(await f.service.route('ipc:' + method, req)).toEqual({ handled: false })
    for (const method of ['browser.open', 'session.delete', 'rewind.runCommand', 'shell.openPath', 'background.list', 'resources.list']) await expect(f.invoke(method, { workspaceId: ws.workspaceId, path: ws.workspaceId + '/file' })).rejects.toThrow()
    await expect(f.invoke('prompt.send', { workspaceId: ws.workspaceId, sessionFile: '/local/session', text: 'no' })).rejects.toThrow('Mixed')
    f.service.local()
    await expect(f.invoke('workspace.open', { path: '/__pi_ssh__/unknown' })).rejects.toThrow('Unknown reserved')
    await expect(f.invoke('background.start', { tasks: [{ cwd: ws.workspaceId }] })).rejects.toThrow('Nested or unsupported')
    await expect(f.invoke('workspace.open', { path: ws.workspaceId + '/forged' })).rejects.toThrow('Unknown reserved')
  })
  it('projects delta-only prompts, tools, queues and completion; agent_end is NOT settled', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const session = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session
    await f.invoke('prompt.send', { sessionFile: session.sessionFile, text: 'hello' })
    expect(f.service.hasActiveWork).toBe(true) // ACK is not completion, even before agent_start.
    expect(() => f.service.disconnect(f.p.id)).toThrow('active work')
    host.event({ type: 'agent_start' }); host.event({ type: 'turn_start' })
    host.event({ type: 'message_start', message: { role: 'assistant', content: [] } })
    host.event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'reason' } })
    host.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } })
    host.event({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: '/etc/passwd' } })
    host.event({ type: 'tool_execution_end', toolCallId: 'tool', toolName: 'read', result: { content: [{ type: 'text', text: 'done' }] }, isError: false })
    host.event({ type: 'queue_update', steering: ['next'], followUp: [] })
    host.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer final' }] } })
    host.event({ type: 'agent_end' })
    expect(f.service.hasActiveWork).toBe(true)
    expect(f.events.some((e) => e.payload.type === 'completion')).toBe(false)
    expect(() => f.service.disconnect(f.p.id)).toThrow('active work')
    host.event({ type: 'agent_settled' })
    expect(f.service.hasActiveWork).toBe(false)
    const events = f.events.filter((e) => e.channel === 'ipc:events' && e.payload.type !== 'remote-settings-changed').map((e) => e.payload)
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', phase: 'delta', contentKind: 'thinking', text: 'reason' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', phase: 'end', text: 'answer final' }))
    expect((events.find((e) => e.type === 'tool')?.input as Record<string, unknown> | undefined)?.path).toContain(ws.workspaceId + '/.outside/')
    expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'success', settled: true })
    for (const event of events) {
      expect(event).toMatchObject({ workspaceId: ws.workspaceId, sessionFile: session.sessionFile, sessionId: session.sessionId, seq: expect.any(Number), timestamp: expect.any(Number) })
      if (event.phase !== 'state') expect(event.runId).toEqual(expect.any(String))
    }
  })
  it('does not relock a very fast completed turn when the prompt ACK arrives late', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const sessionFile = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session.sessionFile
    const original = host.requestHost.bind(host)
    vi.spyOn(host, 'requestHost').mockImplementation(async (op, args) => {
      if (op === 'session.rpc' && (args.command as Record<string, unknown>).type === 'prompt') { host.event({ type: 'agent_start' }); host.event({ type: 'agent_settled' }) }
      return original(op, args)
    })
    await f.invoke('prompt.send', { sessionFile, text: 'fast' })
    expect(f.service.hasActiveWork).toBe(false)
    expect(f.events.filter((e) => e.payload.type === 'completion')).toHaveLength(1)
    expect(() => f.service.disconnect(f.p.id)).not.toThrow()
  })
  it('maps history/tree/model shapes without native keys and rejects invalid prompt before Pi starts', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    await expect(f.invoke('prompt.send', { workspaceId: ws.workspaceId, text: 100 })).rejects.toThrow()
    expect(host.calls.some((c) => c.op === 'session.start')).toBe(false)
    const list = await f.invoke('session.list', { workspaceId: ws.workspaceId }); const sessionFile = list.sessions[0].sessionFile
    const history = await f.invoke('session.getMessages', { sessionFile })
    expect(history.items[1]).toMatchObject({ type: 'assistant-message', text: 'Remote history', sessionEntryId: 'assistant' })
    expect(await f.invoke('session.tree', { sessionFile })).toMatchObject({ nodes: [{ id: 'entry', depth: 0, preview: 'hello', isLeaf: false }, { id: 'assistant', depth: 1, isLeaf: true }], leafId: 'assistant' })
    expect(await f.invoke('model.list')).toMatchObject({ models: [{ provider: 'remote', maxOutput: 200 }] })
    const state = (await f.invoke('runtime.getState', { sessionFile })).state
    expect(state.sessionFile).toBe(sessionFile); expect(state.cwd).toBe(ws.workspaceId)
  })
  it('routes extension dialogs back to their runtime even after selecting local', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const sessionFile = (await f.invoke('session.new', { workspaceId: ws.workspaceId })).session.sessionFile
    host.event({ type: 'extension_ui_request', id: 'native-dialog', method: 'confirm', title: 'Approve?', message: 'Test' })
    const dialog = f.events.find((e) => e.channel === 'ipc:extension-ui-request')!.payload
    expect(dialog.id).toMatch(/^ssh-ui-/); expect(dialog.sessionFile).toBe(sessionFile)
    f.service.local()
    await f.invoke('extension.respondUI', { id: dialog.id, confirmed: true })
    expect(host.calls.at(-1)?.args.command).toEqual({ type: 'extension_ui_response', id: 'native-dialog', confirmed: true })
    await expect(f.invoke('extension.cancelUI', { id: dialog.id })).rejects.toThrow('expired')
  })
  it('pins remote terminal IDs/events/writes and does not switch to local after disconnect', async () => {
    const f = fixture(); const host = await f.connect(); const ws = await f.open()
    const term = await f.invoke('terminal.create', { cwd: ws.workspaceId, cols: 80, rows: 24 })
    expect(term.id).toMatch(/^ssh-term-/); expect(f.service.terminalCount).toBe(1)
    f.service.local()
    expect(f.service.writeTerminal(term.id, 'echo hello\n')).toBe(true)
    await vi.waitFor(() => expect(host.calls.at(-1)?.op).toBe('terminal.write'))
    expect(f.service.writeTerminal('local-id', 'local')).toBe(false)
    expect(f.service.writeTerminal('ssh-term-unknown', 'swallow')).toBe(true)
    host.emit({ kind: 'record', record: { type: 'host_event', kind: 'terminal-data', terminalId: 'native-pty', workspaceId: 'host-ws', data: 'remote output' } })
    expect(f.events.at(-1)).toEqual({ channel: 'ipc:terminal-data', payload: { id: term.id, data: 'remote output' } })
    f.service.select(f.p.id)
    expect(() => f.service.disconnect(f.p.id)).toThrow('terminals')
    f.service.disconnect(f.p.id, true)
    expect(f.service.snapshot.targetId).toBe(`ssh:${f.p.id}`)
    expect(f.service.terminalCount).toBe(0)
    await expect(f.invoke('prompt.send', { text: 'no local execution' })).rejects.toThrow('not connected')
  })
  it('cancels late draft connection without selecting it or starting model', async () => {
    const f = fixture(); let finish!: () => void
    const pending = f.service.connect({ profile: f.p, activate: false })
    f.hosts[0].gate = new Promise<void>((resolve) => { finish = resolve })
    await Promise.resolve()
    f.service.disconnect(f.p.id, true); finish()
    await expect(pending).rejects.toThrow('cancelled')
    expect(f.service.snapshot.targetId).toBe('local')
    expect(f.hosts[0].connected).toBe(false)
    expect(f.hosts[0].calls).toHaveLength(0)
  })
})
