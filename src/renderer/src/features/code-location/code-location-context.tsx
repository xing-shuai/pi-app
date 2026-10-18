import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SshAuthCapabilities, SshProfile } from '@shared/ssh-workspace'
import type { RemoteCodeSnapshot, RemoteCodeWorkspace } from '@shared/remote-code'
import type { HostDirectory } from '@shared/ssh-host-types'
import type { SessionCatalogEntry, SessionCatalogResult } from '@shared/session-catalog-types'
import type { LocalFolderBrowseResult, LocalFolderResolveResult } from '@shared/local-folder-types'
import { useUIStore } from '@renderer/stores/ui-store'
import { beginSessionNavigation } from '@renderer/lib/session-navigation'
import { rememberRemoteWorkspacePaths } from '@renderer/lib/remote-code-paths'
import { reportVisibleSession } from '@renderer/lib/visible-session-report'
import { resetAvailableModelsForEnvironment } from '@renderer/lib/available-models-cache'
import { CodeLocationModal } from './code-location-modal'
import { resetBlankSessionProjection, enterBlankSession } from '@renderer/lib/blank-session-transition'
import { SshPasswordDialog } from '@renderer/features/ssh/ssh-password-dialog'
import { sshErrorMessage } from '@renderer/features/ssh/ssh-error'
import { SshConnectionDialog } from './ssh-connection-dialog'
import { RemoteFolderDialog } from './remote-folder-dialog'
import { LocalFolderDialog } from './local-folder-dialog'
import { TrustWorkspaceDialog } from './trust-workspace-dialog'
import './code-location.css'

const cancelled = () => new Error('Location selection cancelled')
async function invoke<T>(method: string, request: unknown = {}): Promise<T> {
  if (!window.piDesktop) throw new Error('Code execution locations require the desktop app')
  try { return await window.piDesktop.invoke(`ipc:${method}`, request) as T } catch (error) { throw new Error(sshErrorMessage(error)) }
}
const emptySnapshot: RemoteCodeSnapshot = { targetId: 'local', connections: [], workspaces: [] }
type FolderRequest = { profileId: string; path: string; label: string; allowNoProject: boolean; resolve: (path?: string) => void }
type LocalFolderRequest = { id: number; initialPath?: string; generation: number; resolve: (path?: string) => void }
type TrustRequest = { path: string; hostLabel?: string; remoteHome?: boolean; resolve: (trusted: boolean) => void }
type PasswordRequest = { profile: SshProfile; resolve: (password: string) => void; reject: (error: Error) => void }
type ContextValue = {
  ready: boolean; busy: boolean; error: string; clearError: () => void
  snapshot: RemoteCodeSnapshot; profiles: SshProfile[]; selectedProfile?: SshProfile
  workspace?: RemoteCodeWorkspace; locked: boolean; noProject: boolean
  chooseNoProject: () => Promise<void>
  selectLocalFolder: (initialPath?: string) => Promise<string | undefined>
  chooseLocal: () => Promise<void>; chooseSsh: (profileId: string) => Promise<void>; chooseFolder: () => Promise<void>; chooseWorkspace: (workspaceId: string) => Promise<void>
  openUnifiedSession: (entry: SessionCatalogEntry) => Promise<void>
  addConnection: () => void; editConnection: (profileId: string) => void; disconnect: (profileId: string) => Promise<void>
}
const LocationContext = createContext<ContextValue | null>(null)
export function useCodeLocation(): ContextValue { const value = useContext(LocationContext); if (!value) throw new Error('Missing CodeLocationProvider'); return value }
function isRemote(path: string | null | undefined): boolean { return !!path?.replace(/\\/g, '/').match(/^\/__pi_ssh__(?:\/|$)/) }

export function CodeLocationProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [snapshot, setSnapshot] = useState<RemoteCodeSnapshot>(emptySnapshot)
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [capabilities, setCapabilities] = useState<SshAuthCapabilities>({ password: false })
  const [pendingProfile, setPendingProfile] = useState<string | null>(null)
  const [selectionIntent, setSelectionIntent] = useState<string | null>(null)
  const [busyCount, setBusyCount] = useState(0)
  const activeOperations = useRef(new Set<symbol>())
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<{ initial?: SshProfile; version: number } | null>(null)
  const [folder, setFolder] = useState<FolderRequest | null>(null)
  const [localFolder, setLocalFolder] = useState<LocalFolderRequest | null>(null)
  const [trust, setTrust] = useState<TrustRequest | null>(null)
  const [password, setPassword] = useState<PasswordRequest | null>(null)
  const passwordRef = useRef<PasswordRequest | null>(null)
  const folderRef = useRef<FolderRequest | null>(null)
  const localFolderRef = useRef<LocalFolderRequest | null>(null)
  const trustRef = useRef<TrustRequest | null>(null)
  const generation = useRef(0)
  const localFolderVersion = useRef(0)
  const mounted = useRef(true)
  const editorVersion = useRef(0)
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
  const profilesRef = useRef(profiles); profilesRef.current = profiles
  const pendingRef = useRef(pendingProfile); pendingRef.current = pendingProfile
  const intentRef = useRef(selectionIntent); intentRef.current = selectionIntent
  const connectedProfiles = useRef(new Map<string, SshProfile>())
  // UI-only mode, keyed by main's exact host/fingerprint/canonical-root identity.
  // Trust remains main-owned; no virtual path is persisted into local project settings.
  const [remoteHomeWorkspaceIds, setRemoteHomeWorkspaceIds] = useState<ReadonlySet<string>>(new Set())
  const currentWorkspace = useUIStore((state) => state.currentWorkspace)
  const ephemeralDraft = useUIStore((state) => state.ephemeralSandboxDraft)
  const targetProfileId = selectionIntent || pendingProfile || (snapshot.targetId.startsWith('ssh:') ? snapshot.targetId.slice(4) : undefined)
  const selectedProfile = profiles.find((profile) => profile.id === targetProfileId)
  const workspace = snapshot.targetId === `ssh:${targetProfileId}` && snapshot.connections.some((item) => item.profileId === targetProfileId && item.status === 'connected') ? snapshot.selectedWorkspace : undefined
  const locked = !!targetProfileId && (!workspace || !!pendingProfile)
  const noProject = targetProfileId
    ? !!currentWorkspace && remoteHomeWorkspaceIds.has(currentWorkspace) && snapshot.workspaces.some((item) => item.workspaceId === currentWorkspace && item.profileId === targetProfileId)
    : !!ephemeralDraft || !!currentWorkspace?.replace(/\\/g, '/').includes('sandbox-workspaces/')
  const busy = busyCount > 0 || !!editor || !!folder || !!localFolder || !!trust || !!password

  useEffect(() => { rememberRemoteWorkspacePaths(snapshot.workspaces) }, [snapshot.workspaces])
  const reloadProfiles = async () => {
    const data = await invoke<{ profiles: SshProfile[]; authCapabilities: SshAuthCapabilities }>('ssh.profiles')
    if (!Array.isArray(data?.profiles)) throw new Error('Invalid SSH connection metadata response')
    profilesRef.current = data.profiles; setProfiles(data.profiles); setCapabilities(data.authCapabilities || { password: false })
    return data.profiles
  }
  useEffect(() => {
    let live = true; mounted.current = true
    const off = window.piDesktop?.onCodeEnvironmentEvent?.((event) => {
      if (event.kind !== 'snapshot' || !live) return
      if (event.snapshot.targetId !== snapshotRef.current.targetId) closeLocalFolder()
      snapshotRef.current = event.snapshot; setSnapshot(event.snapshot)
      if (!pendingRef.current && !intentRef.current && activeOperations.current.size === 0) {
        const intent = event.snapshot.targetId.startsWith('ssh:') ? event.snapshot.targetId.slice(4) : null
        intentRef.current = intent; setSelectionIntent(intent)
      }
      if (event.snapshot.targetId.startsWith('ssh:')) {
        const id = event.snapshot.targetId.slice(4)
        const connection = event.snapshot.connections.find((item) => item.profileId === id)
        if (connection?.status === 'disconnected' && isRemote(useUIStore.getState().currentWorkspace)) {
          clearProjection()
          setError(connection.error || 'SSH disconnected. Reconnect before continuing; an interrupted task may have an unknown outcome.')
        }
        useUIStore.setState({ recentProjects: event.snapshot.workspaces.filter((item) => item.profileId === id).map((item) => item.workspaceId) })
      }
    })
    void Promise.all([invoke<RemoteCodeSnapshot>('code.environment.get'), reloadProfiles()]).then(([value]) => {
      if (!live) return
      if (!value || typeof value.targetId !== 'string' || !Array.isArray(value.connections) || !Array.isArray(value.workspaces)) throw new Error('Invalid Code environment response')
      // A virtual resource from a previous process cannot become a local filesystem path on boot.
      if (value.targetId === 'local' && isRemote(useUIStore.getState().currentWorkspace)) {
        resetBlankSessionProjection(); useUIStore.setState({ currentWorkspace: null, ephemeralSandboxDraft: false, currentSessionId: null })
      }
      setSnapshot(value); setReady(true)
    }).catch((reason) => { if (live) { setError(sshErrorMessage(reason)); setReady(true) } })
    return () => {
      live = false; mounted.current = false; off?.(); ++generation.current
      passwordRef.current?.reject(cancelled()); folderRef.current?.resolve(); trustRef.current?.resolve(false); localFolderRef.current?.resolve()
      passwordRef.current = null; folderRef.current = null; trustRef.current = null; localFolderRef.current = null
    }
  }, [])
  const run = async (fn: () => Promise<void>) => {
    const operation = Symbol('location-operation')
    activeOperations.current.add(operation); setBusyCount(activeOperations.current.size); setError('')
    let token = generation.current
    try { const promise = fn(); token = generation.current; await promise }
    catch (reason) { if (mounted.current && generation.current === token && reason instanceof Error && reason.message !== 'Location selection cancelled') setError(sshErrorMessage(reason)) }
    finally { activeOperations.current.delete(operation); if (mounted.current) setBusyCount(activeOperations.current.size) }
  }
  const askPassword = (profile: SshProfile): Promise<string> => new Promise((resolve, reject) => {
    if (passwordRef.current) { reject(new Error('Another SSH sign-in is pending')); return }
    const value = { profile, resolve, reject }; passwordRef.current = value; setPassword(value)
  })
  const closePassword = () => { const value = passwordRef.current; passwordRef.current = null; setPassword(null); value?.reject(cancelled()) }
  const askFolder = (profileId: string, path: string, label: string, allowNoProject = false): Promise<string | undefined> => new Promise((resolve) => {
    folderRef.current?.resolve()
    const value = { profileId, path, label, allowNoProject, resolve }; folderRef.current = value; setFolder(value)
  })
  const closeFolder = (path?: string) => { const value = folderRef.current; folderRef.current = null; setFolder(null); value?.resolve(path) }
  const closeLocalFolder = (request = localFolderRef.current, path?: string) => {
    if (!request || localFolderRef.current !== request) return
    localFolderRef.current = null; setLocalFolder(null)
    request.resolve(request.generation === generation.current ? path : undefined)
  }
  // Selection only: no target switch, trust grant, project activation, or model/SDK warmup.
  const selectLocalFolder = (initialPath?: string): Promise<string | undefined> => new Promise((resolve) => {
    if (!mounted.current) { resolve(undefined); return }
    closeLocalFolder()
    const request = { id: ++localFolderVersion.current, initialPath, generation: generation.current, resolve }
    localFolderRef.current = request; setLocalFolder(request)
  })
  const askTrust = (path: string, hostLabel?: string, remoteHome = false): Promise<boolean> => new Promise((resolve) => {
    trustRef.current?.resolve(false)
    const value = { path, hostLabel, remoteHome, resolve }; trustRef.current = value; setTrust(value)
  })
  const closeTrust = (confirmed: boolean) => { const value = trustRef.current; trustRef.current = null; setTrust(null); value?.resolve(confirmed) }
  const clearProjection = () => {
    beginSessionNavigation(); resetBlankSessionProjection(); reportVisibleSession(null)
    resetAvailableModelsForEnvironment()
    useUIStore.setState({ currentWorkspace: null, currentSessionId: null, ephemeralSandboxDraft: false, pendingNewSessionPlaceholder: false, recentProjects: [], sessions: [], sessionsWorkspace: null, workspaceFileToOpen: null, modelPickerOpen: false, thinkingPickerOpen: false, runState: { status: 'idle', toolCount: 0, errorCount: 0 } })
  }
  const cancelSelection = () => {
    const id = pendingRef.current
    if (id) { intentRef.current = id; setSelectionIntent(id) }
    ++generation.current; pendingRef.current = null; setPendingProfile(null); activeOperations.current.clear(); setBusyCount(0)
    closePassword(); closeFolder(); closeLocalFolder(); closeTrust(false)
    if (id && snapshotRef.current.connections.some((item) => item.profileId === id && item.status === 'connecting')) void invoke('code.ssh.disconnect', { profileId: id, force: true }).catch(() => {})
  }
  const connect = async (profile: SshProfile, token = generation.current) => {
    const current = snapshotRef.current.connections.find((item) => item.profileId === profile.id)
    const known = connectedProfiles.current.get(profile.id)
    if (current?.status === 'connected') {
      if (!known || ['host', 'user', 'port', 'nodePath', 'piPath', 'identityFile', 'authMethod'].every((key) => known[key as keyof SshProfile] === profile[key as keyof SshProfile])) return current
      throw new Error('Disconnect this host before changing its connection settings')
    }
    let value: string | undefined
    try {
      if (profile.authMethod === 'password') {
        if (!capabilities.password) throw new Error(capabilities.passwordUnavailableReason || 'Password support requires sshpass')
        value = await askPassword(profile)
      }
      if (generation.current !== token || !mounted.current) throw cancelled()
      const result = await invoke<{ connection: RemoteCodeSnapshot['connections'][number]; snapshot: RemoteCodeSnapshot }>('code.ssh.connect', { profile, ...(value !== undefined ? { password: value } : {}), activate: false })
      if (generation.current !== token || !mounted.current) throw cancelled()
      connectedProfiles.current.set(profile.id, profile)
      // Connecting a draft is target-neutral. Never replace a newer foreground/root
      // with a snapshot captured by a connection reply; only merge its own status.
      const next = { ...snapshotRef.current, connections: [...snapshotRef.current.connections.filter((item) => item.profileId !== profile.id), result.connection] }
      snapshotRef.current = next; setSnapshot(next)
      return result.connection
    } finally { value = undefined }
  }
  const refreshModels = async () => {
    const module = await import('@renderer/lib/available-models-cache')
    await module.refreshAvailableModels().catch(() => {})
    void import('@renderer/lib/composer-run-display').then((data) => data.refreshComposerRunDisplay()).catch(() => {})
  }
  const openRemoteFolder = async (profile: SshProfile, path: string, token: number) => {
    const prepared = await invoke<{ path: string; name: string; hostLabel: string; trustToken: string; alreadyTrusted: boolean }>('code.ssh.prepareWorkspace', { profileId: profile.id, path })
    if (generation.current !== token) return
    if (!prepared.alreadyTrusted && !await askTrust(prepared.path, prepared.hostLabel)) return
    if (generation.current !== token) return
    const result = await invoke<{ workspace: RemoteCodeWorkspace; snapshot: RemoteCodeSnapshot }>('code.ssh.openWorkspace', { profileId: profile.id, path: prepared.path, trustToken: prepared.trustToken })
    if (generation.current !== token) return
    snapshotRef.current = result.snapshot; setSnapshot(result.snapshot); setPendingProfile(null)
    setRemoteHomeWorkspaceIds((ids) => { const next = new Set(ids); next.delete(result.workspace.workspaceId); return next })
    useUIStore.setState({ recentProjects: result.snapshot.workspaces.filter((item) => item.profileId === profile.id).map((item) => item.workspaceId) })
    const { activateWorkspace } = await import('@renderer/lib/activate-workspace')
    await activateWorkspace(result.workspace.workspaceId, { preferHome: true }); await refreshModels()
  }
  const chooseSsh = (profileId: string) => run(async () => {
    const token = ++generation.current
    closeLocalFolder()
    const profile = profilesRef.current.find((item) => item.id === profileId)
    if (!profile) throw new Error('SSH connection not found')
    clearProjection(); intentRef.current = profileId; setSelectionIntent(profileId); pendingRef.current = profileId; setPendingProfile(profileId)
    try {
      const connection = await connect(profile)
      if (generation.current !== token) return
      const selected = await invoke<{ snapshot: RemoteCodeSnapshot }>('code.ssh.select', { profileId })
      if (generation.current !== token) return
      setSnapshot(selected.snapshot); setPendingProfile(null)
      if (selected.snapshot.selectedWorkspace) await openRemoteFolder(profile, selected.snapshot.selectedWorkspace.nativePath, token)
      else {
        const path = await askFolder(profile.id, profile.cwd !== '/' ? profile.cwd : connection.home || '~', profile.name, true)
        if (path && generation.current === token) await openRemoteFolder(profile, path, token)
      }
    } finally { if (generation.current === token) { pendingRef.current = null; setPendingProfile(null) } }
  })
  const assertNoActiveRun = () => {
    const state = useUIStore.getState()
    if (state.runState.status === 'running' || state.agentTurnBootstrapping || state.streamingAssistantId) {
      throw new Error('Wait for the active run to finish before choosing No project. Ongoing work has not been stopped.')
    }
  }
  const chooseNoProject = () => run(async () => {
    assertNoActiveRun()
    const token = ++generation.current
    closePassword(); closeFolder(); closeLocalFolder(); closeTrust(false)
    const id = intentRef.current || pendingRef.current || (snapshotRef.current.targetId.startsWith('ssh:') ? snapshotRef.current.targetId.slice(4) : undefined)
    if (!id) {
      // Local's private scratch directory is allocated lazily on first send.
      enterBlankSession('ephemeral-sandbox')
      return
    }
    const profile = profilesRef.current.find((item) => item.id === id)
    if (!profile) throw new Error('SSH connection not found; No project cannot switch to Local')
    intentRef.current = id; setSelectionIntent(id); pendingRef.current = id; setPendingProfile(id)
    try {
      const connection = await connect(profile, token)
      if (generation.current !== token || !mounted.current) return
      const home = connection.home
      if (!home || !home.startsWith('/') || home.includes('\0')) throw new Error('Remote home is unavailable; select a remote folder instead')
      const prepared = await invoke<{ path: string; hostLabel: string; trustToken: string; alreadyTrusted: boolean }>('code.ssh.prepareWorkspace', { profileId: id, path: home })
      if (generation.current !== token || !mounted.current) return
      const knownHome = snapshotRef.current.workspaces.find((item) => item.profileId === id && item.nativePath === prepared.path && remoteHomeWorkspaceIds.has(item.workspaceId))
      // Even a previously trusted project needs explicit HOME-mode consent on first use.
      if ((!prepared.alreadyTrusted || !knownHome) && !await askTrust(prepared.path, prepared.hostLabel, true)) return
      if (generation.current !== token || !mounted.current) return
      assertNoActiveRun()
      const result = await invoke<{ workspace: RemoteCodeWorkspace; snapshot: RemoteCodeSnapshot }>('code.ssh.openWorkspace', { profileId: id, path: prepared.path, trustToken: prepared.trustToken })
      if (generation.current !== token || !mounted.current) return
      assertNoActiveRun()
      snapshotRef.current = result.snapshot; setSnapshot(result.snapshot)
      rememberRemoteWorkspacePaths([result.workspace])
      setRemoteHomeWorkspaceIds((ids) => new Set(ids).add(result.workspace.workspaceId))
      // Registration/trust only: do not activate a saved session, probe models, or start Pi.
      resetAvailableModelsForEnvironment()
      enterBlankSession('pending-project')
      useUIStore.setState({ currentWorkspace: result.workspace.workspaceId, workspaceFileToOpen: null, sessions: [], sessionsWorkspace: null, modelPickerOpen: false, thinkingPickerOpen: false })
    } finally { if (generation.current === token) { pendingRef.current = null; setPendingProfile(null) } }
  })
  const chooseLocal = () => run(async () => {
    const token = ++generation.current
    closePassword(); closeFolder(); closeLocalFolder(); closeTrust(false)
    clearProjection(); intentRef.current = null; setSelectionIntent(null); pendingRef.current = null; setPendingProfile(null)
    const result = await invoke<{ snapshot: RemoteCodeSnapshot; recentProjects: string[]; currentProject: string | null }>('code.environment.local')
    if (generation.current !== token) return
    snapshotRef.current = result.snapshot; setSnapshot(result.snapshot); useUIStore.setState({ recentProjects: result.recentProjects })
    if (result.currentProject && !isRemote(result.currentProject)) {
      const { activateWorkspace } = await import('@renderer/lib/activate-workspace'); await activateWorkspace(result.currentProject, { preferHome: true })
    } else enterBlankSession('ephemeral-sandbox')
    await refreshModels()
  })
  const chooseFolder = () => run(async () => {
    const token = ++generation.current
    closeLocalFolder()
    const id = intentRef.current || pendingRef.current || (snapshotRef.current.targetId.startsWith('ssh:') ? snapshotRef.current.targetId.slice(4) : undefined)
    if (id) {
      const profile = profilesRef.current.find((item) => item.id === id)
      if (!profile) throw new Error('SSH connection not found')
      pendingRef.current = id; setPendingProfile(id)
      try {
        const connection = await connect(profile)
        if (generation.current !== token) return
        const selected = await invoke<{ snapshot: RemoteCodeSnapshot }>('code.ssh.select', { profileId: id })
        if (generation.current !== token) return
        snapshotRef.current = selected.snapshot; setSnapshot(selected.snapshot)
        const path = await askFolder(id, snapshotRef.current.selectedWorkspace?.nativePath || connection.home || '~', profile.name, true)
        if (path && generation.current === token) await openRemoteFolder(profile, path, token)
      } finally { if (generation.current === token) { pendingRef.current = null; setPendingProfile(null) } }
    } else {
      const current = useUIStore.getState().currentWorkspace
      const path = await selectLocalFolder(current && !isRemote(current) ? current : undefined)
      if (!path || generation.current !== token) return
      if (!await askTrust(path) || generation.current !== token) return
      if (snapshotRef.current.targetId !== 'local' || intentRef.current) return
      const { activateWorkspace } = await import('@renderer/lib/activate-workspace')
      if (generation.current !== token || snapshotRef.current.targetId !== 'local' || intentRef.current) return
      await activateWorkspace(path, { preferHome: true })
    }
  })
  const chooseWorkspace = (workspaceId: string) => run(async () => {
    const token = ++generation.current
    closeLocalFolder()
    if (isRemote(workspaceId)) {
      const item = snapshotRef.current.workspaces.find((value) => value.workspaceId === workspaceId)
      const profile = profilesRef.current.find((value) => value.id === item?.profileId)
      if (!item || !profile) throw new Error('Unknown remote workspace; select the host and folder again')
      pendingRef.current = profile.id; setPendingProfile(profile.id)
      try {
        await connect(profile)
        if (generation.current !== token) return
        const selected = await invoke<{ snapshot: RemoteCodeSnapshot }>('code.ssh.select', { profileId: profile.id })
        if (generation.current !== token) return
        snapshotRef.current = selected.snapshot; setSnapshot(selected.snapshot)
        await openRemoteFolder(profile, item.nativePath, token)
      } finally { if (generation.current === token) { pendingRef.current = null; setPendingProfile(null) } }
    } else {
      if (snapshotRef.current.targetId !== 'local' || intentRef.current) throw new Error('Switch to Local before opening a local folder')
      if (!await askTrust(workspaceId) || generation.current !== token) return
      const { activateWorkspace } = await import('@renderer/lib/activate-workspace'); await activateWorkspace(workspaceId, { preferHome: true })
    }
  })
  const openUnifiedSession = (entry: SessionCatalogEntry) => run(async () => {
    const token = ++generation.current
    closePassword(); closeFolder(); closeLocalFolder(); closeTrust(false)
    // Validate against a fresh main-owned map BEFORE dialing. Old fingerprint namespaces,
    // deleted profiles and invented native paths never become connection/open requests.
    const catalog = await invoke<SessionCatalogResult>('code.sessions.list', { filter: entry.workspaceId })
    if (generation.current !== token) return
    const current = catalog.sessions.find((item) => item.key === entry.key && item.sessionId === entry.sessionId && item.sessionFile === entry.sessionFile && item.workspaceId === entry.workspaceId && item.targetId === entry.targetId)
    if (!current) throw new Error('Session location changed or is no longer known; refresh the session list')
    clearProjection()
    if (current.targetId === 'local') {
      if (isRemote(current.workspaceId) || isRemote(current.sessionFile)) throw new Error('Invalid local session identity')
      intentRef.current = null; setSelectionIntent(null); pendingRef.current = null; setPendingProfile(null)
      const result = await invoke<{ snapshot: RemoteCodeSnapshot; recentProjects: string[] }>('code.environment.local')
      if (generation.current !== token) return
      snapshotRef.current = result.snapshot; setSnapshot(result.snapshot)
      useUIStore.setState({ recentProjects: result.recentProjects })
      const { activateWorkspace } = await import('@renderer/lib/activate-workspace')
      if (generation.current !== token) return
      await activateWorkspace(current.workspaceId, { sessionId: current.sessionId, sessionFile: current.sessionFile })
      return
    }
    const profile = profilesRef.current.find((item) => item.id === current.profileId && current.targetId === `ssh:${item.id}`)
    if (!profile || !isRemote(current.workspaceId) || !current.sessionFile.startsWith(current.workspaceId + '/.sessions/')) throw new Error('Unknown SSH session identity')
    intentRef.current = profile.id; setSelectionIntent(profile.id); pendingRef.current = profile.id; setPendingProfile(profile.id)
    try {
      await connect(profile)
      if (generation.current !== token) return
      const result = await invoke<{ workspace: RemoteCodeWorkspace }>('code.sessions.prepareOpen', { workspaceId: current.workspaceId })
      if (generation.current !== token) return
      if (result.workspace.workspaceId !== current.workspaceId || result.workspace.nativePath !== current.nativePathDisplay) throw new Error('Remote workspace identity changed; refresh the session list')
      rememberRemoteWorkspacePaths([result.workspace])
      // Reconnect clears the service's session-key map. Register the live rows explicitly.
      const listed = await invoke<{ sessions: { sessionId: string; sessionFile?: string }[] }>('session.list', { workspaceId: current.workspaceId, refresh: true })
      if (generation.current !== token) return
      if (!listed.sessions.some((item) => item.sessionId === current.sessionId && item.sessionFile === current.sessionFile)) throw new Error('Remote session is no longer available')
      const { activateWorkspace } = await import('@renderer/lib/activate-workspace')
      if (generation.current !== token) return
      // All slow work above is target-neutral. Commit the exact root synchronously in main.
      await invoke('settings.set', { key: 'currentProject', value: current.workspaceId })
      if (generation.current !== token) return
      const selected = { ...snapshotRef.current, targetId: current.targetId, selectedWorkspace: result.workspace, workspaces: [...snapshotRef.current.workspaces.filter((item) => item.workspaceId !== current.workspaceId), result.workspace] }
      snapshotRef.current = selected; setSnapshot(selected)
      useUIStore.setState({ recentProjects: selected.workspaces.filter((item) => item.profileId === profile.id).map((item) => item.workspaceId) })
      pendingRef.current = null; setPendingProfile(null)
      await activateWorkspace(current.workspaceId, { sessionId: current.sessionId, sessionFile: current.sessionFile })
    } finally { if (generation.current === token) { pendingRef.current = null; setPendingProfile(null) } }
  })
  const disconnect = (profileId: string) => run(async () => {
    const result = await invoke<{ snapshot: RemoteCodeSnapshot }>('code.ssh.disconnect', { profileId })
    setSnapshot(result.snapshot); connectedProfiles.current.delete(profileId)
    if (result.snapshot.targetId === `ssh:${profileId}`) clearProjection()
  })
  const addConnection = () => setEditor({ version: ++editorVersion.current })
  const editConnection = (profileId: string) => { const initial = profiles.find((item) => item.id === profileId); if (initial) setEditor({ initial, version: ++editorVersion.current }) }
  const closeEditor = () => { ++editorVersion.current; setEditor(null) }
  const context: ContextValue = { ready, busy, error, clearError: () => setError(''), snapshot, profiles, selectedProfile, workspace, locked, noProject, chooseNoProject, selectLocalFolder, chooseLocal, chooseSsh, chooseFolder, chooseWorkspace, openUnifiedSession, addConnection, editConnection, disconnect }
  return <LocationContext.Provider value={context}>{children}
    {pendingProfile && busyCount > 0 && !password && !folder && !trust && !editor && <CodeLocationModal title={`Connecting to ${selectedProfile?.name || 'SSH host'}…`} onClose={cancelSelection} initialFocus="button" className="connection-progress-dialog" footer={<button onClick={cancelSelection}>Cancel</button>}><p>Establishing SSH and checking the remote Node runtime. No agent runs until a workspace is selected and trusted.</p></CodeLocationModal>}
    {editor && <SshConnectionDialog key={editor.version} initial={editor.initial} authCapabilities={capabilities} onClose={closeEditor} onTest={async (profile) => { const value = await connect(profile); return `SSH connected · Node ${value.nodeVersion || ''}. Pi starts only after you trust a workspace.` }} onBrowse={async (profile) => { const value = await connect(profile); return askFolder(profile.id, profile.worktreeFolder || value.home || '~', profile.name) }} onSave={async (profile) => {
      const version = editor.version
      const prior = profilesRef.current.find((item) => item.id === profile.id)
      const sameTarget = prior && ['host', 'user', 'port', 'nodePath', 'piPath', 'identityFile', 'authMethod'].every((key) => prior[key as keyof SshProfile] === profile[key as keyof SshProfile])
      if (prior && !sameTarget && snapshotRef.current.connections.some((item) => item.profileId === profile.id && item.status === 'connected')) throw new Error('Disconnect this host before changing its connection settings')
      await invoke('ssh.saveProfile', profile); await reloadProfiles()
      if (editorVersion.current !== version) return
      closeEditor(); await chooseSsh(profile.id)
    }} />}
    {folder && <RemoteFolderDialog key={`${folder.profileId}:${folder.path}`} initialPath={folder.path} hostLabel={folder.label} browse={(path) => invoke<HostDirectory>('code.ssh.browse', { profileId: folder.profileId, path })} onClose={() => closeFolder()} onSelect={(path) => closeFolder(path)} onNoProject={folder.allowNoProject ? () => { void chooseNoProject() } : undefined} />}
    {localFolder && <LocalFolderDialog key={localFolder.id} initialPath={localFolder.initialPath} recentPaths={useUIStore.getState().recentProjects.filter((path) => !isRemote(path))} browse={(request) => invoke<LocalFolderBrowseResult>('local.folders.browse', request)} resolve={(path) => invoke<LocalFolderResolveResult>('local.folders.resolve', { path })} onClose={() => closeLocalFolder(localFolder)} onSelect={(path) => closeLocalFolder(localFolder, path)} />}
    {trust && <TrustWorkspaceDialog path={trust.path} hostLabel={trust.hostLabel} remoteHome={trust.remoteHome} onClose={() => closeTrust(false)} onTrust={() => closeTrust(true)} />}
    {password && <div className="unified-code-auth"><SshPasswordDialog profile={password.profile} zh={false} onCancel={closePassword} onSubmit={(value) => { const pending = passwordRef.current; passwordRef.current = null; setPassword(null); pending?.resolve(value) }} /></div>}
  </LocationContext.Provider>
}
