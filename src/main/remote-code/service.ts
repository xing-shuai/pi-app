import { createHash, randomUUID } from 'node:crypto'
import { buildSessionContextPreview } from '@shared/session-context-preview'
import { unavailableUsage } from '../provider-usage/service'
import type { SessionCatalogEntry, SessionCatalogLocation } from '@shared/session-catalog-types'
import { posix } from 'node:path'
import { z } from 'zod'
import { sshPasswordSchema, sshProfileSchema, type SshProfile, type SshWorkspaceEvent } from '@shared/ssh-workspace'
import type { HostDirectory, HostEvent, HostOperation, HostSession, HostState, HostWorkspace } from '@shared/ssh-host-types'
import { isVirtualWorkspacePath, virtualWorkspacePath, type RemoteCodeConnection, type RemoteCodeSnapshot, type RemoteCodeWorkspace } from '@shared/remote-code'
import { timelineItemsFromBranchPath } from '../../worker/worker-timeline'
import { mergeRightPanelCatalog, normalizeRightPanelPrefs, normalizeRightPanelOrder, defaultRightPanelPrefsForCatalog, type RightPanelPrefs } from '@shared/right-panels'
import { sessionTreePreview } from '@shared/worker-message'
import { SshSafeConnectError } from '../ssh/ssh-workspace'
import { RemoteMetadataStore, type RemoteMetadata } from './metadata'
import { isolatePaths, record, RemoteProjection } from './projection'

export interface HostTransport {
  connect(profile: SshProfile, sessionFile?: string, credentials?: { password?: string }, opts?: { remoteCommand?: string; hostMode?: boolean }): Promise<unknown>
  disconnect(): void
  getHostState(): HostState | undefined
  requestHost(op: HostOperation, args: Record<string, unknown>): Promise<unknown>
  readonly hasActiveWork: boolean
}
export type RemoteCodeDependencies = {
  metadataDirectory: string
  transport: (emit: (event: SshWorkspaceEvent) => void) => HostTransport
  bootstrap: (profile: SshProfile) => Promise<string>
  profiles: () => SshProfile[]
  localSettings: () => { recentProjects: string[]; currentProject: string | null; [key: string]: unknown }
  emit: (channel: string, payload: unknown) => void
  now?: () => number
  saveRightPanelLayout?: (prefs: RightPanelPrefs, order: string[]) => void
}
type Connection = { profile: SshProfile; fingerprint: string; dto: RemoteCodeConnection; transport: HostTransport; generation: string; terminalCreates: number; earlyTerminal: HostEvent[] }
type Workspace = { dto: RemoteCodeWorkspace; host?: HostWorkspace; connection: Connection; selectedSession?: string; starting?: Promise<Runtime>; probe?: Runtime; probeStarting?: Promise<Runtime>; starts?: number }
type Session = { key: string; native: string; sessionId: string; workspace: Workspace; runtime?: Runtime; starting?: Promise<Runtime>; deleting?: boolean }
type Runtime = { host: HostSession; session: Session; projection: RemoteProjection; pendingPrompts: number; acceptedWork: boolean; settleEpoch: number; rpcCount?: number; hydrationEpoch?: number; details?: Record<string, unknown> }
type Terminal = { id: string; nativeId: string; workspace: Workspace; pendingData: string; writing: boolean }
const uuid = z.string().uuid()
const nativePath = z.string().min(1).max(4096).refine((s) => !/[\0\r\n]/.test(s))
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const fingerprint = (p: SshProfile) => hash(JSON.stringify([p.host, p.port, p.user, p.identityFile, p.authMethod, p.nodePath, p.piPath]))
const empty = { handled: false } as const
/** Reserved paths nested in an unsupported payload must never reach a local handler either. */
export function reservedRemotePaths(value: unknown, key = '', depth = 0): string[] {
  if (typeof value === 'string') return !['text', 'message', 'password', 'content', 'data'].includes(key) && isVirtualWorkspacePath(value) ? [value] : []
  if (!value || typeof value !== 'object') return []
  if (depth > 32) throw new Error('IPC request nesting exceeds the remote routing limit')
  if (Array.isArray(value)) return value.flatMap((v) => reservedRemotePaths(v, key, depth + 1))
  return Object.entries(value).flatMap(([k, v]) => reservedRemotePaths(v, k, depth + 1))
}

export class RemoteCodeService {
  private connections = new Map<string, Connection>()
  private workspaces = new Map<string, Workspace>()
  private sessions = new Map<string, Session>()
  private runtimes = new Map<string, Runtime>()
  private terminals = new Map<string, Terminal>()
  private dialogs = new Map<string, { runtime: Runtime; nativeId: string }>()
  private tokens = new Map<string, { connection: Connection; original: string; canonical: string; expires: number }>()
  // Process-local bounded metadata cache; never credentials or transcript bodies.
  private catalogCache = new Map<string, SessionCatalogEntry[]>()
  private catalogRevision = 0
  private selected?: string
  private selectedWorkspace?: string
  private store: RemoteMetadataStore
  private metadata: RemoteMetadata
  constructor(private deps: RemoteCodeDependencies) {
    this.store = new RemoteMetadataStore(deps.metadataDirectory)
    this.metadata = this.store.load()
  }
  get snapshot(): RemoteCodeSnapshot {
    const selected = this.selectedWorkspace && this.workspaces.get(this.selectedWorkspace)
    return {
      targetId: this.selected ? `ssh:${this.selected}` : 'local',
      connections: [...this.connections.values()].map((c) => ({ ...c.dto })),
      workspaces: [...this.workspaces.values()].filter((w) => w.dto.profileId === this.selected).map((w) => ({ ...w.dto })),
      ...(selected && selected.dto.profileId === this.selected ? { selectedWorkspace: { ...selected.dto } } : {}),
    }
  }
  /** All fingerprint-matching saved roots, not the selected target's UI projection. No SSH dial. */
  get sessionCatalogLocations(): SessionCatalogLocation[] {
    return this.metadata.roots.flatMap((root) => {
      const profile = this.deps.profiles().find((p) => p.id === root.profileId)
      if (!profile || fingerprint(profile) !== root.fingerprint) return []
      const workspaceId = virtualWorkspacePath(profile.id, hash(root.fingerprint + '\0' + root.path).slice(0, 24), root.name)
      const c = this.connections.get(profile.id)
      return [{ targetId: `ssh:${profile.id}` as const, profileId: profile.id, label: profile.name, workspaceId, nativePathDisplay: root.path, projectName: root.name, disconnected: !c || c.fingerprint !== root.fingerprint || c.dto.status !== 'connected' }]
    })
  }
  /** User-click preparation only. Canonical trust check without changing the foreground target. */
  async prepareSessionCatalogOpen(workspaceId: string): Promise<RemoteCodeWorkspace> {
    const location = this.sessionCatalogLocations.find((item) => item.workspaceId === workspaceId)
    const w = this.workspaces.get(workspaceId)
    if (!location || !w) throw new Error('Unknown or changed SSH workspace identity')
    const directory = await this.browse(w.dto.profileId, w.dto.nativePath)
    if (directory.path !== w.dto.nativePath) throw new Error('Remote workspace canonical path changed; choose it again')
    await this.ensureWorkspace(w)
    return { ...w.dto }
  }
  async listSessionCatalog(workspaceId: string): Promise<SessionCatalogEntry[]> {
    const location = this.sessionCatalogLocations.find((item) => item.workspaceId === workspaceId)
    if (!location) throw new Error('Unknown or changed SSH workspace identity')
    const cached = () => (this.catalogCache.get(workspaceId) || []).map((entry) => ({ ...entry, disconnected: true, status: 'idle' as const }))
    if (location.disconnected) return cached()
    const w = this.workspaces.get(workspaceId)
    if (!w) throw new Error('Unknown SSH workspace')
    try {
      const revision = this.catalogRevision
      const data = record(await this.call(w, 'session.list'))
      if (revision !== this.catalogRevision) return this.listSessionCatalog(workspaceId)
      const rows: SessionCatalogEntry[] = (Array.isArray(data.sessions) ? data.sessions : []).slice(0, 500).flatMap((value) => {
        const row = record(value)
        if (typeof row.sessionId !== 'string' || typeof row.sessionFile !== 'string') return []
        const s = this.session(w, row.sessionFile, row.sessionId)
        return [{ key: s.key, sessionId: s.sessionId, sessionFile: s.key, workspaceId, nativePathDisplay: location.nativePathDisplay, projectName: location.projectName, title: typeof row.title === 'string' ? row.title : 'New session', targetId: location.targetId, profileId: location.profileId, locationLabel: location.label, status: s.runtime && (s.runtime.projection.active || s.runtime.acceptedWork || s.runtime.pendingPrompts > 0) || row.status === 'busy' ? 'busy' : 'idle', updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0, messageCount: typeof row.messageCount === 'number' ? row.messageCount : undefined, firstMessage: typeof row.firstMessage === 'string' ? row.firstMessage.slice(0, 120) : undefined, hasUserMessages: typeof row.hasUserMessages === 'boolean' ? row.hasUserMessages : undefined, disconnected: false }]
      })
      this.catalogCache.delete(workspaceId); this.catalogCache.set(workspaceId, rows)
      let count = [...this.catalogCache.values()].reduce((n, rows) => n + rows.length, 0)
      for (const [key, entries] of this.catalogCache) { if (count <= 500) break; this.catalogCache.delete(key); count -= entries.length }
      return rows
    } catch (error) {
      if (this.catalogCache.has(workspaceId)) return cached()
      throw error
    }
  }
  private publish(): void { this.deps.emit('ipc:code-environment-event', { kind: 'snapshot', snapshot: this.snapshot }) }
  get hasActiveWork(): boolean {
    return [...this.runtimes.values()].some((r) => r.projection.active || r.pendingPrompts > 0 || r.acceptedWork) || [...this.connections.values()].some((c) => c.transport.hasActiveWork || c.dto.status === 'connecting')
  }
  get terminalCount(): number { return this.terminals.size }
  hasTerminal(id: string): boolean { return this.terminals.has(id) || id.startsWith('ssh-term-') }
  writeTerminal(id: string, data: string): boolean {
    if (!this.hasTerminal(id)) return false
    const t = this.terminals.get(id)
    if (t && typeof data === 'string' && t.pendingData.length + data.length <= 1024 * 1024) {
      t.pendingData += data
      if (!t.writing) { t.writing = true; queueMicrotask(() => { void this.flushTerminal(t) }) }
    }
    return true // Unknown reserved IDs are consumed, never sent to a local PTY.
  }
  private async flushTerminal(t: Terminal): Promise<void> {
    try {
      while (t.pendingData && this.terminals.get(t.id) === t) {
        const data = t.pendingData; t.pendingData = ''
        await this.call(t.workspace, 'terminal.write', { id: t.nativeId, data })
      }
    } catch { t.pendingData = '' } finally { t.writing = false }
  }
  local(): { snapshot: RemoteCodeSnapshot; recentProjects: string[]; currentProject: string | null } {
    this.selected = undefined; this.selectedWorkspace = undefined; this.publish()
    const { recentProjects, currentProject } = this.deps.localSettings()
    return { snapshot: this.snapshot, recentProjects, currentProject }
  }
  private connection(id: string, connected = true): Connection {
    const c = this.connections.get(uuid.parse(id))
    if (!c || (connected && c.dto.status !== 'connected')) throw new Error('SSH host is not connected')
    return c
  }
  async connect(raw: unknown): Promise<{ connection: RemoteCodeConnection; snapshot: RemoteCodeSnapshot }> {
    const req = z.object({ profileId: uuid.optional(), profile: sshProfileSchema.optional(), password: sshPasswordSchema.optional(), activate: z.boolean().default(true) }).strict().safeParse(raw)
    // Static validation error: never include a credential value in diagnostics.
    if (!req.success) throw new Error('Invalid SSH connection request')
    let { password } = req.data
    const profile = req.data.profile || this.deps.profiles().find((p) => p.id === req.data.profileId)
    if (!profile || (req.data.profileId && req.data.profileId !== profile.id)) throw new Error('SSH profile not found or mismatched')
    const p = sshProfileSchema.parse(profile)
    const old = this.connections.get(p.id)
    if (old && old.dto.status !== 'disconnected') {
      if (password !== undefined || fingerprint(p) !== old.fingerprint) throw new Error('Disconnect before changing SSH connection parameters')
      if (old.dto.status !== 'connected') throw new Error('SSH connection is already in progress')
      if (req.data.activate) this.select(p.id)
      return { connection: { ...old.dto }, snapshot: this.snapshot }
    }
    if (p.authMethod === 'password' && password === undefined) throw new Error('SSH password authentication requires a transient password')
    if (p.authMethod !== 'password' && password !== undefined) throw new Error('A password may only be supplied for SSH password authentication')
    if ([...this.connections.values()].filter((c) => c.dto.status !== 'disconnected').length >= 4) throw new Error('Maximum four SSH connections')
    if (old) {
      this.cleanup(old)
      for (const [key, w] of this.workspaces) if (w.dto.profileId === p.id) this.workspaces.delete(key)
      for (const [key, s] of this.sessions) if (s.workspace.dto.profileId === p.id) this.sessions.delete(key)
    }
    // Transport setup can emit synchronously before assignment; keep this forward reference optional.
    // eslint-disable-next-line prefer-const
    let c: Connection
    const transport = this.deps.transport((event) => { if (c && this.connections.get(p.id) === c) this.transportEvent(c, event) })
    c = { profile: p, fingerprint: fingerprint(p), dto: { profileId: p.id, name: p.name, status: 'connecting' }, transport, generation: randomUUID(), terminalCreates: 0, earlyTerminal: [] }
    this.connections.set(p.id, c); this.publish()
    const generation = c.generation
    try {
      const command = await this.deps.bootstrap(p)
      if (c.generation !== generation) throw new Error('SSH connection cancelled')
      const pending = transport.connect(p, undefined, { password }, { hostMode: true, remoteCommand: command })
      password = undefined; req.data.password = undefined
      await pending
      if (c.generation !== generation) { transport.disconnect(); throw new Error('SSH connection cancelled') }
      if (c.dto.status === 'disconnected') throw new Error('SSH host disconnected during startup')
      const host = transport.getHostState()
      if (!host || typeof host.home !== 'string' || !host.capabilities) throw new Error('Invalid remote host metadata')
      c.dto = { ...c.dto, status: 'connected', home: host.home, nodeVersion: host.nodeVersion, capabilities: host.capabilities, error: undefined }
      for (const root of this.metadata.roots.filter((r) => r.profileId === p.id && r.fingerprint === c.fingerprint)) this.addWorkspace(c, root.path, root.name)
      if (req.data.activate) this.select(p.id)
      this.publish()
      return { connection: { ...c.dto }, snapshot: this.snapshot }
    } catch (e) {
      transport.disconnect(); c.dto.status = 'disconnected'
      c.dto.error = c.generation !== generation ? 'SSH connection cancelled' : p.authMethod === 'password' && !(e instanceof SshSafeConnectError) ? 'SSH authentication or host startup failed; verify credentials and remote Node.js.' : e instanceof Error ? e.message : 'SSH connection failed'
      this.publish(); throw new Error(c.dto.error)
    } finally { password = undefined; req.data.password = undefined }
  }
  select(id: string): { snapshot: RemoteCodeSnapshot } {
    this.connection(id)
    this.selected = id
    if (!this.selectedWorkspace || this.workspaces.get(this.selectedWorkspace)?.dto.profileId !== id) this.selectedWorkspace = [...this.workspaces.values()].find((w) => w.dto.profileId === id)?.dto.workspaceId
    this.publish(); return { snapshot: this.snapshot }
  }
  async browse(id: string, path?: string): Promise<HostDirectory> {
    const c = this.connection(id)
    if (path !== undefined) nativePath.parse(path)
    const generation = c.generation
    const directory = await c.transport.requestHost('browse', { path }) as HostDirectory
    this.assertConnection(c, generation)
    return directory
  }
  async prepareWorkspace(id: string, path: string): Promise<{ path: string; name: string; hostLabel: string; trustToken: string; alreadyTrusted: boolean }> {
    const c = this.connection(id)
    const directory = await this.browse(id, nativePath.parse(path))
    nativePath.parse(directory.path)
    const token = randomUUID()
    for (const [key, t] of this.tokens) if (t.expires < this.now()) this.tokens.delete(key)
    if (this.tokens.size > 100) throw new Error('Too many pending trust requests')
    this.tokens.set(token, { connection: c, original: path, canonical: directory.path, expires: this.now() + 5 * 60_000 })
    return { path: directory.path, name: posix.basename(directory.path) || '/', hostLabel: `${c.profile.user ? c.profile.user + '@' : ''}${c.profile.host}${c.profile.port ? ':' + c.profile.port : ''}`, trustToken: token, alreadyTrusted: this.trusted(c, directory.path) }
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private trusted(c: Connection, path: string): boolean { return this.metadata.roots.some((r) => r.profileId === c.profile.id && r.fingerprint === c.fingerprint && r.path === path) }
  async openWorkspace(id: string, path: string, trustToken?: string): Promise<{ workspace: RemoteCodeWorkspace; snapshot: RemoteCodeSnapshot }> {
    const c = this.connection(id), generation = c.generation
    const token = trustToken ? this.tokens.get(trustToken) : undefined
    if (trustToken) this.tokens.delete(trustToken)
    const dir = await this.browse(id, nativePath.parse(path))
    if (!this.trusted(c, dir.path)) {
      if (!token || token.connection !== c || token.expires <= this.now() || token.canonical !== dir.path || ![token.original, token.canonical].includes(path)) throw new Error('Remote workspace trust confirmation is required')
      // Re-resolve the ORIGINAL chooser path too, detecting symlink changes after preparation.
      if ((await this.browse(id, token.original)).path !== token.canonical) throw new Error('Remote workspace changed since trust confirmation; choose it again')
    }
    const host = await c.transport.requestHost('workspace.register', { path: dir.path, trusted: true }) as HostWorkspace
    this.assertConnection(c, generation)
    if (host.root !== dir.path) throw new Error('Remote workspace changed during registration; choose it again')
    const w = this.addWorkspace(c, host.root, host.name); w.host = host
    if (!this.trusted(c, host.root)) {
      const next: RemoteMetadata = { version: 1, roots: [...this.metadata.roots, { profileId: id, fingerprint: c.fingerprint, path: host.root, name: host.name }] }
      this.store.save(next); this.metadata = next
    }
    this.selected = id; this.selectedWorkspace = w.dto.workspaceId; this.publish()
    return { workspace: { ...w.dto }, snapshot: this.snapshot }
  }
  private addWorkspace(c: Connection, path: string, name: string): Workspace {
    const workspaceId = virtualWorkspacePath(c.profile.id, hash(c.fingerprint + '\0' + path).slice(0, 24), name)
    let w = this.workspaces.get(workspaceId)
    if (!w || w.connection !== c) {
      w = { connection: c, dto: { workspaceId, profileId: c.profile.id, targetId: `ssh:${c.profile.id}`, nativePath: path, name, hostLabel: `${c.profile.user ? c.profile.user + '@' : ''}${c.profile.host}${c.profile.port ? ':' + c.profile.port : ''}` } }
      this.workspaces.set(workspaceId, w)
    }
    return w
  }
  disconnect(id: string, force = false): { snapshot: RemoteCodeSnapshot } {
    const c = this.connection(id, false)
    const busy = [...this.runtimes.values()].some((r) => r.session.workspace.connection === c && (r.projection.active || r.pendingPrompts > 0 || r.acceptedWork))
    if (!force && (busy || c.transport.hasActiveWork || [...this.terminals.values()].some((t) => t.workspace.connection === c))) throw new Error('SSH host has active work or terminals; confirm force disconnect')
    c.generation = randomUUID(); c.transport.disconnect(); this.cleanup(c); c.dto.status = 'disconnected'; this.publish()
    // Keep remote selected: no silent fallback into a local worker.
    return { snapshot: this.snapshot }
  }
  private cleanup(c: Connection): void {
    c.earlyTerminal = []
    for (const [key, r] of this.runtimes) if (r.session.workspace.connection === c) { r.projection.exited(r.acceptedWork || r.pendingPrompts > 0); r.session.runtime = undefined; this.runtimes.delete(key) }
    for (const [id, t] of this.terminals) if (t.workspace.connection === c) { this.deps.emit('ipc:terminal-exit', { id, code: null }); this.terminals.delete(id) }
    for (const [id, d] of this.dialogs) if (d.runtime.session.workspace.connection === c) { this.deps.emit('ipc:extension-ui-dismiss', { id, reason: 'abort' }); this.dialogs.delete(id) }
    for (const [key, token] of this.tokens) if (token.connection === c) this.tokens.delete(key)
    for (const w of this.workspaces.values()) if (w.connection === c) { w.host = undefined; w.probe = undefined }
  }
  private transportEvent(c: Connection, event: SshWorkspaceEvent): void {
    if (event.kind === 'status' && event.status.phase === 'disconnected') {
      c.dto.status = 'disconnected'; c.dto.error = event.status.error; this.cleanup(c); this.publish()
    }
    if (event.kind !== 'record' || event.record.type !== 'host_event') return
    const e = event.record as HostEvent
    if (e.kind === 'terminal-data' || e.kind === 'terminal-exit') {
      const t = [...this.terminals.values()].find((t) => t.workspace.connection === c && t.nativeId === e.terminalId && t.workspace.host?.id === e.workspaceId)
      if (!t) {
        if (c.terminalCreates && c.earlyTerminal.length < 128 && JSON.stringify(c.earlyTerminal).length < 1024 * 1024) c.earlyTerminal.push(e)
        return
      }
      if (e.kind === 'terminal-data') this.deps.emit('ipc:terminal-data', { id: t.id, data: e.data })
      else { this.terminals.delete(t.id); this.deps.emit('ipc:terminal-exit', { id: t.id, code: e.code }) }
      return
    }
    const r = this.runtimes.get(c.generation + ':' + e.runtimeId)
    if (!r || r.session.workspace.host?.id !== e.workspaceId) return
    if (e.kind === 'session-exit') { r.projection.exited(r.acceptedWork || r.pendingPrompts > 0); r.session.runtime = undefined; if (r.session.workspace.probe === r) r.session.workspace.probe = undefined; this.runtimes.delete(c.generation + ':' + e.runtimeId); return }
    if (e.kind !== 'pi') return
    const eventData = isolatePaths(e.event, r.session.workspace.dto.nativePath, r.session.workspace.dto.workspaceId) as Record<string, unknown>
    if (eventData.type === 'extension_ui_request') {
      if (!['select', 'confirm', 'input', 'editor', 'notify', 'set_editor_text'].includes(String(eventData.method))) return
      const id = 'ssh-ui-' + randomUUID()
      if (['select', 'confirm', 'input', 'editor'].includes(String(eventData.method))) this.dialogs.set(id, { runtime: r, nativeId: String(e.event.id) })
      this.deps.emit('ipc:extension-ui-request', { ...eventData, id, sessionFile: r.session.key }); return
    }
    if (eventData.type === 'agent_settled') { r.acceptedWork = false; r.settleEpoch++ }
    if (eventData.type === 'thinking_level_changed' && typeof eventData.level === 'string') r.host.thinkingLevel = eventData.level
    r.projection.accept(eventData)
  }
  private assertConnection(c: Connection, generation: string): void {
    if (this.connections.get(c.profile.id) !== c || c.generation !== generation || c.dto.status !== 'connected') throw new Error('SSH connection changed; retry the operation explicitly')
  }
  private async ensureWorkspace(w: Workspace): Promise<HostWorkspace> {
    const c = this.connection(w.dto.profileId)
    if (w.connection !== c || !this.trusted(c, w.dto.nativePath)) throw new Error('Remote workspace must be trusted and opened again')
    if (!w.host) {
      const generation = c.generation
      const host = await c.transport.requestHost('workspace.register', { path: w.dto.nativePath, trusted: true }) as HostWorkspace
      this.assertConnection(c, generation)
      if (host.root !== w.dto.nativePath) throw new Error('Remote workspace canonical path changed; choose it again')
      w.host = host
    }
    return w.host
  }
  private async call(w: Workspace, op: HostOperation, args: Record<string, unknown> = {}): Promise<unknown> {
    const c = w.connection, generation = c.generation
    const host = await this.ensureWorkspace(w)
    this.assertConnection(c, generation)
    try {
      const result = await c.transport.requestHost(op, { ...args, workspaceId: host.id })
      this.assertConnection(c, generation)
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Remote operation failed'
      if (op === 'session.start' && message.includes('executable_not_found')) throw new Error('Pi was not found on this SSH host. Install Pi on the remote host or configure its Pi executable path, then retry. Nothing was installed automatically.')
      if (message === 'runtime_limit') throw new Error('This SSH host already has four live Pi runtimes. Finish active work and reconnect to release idle runtimes.')
      throw e
    }
  }
  private session(w: Workspace, native: string, sessionId: string): Session {
    if (!native || !native.startsWith('/')) throw new Error('Remote Pi did not provide a durable session file')
    // Bind the virtual capability to both the exact file and session identity. Replacing
    // a path with a different session must not retarget a stale context-menu selection.
    const key = `${w.dto.workspaceId}/.sessions/${hash(native + '\0' + sessionId)}.jsonl`
    let s = this.sessions.get(key)
    if (!s || s.workspace !== w) { s = { key, native, sessionId, workspace: w }; this.sessions.set(key, s) }
    s.sessionId = sessionId
    return s
  }
  private async runtime(w: Workspace, key?: string, fresh = false, utility = false, draft = false): Promise<Runtime> {
    let s = fresh || draft ? undefined : key ? this.sessions.get(key) : w.selectedSession ? this.sessions.get(w.selectedSession) : undefined
    if (key && (!s || s.workspace !== w)) throw new Error('Unknown remote session key; refresh the session list')
    if (s?.deleting) throw new Error('Session deletion is in progress')
    if (!fresh && s?.runtime) return s.runtime
    if (!fresh && s?.starting) return s.starting
    if (!fresh && !s && utility && w.probeStarting) return w.probeStarting
    if (!fresh && !s && !draft && w.starting) return w.starting
    if (!fresh && !s && utility && w.probe && !w.probe.session.deleting) return w.probe
    const probeStart = utility && !s && !key && !fresh
    const start = async () => {
      const c = w.connection, generation = c.generation
      const host = await this.call(w, 'session.start', { sessionFile: fresh ? undefined : s?.native, fresh, utility: utility && !s && !fresh, piPath: w.connection.profile.piPath === 'pi' ? undefined : w.connection.profile.piPath }) as HostSession
      this.assertConnection(c, generation)
      if (s && (host.sessionFile !== s.native || host.sessionId !== s.sessionId)) throw new Error('Remote session restore identity changed')
      s = this.session(w, host.sessionFile, host.sessionId)
      const runtime: Runtime = { host, session: s, pendingPrompts: 0, acceptedWork: host.isStreaming, settleEpoch: 0, projection: new RemoteProjection(() => ({ workspaceId: w.dto.workspaceId, sessionFile: runtime.session.key, sessionId: runtime.session.sessionId }), (e) => this.deps.emit('ipc:events', e)) }
      s.runtime = runtime; this.runtimes.set(w.connection.generation + ':' + host.runtimeId, runtime)
      if (probeStart) w.probe = runtime
      else if (!key && !draft) w.selectedSession = s.key
      if (host.isStreaming) runtime.projection.accept({ type: 'agent_start' })
      await this.hydrate(runtime)
      this.assertConnection(c, generation)
      this.deps.emit('ipc:events', { type: 'remote-settings-changed', key: 'sessions', workspaceId: w.dto.workspaceId })
      return runtime
    }
    const original = s
    w.starts = (w.starts || 0) + 1
    const pending = start()
    if (!key && !fresh && !draft) w.starting = pending
    if (probeStart) w.probeStarting = pending
    if (original && !fresh) original.starting = pending
    try { return await pending } finally {
      w.starts!--
      if (w.starting === pending) w.starting = undefined
      if (w.probeStarting === pending) w.probeStarting = undefined
      if (original?.starting === pending) original.starting = undefined
    }
  }
  /** Read only the exact remote runtime; never use the foreground/local worker's metrics. */
  private async hydrate(r: Runtime): Promise<Record<string, unknown>> {
    const epoch = r.hydrationEpoch = (r.hydrationEpoch || 0) + 1
    const session = r.session
    const state = await this.rpc(r, { type: 'get_state' })
    if (state.sessionId !== session.sessionId || state.sessionFile !== session.native) throw new Error('Remote session identity changed')
    const levels: Record<string, unknown> = await this.rpc(r, { type: 'get_available_thinking_levels' }).catch(() => ({}))
    const stats: Record<string, unknown> = await this.rpc(r, { type: 'get_session_stats' }).catch(() => ({}))
    const after = await this.rpc(r, { type: 'get_state' })
    if (after.sessionId !== session.sessionId || after.sessionFile !== session.native || JSON.stringify(after.model) !== JSON.stringify(state.model) || after.thinkingLevel !== state.thinkingLevel) throw new Error('Remote session state changed; retry')
    if (r.session !== session || session.runtime !== r || this.sessions.get(session.key) !== session || r.hydrationEpoch !== epoch) throw new Error('Remote session hydration superseded')
    this.captureState(r, after)
    const availableThinkingLevels = Array.isArray(levels.levels) ? levels.levels.filter((v): v is string => typeof v === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v)) : undefined
    const validStats = stats.sessionId === session.sessionId && stats.sessionFile === session.native
    const tokens = record(stats.tokens)
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
    const usage = validStats && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => finite(tokens[k])) && finite(stats.cost)
      ? { input: tokens.input as number, output: tokens.output as number, cacheRead: tokens.cacheRead as number, cacheWrite: tokens.cacheWrite as number, cost: stats.cost } : undefined
    const context = record(stats.contextUsage)
    const contextUsage = validStats && finite(context.contextWindow) && context.contextWindow > 0 && (context.tokens === null || finite(context.tokens))
      ? { tokens: context.tokens as number | null, contextWindow: context.contextWindow } : undefined
    r.details = { availableThinkingLevels, usage, contextUsage }
    r.projection.state(r.host.model, r.host.thinkingLevel, { availableThinkingLevels, usage })
    return { ...after, ...r.details }
  }
  private captureState(r: Runtime, state: Record<string, unknown>): void {
    const model = record(state.model)
    if (typeof state.model === 'string') r.host.model = state.model
    else if (model.provider && (model.id || model.modelId)) r.host.model = `${model.provider}/${model.id || model.modelId}`
    if (typeof state.thinkingLevel === 'string') r.host.thinkingLevel = state.thinkingLevel
  }
  private async rpc(r: Runtime, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (r.session.deleting) throw new Error('Session deletion is in progress')
    r.rpcCount = (r.rpcCount || 0) + 1
    try {
      const response = record(await this.call(r.session.workspace, 'session.rpc', { runtimeId: r.host.runtimeId, command }))
      if (response.success === false) throw new Error(String(response.error || 'Remote Pi command failed'))
      return record(response.data)
    } finally { r.rpcCount!-- }
  }
  private row(s: Session, title = ''): Record<string, unknown> {
    return { sessionId: s.sessionId, sessionFile: s.key, workspaceId: s.workspace.dto.workspaceId, title, createdAt: Date.now(), updatedAt: Date.now(), modelId: s.runtime?.host.model || '', status: s.runtime && (s.runtime.projection.active || s.runtime.acceptedWork || s.runtime.pendingPrompts > 0) ? 'busy' : 'idle' }
  }
  async shutdown(): Promise<void> {
    // End SSH stdin and kill transport without waiting on a stalled remote model.
    for (const c of this.connections.values()) { c.generation = randomUUID(); c.transport.disconnect(); this.cleanup(c); c.dto.status = 'disconnected' }
  }

  /** Invoked before all local handlers/schemas. Explicit LOCAL identities always stay local. */
  async route(channel: string, raw: unknown): Promise<{ handled: false } | { handled: true; value: unknown }> {
    const req = record(raw)
    const handled = (value: unknown) => ({ handled: true as const, value })
    const method = channel.replace(/^ipc:/, '')
    if (method === 'code.sessions.list') return empty // Metadata filters/search are not filesystem identities.
    const identities = ['workspaceId', 'workspaceRoot', 'cwd', 'sessionFile', 'sessionPath', 'filePath', 'root', 'directory'].map((k) => req[k]).filter((v) => typeof v === 'string' && v.length > 0) as string[]
    if (/^(workspace\.(open|ensureWorker)|project\.removeRecent|shell\.)/.test(method) && typeof req.path === 'string' && req.path.startsWith('/')) identities.push(req.path)
    if (isVirtualWorkspacePath(req.path) && !identities.includes(String(req.path))) identities.push(String(req.path))
    if (method === 'settings.set' && req.key === 'recentProjects' && Array.isArray(req.value) && req.value.some(isVirtualWorkspacePath)) throw new Error('Remote workspace paths must not be stored in local recent projects')
    if (method === 'settings.set' && req.key === 'currentProject' && isVirtualWorkspacePath(req.value)) identities.push(String(req.value))
    const virtual = identities.filter(isVirtualWorkspacePath)
    if (reservedRemotePaths(req).some((p) => !identities.includes(p))) throw new Error('Nested or unsupported remote path identity; nothing was executed locally')
    const terminalId = typeof req.id === 'string' && req.id.startsWith('ssh-term-') ? req.id : undefined
    const dialogId = typeof req.id === 'string' && req.id.startsWith('ssh-ui-') ? req.id : undefined
    if ((method === 'extension.respondUI' || method === 'extension.cancelUI') && typeof req.id === 'string' && !dialogId && !virtual.length) return empty
    if (virtual.length && identities.some((v) => !isVirtualWorkspacePath(v))) throw new Error('Mixed local and remote identities are not allowed')
    if (!virtual.length && identities.length && !terminalId && !dialogId) return empty
    if (method === 'model.list' && req.scope === 'settings' && !virtual.length) return empty
    if (method === 'settings.get' && this.selected) {
      const recentProjects = this.snapshot.workspaces.map((w) => w.workspaceId)
      const currentProject = this.selectedWorkspace || null
      if (req.key === 'recentProjects' || req.key === 'currentProject') return handled({ settings: { [req.key]: req.key === 'recentProjects' ? recentProjects : currentProject } })
      if (!req.key) return handled({ settings: { ...this.deps.localSettings(), recentProjects, currentProject } })
      return empty
    }
    if (method === 'settings.set' && !(req.key === 'currentProject' && virtual.length)) return empty
    // Global configuration stays local, but explicit virtual namespaces never pass through.
    // Remote quota must be authorized below against an exact existing session, never local auth.
    if (method === 'code.sessions.prepareOpen') return empty // Strict metadata-catalog handler owns this explicit virtual identity.
    const codeMethod = /^(workspace\.|session\.|prompt\.|runtime\.|model\.(list|set|cycle)$|thinkingLevel\.|commands\.|review\.|git\.|terminal\.|shell\.|browser\.|resource\.|resources\.|rewind\.|background\.|extension\.(respondUI|cancelUI|config\.)|context\.|providerUsage\.get$|rightPanels\.|clipboard\.|desktop\.gitWorktrees$|project\.removeRecent$|settings\.set$|slash\.(resolve|normalize)$)/.test(method)
    if (!virtual.length && !terminalId && !dialogId && (!this.selected || !codeMethod)) return empty
    if (!codeMethod && !virtual.length) return empty
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid remote Code request')
    if (method === 'extension.respondUI' || method === 'extension.cancelUI') {
      if (!dialogId) { if (this.selected || virtual.length) throw new Error('Remote extension dialog ID required'); return empty }
      const dialog = this.dialogs.get(dialogId)
      if (!dialog) throw new Error('Remote extension dialog expired')
      for (const identity of identities) if ((this.workspaces.get(identity) || this.sessions.get(identity)?.workspace) !== dialog.runtime.session.workspace) throw new Error('Remote extension dialog workspace mismatch')
      const response = z.object({ value: z.string().max(100000).optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().optional() }).parse(req)
      this.dialogs.delete(dialogId)
      await this.rpc(dialog.runtime, { ...response, type: 'extension_ui_response', id: dialog.nativeId, ...(method === 'extension.cancelUI' ? { cancelled: true } : {}) })
      return handled({ ok: true })
    }
    if (method.startsWith('terminal.') && req.id) {
      if (!terminalId) { if (virtual.length || this.selected) throw new Error('Remote terminal ID required'); return empty }
      const t = this.terminals.get(terminalId)
      if (!t) throw new Error('Remote terminal is closed or unknown')
      for (const identity of identities) if ((this.workspaces.get(identity) || this.sessions.get(identity)?.workspace) !== t.workspace) throw new Error('Remote terminal workspace mismatch')
      if (method === 'terminal.kill') { await this.call(t.workspace, 'terminal.kill', { id: t.nativeId }); this.terminals.delete(terminalId); return handled({ ok: true }) }
      if (method === 'terminal.resize') {
        const size = z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).parse(req)
        await this.call(t.workspace, 'terminal.resize', { id: t.nativeId, ...size }); return handled({ ok: true })
      }
      throw new Error('Unsupported remote terminal method')
    }
    let w: Workspace | undefined
    for (const key of virtual) {
      const filePath = ['shell.readImagePreview', 'shell.openPath', 'shell.showItemInFolder'].includes(method) || method.startsWith('workspace.fs.')
      const candidate = this.workspaces.get(key) || this.sessions.get(key)?.workspace || (filePath ? [...this.workspaces.values()].find((ws) => key.startsWith(ws.dto.workspaceId + '/') && !key.slice(ws.dto.workspaceId.length + 1).split('/').includes('..')) : undefined)
      if (!candidate) throw new Error('Unknown reserved SSH workspace or session key')
      if (w && w !== candidate) throw new Error('Remote workspace identity mismatch')
      w = candidate
    }
    w ||= this.selectedWorkspace ? this.workspaces.get(this.selectedWorkspace) : undefined
    if (method === 'rightPanels.catalog' || method === 'rightPanels.saveLayout') {
      // Shared UI preferences only: never probe local adapters/SDK against a remote virtual path.
      const catalog = mergeRightPanelCatalog([]).filter((item) => item.id !== 'browser')
      const settings = this.deps.localSettings()
      const prefs = normalizeRightPanelPrefs(method.endsWith('saveLayout') ? req.prefs : settings.rightPanelPrefs, catalog)
      const order = normalizeRightPanelOrder(method.endsWith('saveLayout') ? req.order : settings.rightPanelOrder, catalog)
      if (method.endsWith('saveLayout')) {
        if (!this.deps.saveRightPanelLayout) throw new Error('Saving shared panel layout is unavailable')
        const preserved = Object.fromEntries(Object.entries(record(settings.rightPanelPrefs)).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
        const localOrder = Array.isArray(settings.rightPanelOrder) ? settings.rightPanelOrder.filter((id): id is string => typeof id === 'string') : []
        this.deps.saveRightPanelLayout({ ...preserved, ...prefs }, [...new Set([...order, ...localOrder])])
        return handled({ ok: true, prefs, order })
      }
      return handled({ catalog, adapterPanels: [], prefs, order, defaultPrefs: defaultRightPanelPrefsForCatalog(catalog, []) })
    }
    if (!w) {
      if (method === 'providerUsage.get') return handled(unavailableUsage('session-unavailable'))
      if (method === 'session.list') return handled({ sessions: [] })
      if (method === 'runtime.getState') return handled({ state: null })
      if (method === 'commands.list') return handled({ commands: [], source: 'fallback' })
      if (method === 'commands.completions') return handled({ items: [] })
      if (method === 'model.list') return handled({ models: [] })
      if (method === 'terminal.profiles') return handled({ profiles: [] })
      throw new Error('Select and trust a remote workspace before using Code')
    }
    const key = typeof req.sessionFile === 'string' && req.sessionFile ? req.sessionFile : undefined
    const draft = z.boolean().optional().parse(req.draft) === true
    if (draft && (key || req.workspaceId !== w.dto.workspaceId || !['runtime.getState', 'model.set', 'thinkingLevel.set'].includes(method))) throw new Error('Draft metadata requires an exact remote workspace and no history file')
    if (key && !this.sessions.has(key)) throw new Error('Unknown remote session key; refresh the session list')
    if (method === 'settings.set') { this.connection(w.dto.profileId); this.selected = w.dto.profileId; this.selectedWorkspace = w.dto.workspaceId; this.publish(); return handled({ key: 'currentProject', value: w.dto.workspaceId }) }
    if (method === 'workspace.open' || method === 'workspace.switch' || method === 'workspace.ensureWorker') {
      if (!virtual.length) throw new Error('Remote workspace requires a server-issued virtual path')
      z.boolean().optional().parse(req.awaitWorker)
      await this.ensureWorkspace(w)
      this.selected = w.dto.profileId; this.selectedWorkspace = w.dto.workspaceId; this.publish()
      const r = req.awaitWorker === true || method !== 'workspace.open' ? await this.runtime(w, undefined, false, true) : undefined
      return handled({ ok: true, workspaceId: w.dto.workspaceId, path: w.dto.workspaceId, name: w.dto.name, sessionId: r?.session.sessionId, model: r?.host.model })
    }
    if (method === 'session.list') {
      const revision = this.catalogRevision
      const data = record(await this.call(w, 'session.list'))
      if (revision !== this.catalogRevision) return this.route(channel, raw)
      return handled({ sessions: (Array.isArray(data.sessions) ? data.sessions : []).map((value) => {
        const row = record(value); const s = this.session(w!, String(row.sessionFile || ''), String(row.sessionId || ''))
        return { ...this.row(s, String(row.title || '')), createdAt: row.createdAt, updatedAt: row.updatedAt, modelId: typeof row.modelId === 'string' ? row.modelId : '', messageCount: typeof row.messageCount === 'number' ? row.messageCount : 0, firstMessage: typeof row.firstMessage === 'string' ? row.firstMessage : '' }
      }) })
    }
    if (method === 'session.delete') {
      // No selected-target inference for a destructive operation, and never dial to delete.
      if (!key || req.workspaceId !== w.dto.workspaceId) throw new Error('Exact remote session and workspace identities are required')
      const s = this.sessions.get(key)!
      const location = this.sessionCatalogLocations.find((entry) => entry.workspaceId === w.dto.workspaceId)
      if (!location || location.disconnected) throw new Error('Connect to this SSH host before deleting its session')
      const r = s.runtime
      if (s.deleting || s.starting || w.starts || (r && (r.projection.active || r.acceptedWork || r.pendingPrompts || r.rpcCount))) throw new Error('Session is busy; wait for its work to finish before deleting')
      s.deleting = true
      let deleted = false
      try {
        const result = record(await this.call(w, 'session.delete', { sessionFile: s.native, sessionId: s.sessionId }))
        if (result.ok !== true) throw new Error(String(result.error || 'Remote session was not deleted'))
        if (r) {
          r.projection.exited(false)
          this.runtimes.delete(w.connection.generation + ':' + r.host.runtimeId)
          for (const [id, dialog] of this.dialogs) if (dialog.runtime === r) { this.dialogs.delete(id); this.deps.emit('ipc:extension-ui-dismiss', { id, reason: 'abort' }) }
        }
        if (w.selectedSession === key) w.selectedSession = undefined
        if (w.probe === r) w.probe = undefined
        s.runtime = undefined
        this.sessions.delete(key)
        deleted = true
        ++this.catalogRevision
        this.catalogCache.set(w.dto.workspaceId, (this.catalogCache.get(w.dto.workspaceId) || []).filter((entry) => entry.key !== key))
        this.deps.emit('ipc:events', { type: 'remote-settings-changed', key: 'sessions', workspaceId: w.dto.workspaceId })
        return handled({ ok: true })
      } finally { if (!deleted) s.deleting = false }
    }
    if (key && this.sessions.get(key)?.deleting) throw new Error('Session deletion is in progress')
    if (method === 'session.setVisible') return handled({ ok: true })
    if (method === 'session.setPendingBind' || method === 'session.prepare' || method === 'session.open') {
      // Clearing a pending bind is not clearing the already-current runtime (local semantics).
      if (key && req.bind !== false) {
        await this.call(w, 'session.adopt', { sessionFile: this.sessions.get(key)!.native })
        if (!this.sessions.has(key) || this.sessions.get(key)?.deleting) throw new Error('Session changed while opening')
        w.selectedSession = key
        if (w.probe?.session.key === key) w.probe = undefined
      }
      const s = key ? this.sessions.get(key) : undefined
      if (method === 'session.prepare') return handled({ bound: false, sessionId: s?.sessionId || null, sessionFile: key, workspaceId: w.dto.workspaceId })
      if (method === 'session.open') return handled({ session: s ? this.row(s) : { sessionId: req.sessionId, workspaceId: w.dto.workspaceId } })
      return handled({ ok: true })
    }
    if (method === 'session.setEphemeralDraft') { z.boolean().parse(req.active); if (req.active) w.selectedSession = undefined; return handled({ ok: true }) }
    if (method === 'session.new') { const r = await this.runtime(w, undefined, true); return handled({ session: this.row(r.session, 'New session') }) }
    if (method === 'providerUsage.get') {
      if (!key) return handled(unavailableUsage('session-unavailable'))
      z.boolean().optional().parse(req.force)
      let expired = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const query = (async () => {
          // Restore THIS history only. No utility/default session or visible conversation is created.
          const r = await this.runtime(w!, key)
          if (expired) return unavailableUsage('timeout') // No late quota query after startup timed out.
          return this.rpc(r, { type: 'desktop_provider_usage' })
        })()
        return handled(await Promise.race([query, new Promise((resolve) => {
          timer = setTimeout(() => { expired = true; resolve(unavailableUsage('timeout', 'error')) }, 8000)
        })]))
      } catch { return handled(unavailableUsage('runtime-unavailable')) }
      finally { if (timer) clearTimeout(timer) }
    }
    if (method === 'runtime.getState') {
      if (draft) {
        const probe = w.probe
        if (!probe || probe.session.deleting) return handled({ state: null })
        const state = await this.hydrate(probe)
        return handled({ state: { bound: false, sessionFile: null, sessionId: null, cwd: w.dto.workspaceId, model: probe.host.model, thinkingLevel: probe.host.thinkingLevel, availableThinkingLevels: state.availableThinkingLevels } })
      }
      const s = key ? this.sessions.get(key) : w.selectedSession ? this.sessions.get(w.selectedSession) : undefined
      if (!s) return handled({ state: null })
      const r = await this.runtime(w, s.key)
      const state = await this.hydrate(r)
      return handled({ state: { ...isolatePaths(state, w.dto.nativePath, w.dto.workspaceId) as object, model: r.host.model, thinkingLevel: r.host.thinkingLevel, isStreaming: r.projection.active || r.acceptedWork || r.pendingPrompts > 0 || state.isStreaming === true, cwd: w.dto.workspaceId, sessionFile: s.key, sessionId: s.sessionId } })
    }
    if (method === 'context.preview') {
      if (!key) return handled({ preview: null })
      const r = await this.runtime(w, key)
      const state = await this.hydrate(r)
      const session = r.session, epoch = r.hydrationEpoch, model = r.host.model
      const data = await this.rpc(r, { type: 'get_messages' })
      if (r.session !== session || r.hydrationEpoch !== epoch || r.host.model !== model) throw new Error('Remote context changed; retry')
      const preview = buildSessionContextPreview({ sessionFile: key, sessionId: session.sessionId, messages: Array.isArray(data.messages) ? data.messages : [] })
      return handled({ preview: { ...isolatePaths(preview, w.dto.nativePath, w.dto.workspaceId) as object, sessionFile: key, remoteContext: { model, contextUsage: state.contextUsage, usage: state.usage } } })
    }
    const fsOps: Record<string, HostOperation> = { 'workspace.fs.listDir': 'fs.list', 'workspace.fs.search': 'fs.search', 'workspace.fs.readText': 'fs.read', 'workspace.fs.rename': 'fs.rename', 'workspace.fs.create': 'fs.create', 'shell.readImagePreview': 'fs.image' }
    if (fsOps[method]) {
      const schema = z.object({ path: nativePath.optional(), relativePath: nativePath.optional(), query: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).optional(), maxBytes: z.number().int().min(1).max(1024 * 1024).optional(), includeDotfiles: z.boolean().optional(), newName: z.string().min(1).max(255).optional(), isDirectory: z.boolean().optional() })
      const args = schema.parse(req)
      if (method.endsWith('search')) z.string().max(512).parse(args.query)
      if (method.includes('readText') || method === 'shell.readImagePreview') nativePath.parse(args.path)
      if (method.endsWith('rename') || method.endsWith('create')) nativePath.parse(args.relativePath)
      for (const field of ['path', 'relativePath'] as const) if (args[field] !== undefined) {
        const p = args[field]!
        if (isVirtualWorkspacePath(p)) {
          if (!p.startsWith(w.dto.workspaceId + '/')) throw new Error('Remote file workspace mismatch')
          args[field] = p.slice(w.dto.workspaceId.length + 1)
        } else if (posix.isAbsolute(p)) throw new Error('Native absolute file paths are not accepted; use workspace-relative paths')
        if (args[field]!.split('/').includes('..') || args[field]!.startsWith('.outside/')) throw new Error('File path is outside remote workspace')
      }
      if (method.endsWith('rename')) z.string().min(1).regex(/^[^/\\\0]+$/).parse(args.newName)
      return handled(await this.call(w, fsOps[method], args))
    }
    if (method === 'review.getDiff' || method === 'git.branchStatus') {
      const data = record(await this.call(w, 'git.status'))
      return handled(method === 'review.getDiff' ? { diff: { ...record(data.snapshot), scope: req.scope || 'git' } } : data.branchStatus)
    }
    if (method === 'git.branches') {
      const data = record(await this.call(w, 'git.branches'))
      return handled({ branches: (Array.isArray(data.branches) ? data.branches : []).map((b) => ({ ...record(b), worktree: record(b).worktree ? `${w.dto.workspaceId}/.outside/${encodeURIComponent(String(record(b).worktree))}` : null })) })
    }
    if (method === 'desktop.gitWorktrees') {
      const data = record(await this.call(w, 'git.worktrees'))
      // Worktrees outside the approved root are display-only remote namespaces, not local paths.
      const trees = (Array.isArray(data.trees) ? data.trees : []).map((t) => isolatePaths(t, w.dto.nativePath, w.dto.workspaceId))
      return handled({ ...data, repositoryPath: data.repositoryPath ? w.dto.workspaceId : null, trees })
    }
    if (method === 'git.switchBranch') {
      const args = z.object({ name: z.string().min(1).max(250), remote: z.boolean().optional(), create: z.boolean().optional(), stash: z.boolean().optional() }).parse(req)
      const result = await this.call(w, 'git.switch', args); this.deps.emit('ipc:git-workspace-changed', { cwd: w.dto.workspaceId }); return handled(result)
    }
    if (method === 'review.stageHunks' || method === 'review.unstageHunks') {
      const files = z.array(z.object({ path: z.string().min(1).max(4096), hunkPatches: z.array(z.string().max(1024 * 1024)).max(500) })).max(500).parse(req.files || [])
      const result = await this.call(w, method === 'review.stageHunks' ? 'git.stage' : 'git.unstage', { files }); this.deps.emit('ipc:git-workspace-changed', { cwd: w.dto.workspaceId }); return handled(result)
    }
    if (method === 'terminal.profiles') return handled(await this.call(w, 'terminal.profiles'))
    if (method === 'terminal.create') {
      if (req.profileId !== undefined && req.profileId !== 'remote-default') throw new Error('Choose the remote shell profile for this SSH workspace')
      const args = z.object({ cols: z.number().int().min(1).max(1000).default(80), rows: z.number().int().min(1).max(1000).default(24) }).parse(req)
      const c = w.connection, generation = c.generation; c.terminalCreates++
      try {
        const data = record(await this.call(w, 'terminal.create', args))
        this.assertConnection(c, generation)
        if (typeof data.id !== 'string' || !data.id) throw new Error('Invalid remote terminal reply')
        const id = 'ssh-term-' + randomUUID(); this.terminals.set(id, { id, nativeId: data.id, workspace: w, pendingData: '', writing: false })
        // Register the issued client ID before replaying output emitted during helper PTY startup.
        const early = c.earlyTerminal; c.earlyTerminal = []
        for (const event of early) this.transportEvent(c, { kind: 'record', record: event })
        return handled({ ...data, ok: true, id })
      } finally { c.terminalCreates--; if (!c.terminalCreates) c.earlyTerminal = [] }
    }
    if (method === 'commands.completions') return handled({ items: [] })
    if (method === 'slash.normalize') return handled({ text: z.string().max(200000).parse(req.text).trim() })
    if (method === 'slash.resolve') return handled({ behavior: 'passthrough', meta: null })
    const rpcMethods = ['prompt.send', 'prompt.steer', 'prompt.followUp', 'prompt.abort', 'prompt.dequeueClearQueue', 'session.getMessages', 'session.tree', 'session.compact', 'session.rename', 'session.fork', 'session.reloadFromDisk', 'model.list', 'model.set', 'model.cycle', 'thinkingLevel.set', 'commands.list']
    if (!rpcMethods.includes(method)) throw new Error(`Remote Code does not support ${method}; nothing was executed locally`)
    // Validate BEFORE starting Pi.
    if (method.startsWith('prompt.') && ['prompt.send', 'prompt.steer', 'prompt.followUp'].includes(method)) {
      z.string().min(1).max(200000).parse(req.text)
      if (Array.isArray(req.capabilities) && req.capabilities.length) throw new Error('Desktop capabilities are not available over SSH; use remote Pi tools and extensions')
    }
    if (method === 'thinkingLevel.set') z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).parse(req.level)
    if (method === 'model.set') {
      const modelId = z.string().min(1).max(300).parse(req.modelId)
      z.string().min(1).max(200).parse(req.provider || (modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : undefined))
    }
    if (method === 'session.getMessages') {
      z.number().int().min(0).optional().parse(req.offset)
      z.number().int().min(1).max(500).optional().parse(req.limit)
      z.string().min(1).max(300).nullable().optional().parse(req.leafId)
    }
    if (method === 'session.compact') z.string().max(200000).optional().parse(req.customInstructions)
    if (method === 'session.rename') z.string().trim().min(1).max(500).parse(req.title)
    if (method === 'session.fork') {
      z.string().min(1).max(300).parse(req.entryId || req.fromMessageId)
      if (req.position !== undefined && req.position !== 'before') throw new Error('Remote Pi RPC supports fork-before only; arbitrary fork-at is not available')
    }
    if (method === 'session.reloadFromDisk') {
      const session = key ? this.sessions.get(key) : undefined
      if (!session) throw new Error('Remote session key required')
      if (session.runtime && (session.runtime.projection.active || session.runtime.pendingPrompts > 0 || session.runtime.acceptedWork)) throw new Error('Cannot reload a running remote session')
      if (session.runtime) { const old = session.runtime; await this.call(w, 'session.close', { runtimeId: old.host.runtimeId }); this.runtimes.delete(w.connection.generation + ':' + old.host.runtimeId); session.runtime = undefined }
      await this.runtime(w, key); return handled({ ok: true, sessionFile: key })
    }
    // Background hydration with no exact history must not materialize or adopt a session.
    if (!key && !w.selectedSession && (method === 'session.getMessages' || method === 'session.tree')) return handled(method === 'session.tree' ? { nodes: [], leafId: null } : { items: [], total: 0, offset: 0, limit: req.limit || 100, hasMore: false })
    const r = await this.runtime(w, key, false, ['model.list', 'commands.list', 'model.set', 'model.cycle', 'thinkingLevel.set'].includes(method), draft)
    if (method === 'prompt.send' || method === 'prompt.steer' || method === 'prompt.followUp') {
      if (w.probe === r) w.probe = undefined
      const type = method === 'prompt.send' ? 'prompt' : method === 'prompt.steer' ? 'steer' : 'follow_up'
      const epoch = r.settleEpoch; r.pendingPrompts++
      try {
        const ack = await this.rpc(r, { type, message: req.text })
        // ACK is acceptance, not completion. Retain a lock even if agent_start arrives later.
        // Conversely a fast agent_settled before the ACK must not be relocked by the late ACK.
        if (ack.disposition !== 'handled' && r.settleEpoch === epoch) r.acceptedWork = true
      } finally { r.pendingPrompts-- }
      return handled({ ...(type === 'steer' ? { steered: true } : { messageId: randomUUID() }), model: r.host.model, thinkingLevel: r.host.thinkingLevel })
    }
    if (method === 'prompt.abort') { r.projection.cancelRequested(); await this.rpc(r, { type: 'abort' }); return handled({ aborted: true }) }
    if (method === 'prompt.dequeueClearQueue') {
      const data = await this.rpc(r, { type: 'clear_queue' })
      const all = [...(Array.isArray(data.steering) ? data.steering : []), ...(Array.isArray(data.followUp) ? data.followUp : [])]
      if (req.abort === true) { r.projection.cancelRequested(); await this.rpc(r, { type: 'abort' }) }
      return handled({ restoredCount: all.length, combinedText: [...all, typeof req.currentText === 'string' ? req.currentText.trim() : ''].filter(Boolean).join('\n') })
    }
    if (method === 'session.getMessages') {
      const offset = z.number().int().min(0).default(0).parse(req.offset)
      const limit = z.number().int().min(1).max(500).optional().parse(req.limit)
      const data = await this.rpc(r, { type: 'get_tree' })
      const entries = new Map<string, Record<string, unknown>>()
      const stack = (Array.isArray(data.tree) ? data.tree : []).slice()
      while (stack.length && entries.size < 20000) {
        const node = record(stack.pop()); const entry = record(node.entry)
        if (typeof entry.id === 'string') entries.set(entry.id, entry)
        if (Array.isArray(node.children)) stack.push(...node.children)
      }
      let leaf: unknown = req.leafId === undefined ? data.leafId : req.leafId
      const branch: Record<string, unknown>[] = []; const seen = new Set<string>()
      while (typeof leaf === 'string' && !seen.has(leaf)) {
        const entry = entries.get(leaf)
        if (!entry) throw new Error('Requested remote session leaf is unavailable')
        seen.add(leaf); branch.push(entry); leaf = entry.parentId
      }
      const items = timelineItemsFromBranchPath(isolatePaths(branch.reverse(), w.dto.nativePath, w.dto.workspaceId) as unknown[])
      const page = items.slice(offset, limit ? offset + limit : undefined)
      return handled({ items: page, sourceCount: page.length, totalCount: items.length })
    }
    if (method === 'session.tree') {
      const data = await this.rpc(r, { type: 'get_tree' })
      const stack = (Array.isArray(data.tree) ? data.tree : []).map((node) => ({ node: record(node), depth: 0 })).reverse()
      const nodes: Record<string, unknown>[] = []
      while (stack.length && nodes.length < 4000) {
        const { node, depth } = stack.pop()!; const entry = record(node.entry); const message = record(entry.message)
        nodes.push({ id: entry.id, parentId: entry.parentId ?? null, depth, label: node.label, entryType: entry.type, timestamp: entry.timestamp, isLeaf: entry.id === data.leafId, role: message.role, preview: entry.type === 'message' ? sessionTreePreview(message, 96) : undefined })
        for (const child of (Array.isArray(node.children) ? node.children : []).slice().reverse()) stack.push({ node: record(child), depth: depth + 1 })
      }
      return handled({ nodes, leafId: data.leafId ?? null, workerBound: true })
    }
    if (method === 'session.rename') { await this.rpc(r, { type: 'set_session_name', name: req.title }); return handled({ ok: true, title: req.title }) }
    if (method === 'session.compact') { const data = await this.rpc(r, { type: 'compact', customInstructions: z.string().max(200000).optional().parse(req.customInstructions) }); return handled({ ...data, sessionId: r.session.sessionId, compacted: true, tokensSaved: Number(data.tokensBefore || 0) - Number(data.estimatedTokensAfter || 0) }) }
    if (method === 'session.fork') {
      const result = await this.rpc(r, { type: 'fork', entryId: req.entryId || req.fromMessageId })
      if (result.cancelled) return handled(result)
      const state = await this.rpc(r, { type: 'get_state' }); const s = this.session(w, String(state.sessionFile || ''), String(state.sessionId || ''))
      r.session.runtime = undefined; r.session = s; s.runtime = r; w.selectedSession = s.key
      return handled({ cancelled: false, editorText: result.text, sessionId: s.sessionId, sessionFile: s.key, workspaceId: w.dto.workspaceId, session: this.row(s, String(req.title || 'Fork')) })
    }
    if (method === 'model.list') {
      const data = await this.rpc(r, { type: 'get_available_models' })
      return handled({ models: (Array.isArray(data.models) ? data.models : []).map((m) => { const model = record(m); return { id: model.id, name: model.name || model.id, provider: model.provider, contextWindow: model.contextWindow, maxOutput: model.maxTokens, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap, available: true } }) })
    }
    if (method === 'model.set' || method === 'model.cycle') {
      let modelId = String(req.modelId || ''); let provider = typeof req.provider === 'string' ? req.provider : ''
      if (!provider && modelId.includes('/')) { const i = modelId.indexOf('/'); provider = modelId.slice(0, i); modelId = modelId.slice(i + 1) }
      if (method === 'model.set' && !provider) throw new Error('Remote model provider is required')
      const data = await this.rpc(r, method === 'model.set' ? { type: 'set_model', provider, modelId } : { type: 'cycle_model' })
      void data
      await this.hydrate(r)
      return handled({ modelId: r.host.model || '', thinkingLevel: r.host.thinkingLevel, availableThinkingLevels: r.details?.availableThinkingLevels })
    }
    if (method === 'thinkingLevel.set') {
      await this.rpc(r, { type: 'set_thinking_level', level: req.level })
      await this.hydrate(r) // Pi clamps; its ACK carries no effective level.
      return handled({ level: r.host.thinkingLevel })
    }
    const data = await this.rpc(r, { type: 'get_commands' })
    return handled({ commands: (Array.isArray(data.commands) ? data.commands : []).map((c) => { const cmd = record(c); return { name: cmd.name, description: cmd.description, category: cmd.source } }), source: 'worker' })
  }
}
