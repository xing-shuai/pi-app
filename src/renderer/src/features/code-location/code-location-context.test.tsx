import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RemoteCodeEnvironmentEvent, RemoteCodeSnapshot } from '@shared/remote-code'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'
import { CodeLocationProvider, useCodeLocation } from './code-location-context'

const f = vi.hoisted(() => ({
  activate: vi.fn(), refreshModels: vi.fn(), clearProjection: vi.fn(), enterBlank: vi.fn(),
  ui: { currentWorkspace: null as string | null, recentProjects: ['/recent', '/__pi_ssh__/remote/root/project'], ephemeralSandboxDraft: false, currentSessionId: null as string | null, runState: { status: 'idle' }, agentTurnBootstrapping: false, streamingAssistantId: null as string | null },
}))
vi.mock('@renderer/stores/ui-store', () => ({ useUIStore: Object.assign((selector: (state: typeof f.ui) => unknown) => selector(f.ui), { getState: () => f.ui, setState: (value: Partial<typeof f.ui>) => Object.assign(f.ui, value) }) }))
vi.mock('@renderer/lib/session-navigation', () => ({ beginSessionNavigation: vi.fn() }))
vi.mock('@renderer/lib/remote-code-paths', () => ({ rememberRemoteWorkspacePaths: vi.fn() }))
vi.mock('@renderer/lib/visible-session-report', () => ({ reportVisibleSession: vi.fn() }))
vi.mock('@renderer/lib/blank-session-transition', () => ({ resetBlankSessionProjection: f.clearProjection, enterBlankSession: f.enterBlank }))
vi.mock('@renderer/lib/available-models-cache', () => ({ resetAvailableModelsForEnvironment: vi.fn(), refreshAvailableModels: f.refreshModels }))
vi.mock('@renderer/lib/activate-workspace', () => ({ activateWorkspace: f.activate }))
vi.mock('@renderer/lib/composer-run-display', () => ({ refreshComposerRunDisplay: vi.fn() }))
vi.mock('./ssh-connection-dialog', () => ({ SshConnectionDialog: () => null }))
vi.mock('@renderer/features/ssh/ssh-password-dialog', () => ({ SshPasswordDialog: ({ onCancel }: { onCancel: () => void }) => <button onClick={onCancel}>Cancel password</button> }))
const local: RemoteCodeSnapshot = { targetId: 'local', connections: [], workspaces: [] }
const profileId = '175a1f7f-75bd-47f0-8188-788282755caf'
const profile = { id: profileId, name: 'Remote host', host: 'test.invalid', cwd: '/', authMethod: 'agent' }
let context: ReturnType<typeof useCodeLocation>
let invoke: Mock<(channel: string, request?: unknown) => Promise<unknown>>
let emit: (event: RemoteCodeEnvironmentEvent) => void
const original = window.piDesktop
const listing = { path: '/local', home: '/home/me', parent: '/', entries: [], roots: [{ name: 'Filesystem', path: '/' }], truncated: false }
function Harness() {
  context = useCodeLocation()
  return <><span>{context.ready ? 'ready' : 'starting'}</span><span>{context.busy ? 'busy' : 'idle'}</span><button onClick={() => void context.chooseFolder()}>Choose project</button><button onClick={() => void context.chooseSsh(profileId)}>Choose SSH</button></>
}
beforeEach(() => {
  vi.clearAllMocks(); f.refreshModels.mockResolvedValue(undefined); f.ui.currentWorkspace = null; f.ui.recentProjects = ['/recent', '/__pi_ssh__/remote/root/project']
  f.ui.ephemeralSandboxDraft = false; f.ui.runState = { status: 'idle' }; f.ui.agentTurnBootstrapping = false; f.ui.streamingAssistantId = null; f.ui.currentSessionId = null
  f.enterBlank.mockImplementation((kind: string) => { f.ui.ephemeralSandboxDraft = kind === 'ephemeral-sandbox'; if (kind === 'ephemeral-sandbox') f.ui.currentWorkspace = null })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'ipc:code.environment.get') return local
    if (channel === 'ipc:ssh.profiles') return { profiles: [profile], authCapabilities: { password: false } }
    if (channel === 'ipc:local.folders.browse') return listing
    if (channel === 'ipc:local.folders.resolve') return { path: '/canonical/local', name: 'local' }
    if (channel === 'ipc:code.ssh.connect') return { connection: { profileId, status: 'connected', home: '/remote/home' }, snapshot: { ...local, connections: [{ profileId, status: 'connected' }] } }
    if (channel === 'ipc:code.ssh.select') return { snapshot: { targetId: `ssh:${profileId}`, connections: [{ profileId, status: 'connected', home: '/remote/home' }], workspaces: [] } }
    if (channel === 'ipc:code.ssh.browse') return { path: '/remote/home', entries: [] }
    throw new Error(`Unexpected IPC: ${channel}`)
  })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke, onCodeEnvironmentEvent: (fn: typeof emit) => { emit = fn; return vi.fn() } } })
})
afterEach(() => { cleanup(); window.piDesktop = original })
const mount = async () => { const view = render(<CodeLocationProvider><Harness /></CodeLocationProvider>); await screen.findByText('ready'); return view }

const unifiedEntry: SessionCatalogEntry = { key: 'remote-key', sessionId: 'saved', sessionFile: `/__pi_ssh__/${profileId}/fingerprint/project/.sessions/saved.jsonl`, workspaceId: `/__pi_ssh__/${profileId}/fingerprint/project`, nativePathDisplay: '/remote/project', projectName: 'project', title: 'Saved conversation', targetId: `ssh:${profileId}`, profileId, locationLabel: 'Remote host', status: 'idle', updatedAt: 1, disconnected: true }
function unifiedIpc(base: typeof invoke, entry = unifiedEntry) {
  const normal = base.getMockImplementation()!
  const workspace = { workspaceId: entry.workspaceId, targetId: entry.targetId, profileId, nativePath: entry.nativePathDisplay, name: entry.projectName, hostLabel: 'Remote host' }
  base.mockImplementation(async (channel, request) => {
    if (channel === 'ipc:code.sessions.list') return { sessions: [entry], locations: [] }
    if (channel === 'ipc:code.environment.local') return { snapshot: local, recentProjects: ['/known'] }
    if (channel === 'ipc:code.sessions.prepareOpen') return { workspace }
    if (channel === 'ipc:settings.set') return { key: 'currentProject', value: entry.workspaceId }
    if (channel === 'ipc:session.list') return { sessions: [{ sessionId: entry.sessionId, sessionFile: entry.sessionFile }] }
    return normal(channel, request)
  })
}
describe('Unified cross-location session opening', () => {
  it('explicitly restores local backend before activating an exact local session', async () => {
    const entry: SessionCatalogEntry = { ...unifiedEntry, key: 'local-key', targetId: 'local', profileId: undefined, workspaceId: '/known', sessionFile: '/known-session.jsonl' }
    unifiedIpc(invoke, entry); await mount()
    await act(async () => context.openUnifiedSession(entry))
    expect(f.activate).toHaveBeenCalledExactlyOnceWith('/known', { sessionId: 'saved', sessionFile: '/known-session.jsonl' })
    expect(invoke.mock.calls.some(([channel]) => channel.startsWith('ipc:code.ssh.'))).toBe(false)
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('ipc:code.environment.local')
  })
  it('reconnects only after click, canonically opens and refreshes keys before binding exact SSH session', async () => {
    unifiedIpc(invoke); await mount()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:code.ssh.connect')).toBe(false)
    await act(async () => context.openUnifiedSession(unifiedEntry))
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(unifiedEntry.workspaceId, { sessionId: 'saved', sessionFile: unifiedEntry.sessionFile })
    expect(context.snapshot.targetId).toBe(unifiedEntry.targetId)
    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('ipc:session.list')).toBeGreaterThan(channels.indexOf('ipc:code.sessions.prepareOpen'))
    expect(channels.indexOf('ipc:settings.set')).toBeGreaterThan(channels.indexOf('ipc:session.list'))
    expect(invoke).toHaveBeenCalledWith('ipc:session.list', { workspaceId: unifiedEntry.workspaceId, refresh: true })
    expect(channels).not.toContain('ipc:prompt.send')
  })
  it('rejects an old fingerprint row without dialing or falling back to local', async () => {
    unifiedIpc(invoke); await mount()
    await act(async () => context.openUnifiedSession({ ...unifiedEntry, workspaceId: '/__pi_ssh__/old/project' }))
    expect(f.activate).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:code.ssh.connect' || channel === 'ipc:code.environment.local')).toBe(false)
    expect(context.error).toContain('changed')
  })
  it('password cancellation never opens locally or sends a connection request', async () => {
    unifiedIpc(invoke)
    const normal = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) => channel === 'ipc:ssh.profiles' ? Promise.resolve({ profiles: [{ ...profile, authMethod: 'password' }], authCapabilities: { password: true } }) : normal(channel, request))
    await mount()
    let opening!: Promise<void>
    act(() => { opening = context.openUnifiedSession(unifiedEntry) })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel password' }))
    await act(async () => opening)
    expect(f.activate).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:code.ssh.connect' || channel === 'ipc:code.environment.local')).toBe(false)
  })
  it('keeps cancelled SSH intent locked across disconnect events, and ignores a late handshake after Local selection', async () => {
    unifiedIpc(invoke); const normal = invoke.getMockImplementation()!
    let finish!: (value: unknown) => void, finishLocal!: (value: unknown) => void
    invoke.mockImplementation((channel, request) => {
      if (channel === 'ipc:code.ssh.connect') {
        emit({ kind: 'snapshot', snapshot: { ...local, connections: [{ profileId, name: profile.name, status: 'connecting' }] } })
        return new Promise((resolve) => { finish = resolve })
      }
      if (channel === 'ipc:code.environment.local') return new Promise((resolve) => { finishLocal = resolve })
      if (channel === 'ipc:code.ssh.disconnect') {
        emit({ kind: 'snapshot', snapshot: { ...local, connections: [{ profileId, name: profile.name, status: 'disconnected' }] } })
        return Promise.resolve({ snapshot: local })
      }
      return normal(channel, request)
    })
    await mount()
    let stale!: Promise<void>
    act(() => { stale = context.openUnifiedSession(unifiedEntry) })
    const progress = await screen.findByRole('dialog', { name: 'Connecting to Remote host…' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(progress).not.toBeInTheDocument())
    expect(context.locked).toBe(true)
    expect(context.selectedProfile?.id).toBe(profileId)
    expect(f.activate).not.toHaveBeenCalled()
    let selectingLocal!: Promise<void>
    act(() => { selectingLocal = context.chooseLocal() })
    expect(context.locked).toBe(false)
    expect(context.busy).toBe(true)
    await act(async () => { finish({ connection: { profileId, status: 'connected' }, snapshot: { ...local, targetId: `ssh:${profileId}`, connections: [{ profileId, status: 'connected' }] } }); await stale })
    expect(context.busy).toBe(true) // Old cleanup cannot decrement the newer operation.
    act(() => emit({ kind: 'snapshot', snapshot: { ...local, targetId: `ssh:${profileId}`, connections: [{ profileId, name: profile.name, status: 'disconnected' }] } }))
    await act(async () => { finishLocal({ snapshot: local, recentProjects: [] }); await selectingLocal })
    expect(context.busy).toBe(false)
    expect(context.error).toBe('')
    expect(context.snapshot.targetId).toBe('local')
    expect(context.selectedProfile).toBeUndefined()
    expect(context.snapshot.connections.some((item) => item.status === 'connected')).toBe(false)
    expect(context.locked).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })
  it('ignores late catalog results after a newer row selection', async () => {
    unifiedIpc(invoke); const normal = invoke.getMockImplementation()!
    let finish!: (value: unknown) => void; let first = true
    invoke.mockImplementation((channel, request) => {
      if (channel === 'ipc:code.sessions.list' && first) { first = false; return new Promise((resolve) => { finish = resolve }) }
      return normal(channel, request)
    })
    await mount()
    let stale!: Promise<void>
    act(() => { stale = context.openUnifiedSession(unifiedEntry) })
    await act(async () => context.openUnifiedSession(unifiedEntry))
    await act(async () => { finish({ sessions: [unifiedEntry], locations: [] }); await stale })
    expect(f.activate).toHaveBeenCalledOnce()
  })
})

const homeWorkspace = { workspaceId: `/__pi_ssh__/${profileId}/exact-fingerprint/home`, targetId: `ssh:${profileId}` as const, profileId, nativePath: '/canonical/home', name: 'home', hostLabel: 'Remote host' }
const remoteSnapshot: RemoteCodeSnapshot = { targetId: `ssh:${profileId}`, connections: [{ profileId, name: 'Remote host', status: 'connected', home: '/remote/home' }], workspaces: [] }
function homeIpc(alreadyTrusted = false) {
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) => {
    if (channel === 'ipc:code.ssh.prepareWorkspace') return Promise.resolve({ path: homeWorkspace.nativePath, hostLabel: 'Remote host', trustToken: 'home-token', alreadyTrusted })
    if (channel === 'ipc:code.ssh.openWorkspace') return Promise.resolve({ workspace: homeWorkspace, snapshot: { ...remoteSnapshot, selectedWorkspace: homeWorkspace, workspaces: [homeWorkspace] } })
    return normal(channel, request)
  })
}

describe('Optional project provider integration', () => {
  it('clears Local into a private scratch draft without changing saved projects, probing models, or opening a session', async () => {
    const view = await mount(); f.ui.currentWorkspace = '/recent'; invoke.mockClear()
    await act(async () => context.chooseNoProject())
    // This store mock is selector-only; explicitly project its updated draft state.
    view.rerender(<CodeLocationProvider><Harness /></CodeLocationProvider>)
    expect(f.enterBlank).toHaveBeenCalledExactlyOnceWith('ephemeral-sandbox')
    expect(f.ui.currentWorkspace).toBeNull(); expect(f.ui.recentProjects).toEqual(['/recent', '/__pi_ssh__/remote/root/project'])
    expect(context.noProject).toBe(true)
    expect(invoke).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled()
  })
  it('uses canonical remote home and requires explicit HOME consent even when it was previously trusted as a project', async () => {
    homeIpc(true); await mount()
    act(() => emit({ kind: 'snapshot', snapshot: remoteSnapshot }))
    let selection!: Promise<void>
    act(() => { selection = context.chooseNoProject() })
    await screen.findByRole('dialog', { name: 'Use remote home without a project?' })
    expect(screen.getByText('/canonical/home')).toBeInTheDocument()
    expect(screen.getByText(/including outside this directory/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('ipc:code.ssh.prepareWorkspace', { profileId, path: '/remote/home' })
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:code.ssh.openWorkspace')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Trust remote home' }))
    await act(async () => selection)
    expect(invoke).toHaveBeenCalledWith('ipc:code.ssh.openWorkspace', { profileId, path: '/canonical/home', trustToken: 'home-token' })
    expect(context.noProject).toBe(true); expect(context.locked).toBe(false)
    expect(f.ui.currentWorkspace).toBe(homeWorkspace.workspaceId)
    expect(f.enterBlank).toHaveBeenCalledExactlyOnceWith('pending-project')
    expect(f.activate).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['ipc:code.environment.get', 'ipc:ssh.profiles', 'ipc:code.ssh.prepareWorkspace', 'ipc:code.ssh.openWorkspace'])
  })
  it('cancel keeps the selected project/history and remote target, without Local fallback or a session start', async () => {
    homeIpc(); await mount(); f.ui.currentWorkspace = unifiedEntry.workspaceId; f.ui.currentSessionId = 'saved'
    act(() => emit({ kind: 'snapshot', snapshot: remoteSnapshot }))
    let selection!: Promise<void>
    act(() => { selection = context.chooseNoProject() })
    await screen.findByRole('dialog', { name: 'Use remote home without a project?' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => selection)
    expect(f.ui.currentWorkspace).toBe(unifiedEntry.workspaceId); expect(f.ui.currentSessionId).toBe('saved')
    expect(context.snapshot.targetId).toBe(remoteSnapshot.targetId); expect(context.noProject).toBe(false)
    expect(f.enterBlank).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('ipc:code.environment.local')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('ipc:code.ssh.openWorkspace')
  })
  it('offers Remote home directly from the SSH folder chooser, never using the profile cwd', async () => {
    homeIpc(); await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Choose SSH' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No project · Remote home' }))
    await screen.findByRole('dialog', { name: 'Use remote home without a project?' })
    expect(invoke).toHaveBeenCalledWith('ipc:code.ssh.prepareWorkspace', { profileId, path: '/remote/home' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('idle')
    expect(context.selectedProfile?.id).toBe(profileId); expect(context.locked).toBe(true)
    expect(f.enterBlank).not.toHaveBeenCalled()
  })
  it('fails closed when remote home is missing or preparation fails', async () => {
    await mount()
    act(() => emit({ kind: 'snapshot', snapshot: { ...remoteSnapshot, connections: [{ ...remoteSnapshot.connections[0]!, home: undefined }] } }))
    await act(async () => context.chooseNoProject())
    expect(context.error).toContain('Remote home is unavailable')
    act(() => emit({ kind: 'snapshot', snapshot: remoteSnapshot }))
    const normal = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) => channel === 'ipc:code.ssh.prepareWorkspace' ? Promise.reject(new Error('Permission denied')) : normal(channel, request))
    await act(async () => context.chooseNoProject())
    expect(context.error).toContain('Permission denied')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('ipc:code.environment.local')
    expect(f.enterBlank).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled()
  })
  it('refuses No project during an active run, including one begun while trust was pending', async () => {
    homeIpc(); await mount(); f.ui.currentWorkspace = '/recent'; f.ui.runState.status = 'running'; invoke.mockClear()
    await act(async () => context.chooseNoProject())
    expect(context.error).toContain('Ongoing work has not been stopped')
    expect(f.ui.currentWorkspace).toBe('/recent'); expect(invoke).not.toHaveBeenCalled(); expect(f.enterBlank).not.toHaveBeenCalled()
    f.ui.runState.status = 'idle'
    act(() => emit({ kind: 'snapshot', snapshot: remoteSnapshot }))
    let selection!: Promise<void>
    act(() => { selection = context.chooseNoProject() })
    await screen.findByRole('dialog', { name: 'Use remote home without a project?' })
    f.ui.runState.status = 'running'
    fireEvent.click(screen.getByRole('button', { name: 'Trust remote home' }))
    await act(async () => selection)
    expect(context.error).toContain('active run')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('ipc:code.ssh.openWorkspace')
    expect(f.enterBlank).not.toHaveBeenCalled()
  })
  it('ignores late home preparation after a newer Local selection', async () => {
    homeIpc(); await mount()
    act(() => emit({ kind: 'snapshot', snapshot: remoteSnapshot }))
    const normal = invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel, request) => {
      if (channel === 'ipc:code.ssh.prepareWorkspace') return new Promise((resolve) => { finish = resolve })
      if (channel === 'ipc:code.environment.local') return Promise.resolve({ snapshot: local, recentProjects: [] })
      return normal(channel, request)
    })
    let stale!: Promise<void>
    act(() => { stale = context.chooseNoProject() })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await act(async () => context.chooseLocal())
    await act(async () => { finish({ path: homeWorkspace.nativePath, hostLabel: 'Remote host', trustToken: 'late', alreadyTrusted: false }); await stale })
    expect(context.snapshot.targetId).toBe('local')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('ipc:code.ssh.openWorkspace')
  })
  it('cancels a remote HOME password prompt without connecting or opening locally', async () => {
    const normal = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) => channel === 'ipc:ssh.profiles' ? Promise.resolve({ profiles: [{ ...profile, authMethod: 'password' }], authCapabilities: { password: true } }) : normal(channel, request))
    await mount()
    act(() => emit({ kind: 'snapshot', snapshot: { ...remoteSnapshot, connections: [] } }))
    let selection!: Promise<void>
    act(() => { selection = context.chooseNoProject() })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel password' }))
    await act(async () => selection)
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:code.ssh.connect' || channel === 'ipc:code.environment.local')).toBe(false)
    expect(context.locked).toBe(true); expect(f.enterBlank).not.toHaveBeenCalled()
  })
})

describe('Local picker provider integration', () => {
  it('never invokes native/remote browsing and activates only after canonical selection AND explicit trust', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    expect(f.activate).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled(); expect(f.clearProjection).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Trust this workspace?' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await screen.findByRole('dialog', { name: 'Trust this workspace?' })
    expect(screen.getByText('/canonical/local')).toBeInTheDocument()
    expect(f.activate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('idle'); expect(f.activate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Trust workspace' }))
    await waitFor(() => expect(f.activate).toHaveBeenCalledExactlyOnceWith('/canonical/local', { preferHome: true }))
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:dialog:openDirectory' || channel.startsWith('ipc:code.ssh.'))).toBe(false)
  })
  it('exposes a busy, selection-only method for Routines; cancel/unmount/replacement settle every promise', async () => {
    const view = await mount()
    let first!: Promise<string | undefined>, second!: Promise<string | undefined>
    act(() => { first = context.selectLocalFolder('/routine') })
    expect(screen.getByText('busy')).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:local.folders.browse', { path: '/routine', includeHidden: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(first).resolves.toBeUndefined()
    act(() => { first = context.selectLocalFolder(); second = context.selectLocalFolder('/new') })
    await expect(first).resolves.toBeUndefined()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await expect(second).resolves.toBe('/canonical/local')
    expect(f.activate).not.toHaveBeenCalled(); expect(f.clearProjection).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => { first = context.selectLocalFolder() })
    view.unmount(); await expect(first).resolves.toBeUndefined()
  })
  it('can select a local Routine cwd while Code targets SSH without switching that target', async () => {
    await mount()
    act(() => emit({ kind: 'snapshot', snapshot: { ...local, targetId: `ssh:${profileId}` } }))
    invoke.mockClear()
    let selection!: Promise<string | undefined>
    act(() => { selection = context.selectLocalFolder('/routine') })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await expect(selection).resolves.toBe('/canonical/local')
    expect(context.snapshot.targetId).toBe(`ssh:${profileId}`)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['ipc:local.folders.browse', 'ipc:local.folders.resolve'])
    expect(f.activate).not.toHaveBeenCalled(); expect(f.clearProjection).not.toHaveBeenCalled(); expect(f.refreshModels).not.toHaveBeenCalled()
  })
  it('keeps browse failures in the custom dialog with no native fallback or trust grant', async () => {
    await mount()
    invoke.mockImplementation(async (channel: string) => { throw new Error(channel === 'ipc:local.folders.browse' ? 'Permission denied.' : 'Unexpected fallback') })
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied.')
    expect(screen.getByRole('button', { name: 'Select folder' })).toBeDisabled()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:dialog:openDirectory')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('idle'); expect(f.activate).not.toHaveBeenCalled()
  })
  it('cancels in-flight local confirmation when target changes and never late-retargets SSH', async () => {
    await mount()
    const normal = invoke.getMockImplementation()!
    let finish!: (value: { path: string; name: string }) => void
    invoke.mockImplementation((channel: string) => channel === 'ipc:local.folders.resolve' ? new Promise((resolve) => { finish = resolve }) : normal(channel))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    act(() => emit({ kind: 'snapshot', snapshot: { ...local, targetId: `ssh:${profileId}` } }))
    await act(async () => finish({ path: '/late', name: 'late' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(f.activate).not.toHaveBeenCalled()
  })
  it('keeps SSH browsing pinned to the chosen profile, separate from local selection', async () => {
    await mount()
    let selection!: Promise<string | undefined>
    act(() => { selection = context.selectLocalFolder() })
    await screen.findByRole('dialog', { name: 'Select local folder' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose SSH' }))
    await expect(selection).resolves.toBeUndefined()
    await screen.findByRole('dialog', { name: 'Select remote folder' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:code.ssh.browse', { profileId, path: '/remote/home' }))
    expect(screen.queryByRole('dialog', { name: 'Select local folder' })).not.toBeInTheDocument()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ipc:dialog:openDirectory')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(f.activate).not.toHaveBeenCalled()
  })
})
