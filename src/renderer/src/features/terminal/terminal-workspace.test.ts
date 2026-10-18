import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc-client'
import { canInteractWithPty, loadProfiles, spawnPane, writeToPty } from './terminal-bridge'
import { terminalActions, terminalTabsForWorkspace, useTerminalStore, type ShellProfile, type TerminalPaneState, type TerminalWorkspaceId } from './terminal-store'

const local = '/home/me/project'
// All three have the same native cwd; the two virtual identities name different hosts.
const ssh0 = '/__pi_ssh__/host0/home/me/project'
const ssh1 = '/__pi_ssh__/host1/home/me/project'
const profile = (id: string): ShellProfile => ({ id, name: id, path: '/bin/bash', args: [], kind: 'bash' })
const pane = (ptyId: string, workspaceId?: TerminalWorkspaceId): TerminalPaneState => ({ ptyId, workspaceId, profile: profile('bash') })
const currentTabs = () => terminalTabsForWorkspace(useTerminalStore.getState().tabs, useUIStore.getState().currentWorkspace)
const switchTo = (workspaceId: TerminalWorkspaceId) => useUIStore.setState({ currentWorkspace: workspaceId })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  switchTo(null)
  useTerminalStore.setState({ open: false, inputEnabled: true, tabs: [], activeTab: null, workspaceId: null, activeTabByWorkspace: {}, profiles: null, profilesByWorkspace: {} })
})
afterEach(() => {
  vi.restoreAllMocks()
  switchTo(null)
})

describe('exact terminal workspace isolation', () => {
  it('keeps local -> SSH0 -> SSH1 tabs and active selection separate, without discarding panes', () => {
    switchTo(local)
    const localTab = terminalActions.addTab(pane('local-pty', local))
    switchTo(ssh0)
    expect(currentTabs()).toEqual([])
    expect(useTerminalStore.getState().activeTab).toBeNull()
    const remote0 = terminalActions.addTab(pane('ssh-term-0', ssh0))
    switchTo(ssh1)
    expect(currentTabs()).toEqual([])
    const remote1 = terminalActions.addTab(pane('ssh-term-1', ssh1))
    terminalActions.focusTab(localTab)
    expect(useTerminalStore.getState().activeTab).toBe(remote1)
    expect(currentTabs().map((t) => t.id)).toEqual([remote1])
    switchTo(ssh0)
    expect(useTerminalStore.getState().activeTab).toBe(remote0)
    expect(currentTabs().map((t) => t.id)).toEqual([remote0])
    switchTo(local)
    expect(useTerminalStore.getState().activeTab).toBe(localTab)
    expect(useTerminalStore.getState().tabs).toHaveLength(3)
  })

  it('treats missing identity as local-null only and rejects mixed panes', () => {
    terminalActions.addTab(pane('legacy'))
    const tabs = useTerminalStore.getState().tabs
    expect(terminalTabsForWorkspace(tabs, null)).toHaveLength(1)
    expect(terminalTabsForWorkspace(tabs, local)).toEqual([])
    expect(terminalTabsForWorkspace(tabs, ssh0)).toEqual([])
    expect(terminalTabsForWorkspace([{ ...tabs[0], workspaceId: ssh0 }], ssh0)).toEqual([])
  })

  it('fails closed on cross-target split/restart, including a stale same-target tab', () => {
    switchTo(local)
    const id = terminalActions.addTab(pane('local-pty', local))
    expect(terminalActions.splitTab(id, pane('ssh-term-0', ssh0))).toBe(false)
    expect(terminalActions.replacePane('local-pty', pane('ssh-term-0', ssh0))).toBe(false)
    switchTo(ssh0)
    expect(terminalActions.splitTab(id, pane('local-late-split', local))).toBe(false)
    expect(terminalActions.splitTab(id, pane('ssh-term-0', ssh0))).toBe(false)
    expect(useTerminalStore.getState().tabs[0].panes.map((p) => p.ptyId)).toEqual(['local-pty'])
  })

  it('never falls back to another workspace when closing the active tab', () => {
    switchTo(local)
    terminalActions.addTab(pane('local-pty', local))
    switchTo(ssh0)
    const remote = terminalActions.addTab(pane('ssh-term-0', ssh0))
    terminalActions.closeTab(remote)
    expect(useTerminalStore.getState().activeTab).toBeNull()
    expect(currentTabs()).toEqual([])
    expect(useTerminalStore.getState().tabs).toHaveLength(1)
  })

  it('pins an async create before switching hosts and does not steal focus or open the drawer', async () => {
    switchTo(ssh0)
    const result = deferred<{ ok: boolean; id: string; profile: ShellProfile }>()
    const invoke = vi.spyOn(ipcClient, 'invoke').mockReturnValue(result.promise)
    const pending = spawnPane('remote-profile')
    expect(invoke).toHaveBeenCalledWith('terminal.create', expect.objectContaining({ cwd: ssh0, workspaceId: ssh0, profileId: 'remote-profile' }))
    switchTo(ssh1)
    const current = terminalActions.addTab(pane('ssh-term-1', ssh1))
    terminalActions.setOpen(false)
    result.resolve({ ok: true, id: 'ssh-term-late', profile: profile('remote-profile') })
    const created = await pending
    expect(created).toMatchObject({ workspaceId: ssh0 })
    if ('error' in created) throw new Error(created.error)
    terminalActions.addTab(created)
    expect(useTerminalStore.getState()).toMatchObject({ activeTab: current, open: false })
    expect(currentTabs().flatMap((t) => t.panes.map((p) => p.ptyId))).toEqual(['ssh-term-1'])
    expect(useTerminalStore.getState().tabs).toHaveLength(2)
  })

  it('rejects a local response under a remote identity and never retries locally', async () => {
    switchTo(ssh0)
    const invoke = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({ ok: true, id: 'local-pty', profile: profile('local') })
    expect(await spawnPane(undefined)).toEqual({ error: 'terminal namespace mismatch' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('blocks hidden and unknown PTY input synchronously after a UI switch', () => {
    const send = vi.fn()
    const previous = window.piDesktop
    window.piDesktop = { ...previous, terminalWrite: send } as NonNullable<Window['piDesktop']>
    try {
      switchTo(local)
      terminalActions.addTab(pane('local-pty', local))
      writeToPty('local-pty', 'local command')
      switchTo(ssh0)
      writeToPty('local-pty', 'must not run locally')
      writeToPty('ssh-term-unknown', 'must not fall back')
      expect(canInteractWithPty('local-pty')).toBe(false)
      terminalActions.addTab(pane('ssh-term-0', ssh0))
      writeToPty('ssh-term-0', 'remote command')
      expect(send.mock.calls).toEqual([['local-pty', 'local command'], ['ssh-term-0', 'remote command']])
    } finally {
      window.piDesktop = previous
    }
  })
})

describe('workspace-scoped profile reloads and output', () => {
  it('pins each profiles request and caches lists separately even if responses arrive out of order', async () => {
    const localProfiles = deferred<{ profiles: ShellProfile[] }>()
    const sshProfiles = deferred<{ profiles: ShellProfile[] }>()
    const invoke = vi.spyOn(ipcClient, 'invoke').mockReturnValueOnce(localProfiles.promise).mockReturnValueOnce(sshProfiles.promise)
    switchTo(local)
    const a = loadProfiles()
    switchTo(ssh0)
    const b = loadProfiles()
    expect(useTerminalStore.getState().profiles).toBeNull()
    sshProfiles.resolve({ profiles: [profile('ssh-only')] })
    await b
    localProfiles.resolve({ profiles: [profile('local-only')] })
    await a
    expect(useTerminalStore.getState().profiles?.map((p) => p.id)).toEqual(['ssh-only'])
    expect(invoke.mock.calls).toEqual([
      ['terminal.profiles', { refresh: false, cwd: local, workspaceId: local }],
      ['terminal.profiles', { refresh: false, cwd: ssh0, workspaceId: ssh0 }],
    ])
    switchTo(local)
    expect((await loadProfiles()).map((p) => p.id)).toEqual(['local-only'])
    switchTo(ssh0)
    expect((await loadProfiles()).map((p) => p.id)).toEqual(['ssh-only'])
    expect(invoke).toHaveBeenCalledTimes(2)
    switchTo(ssh1)
    expect(useTerminalStore.getState().profiles).toBeNull()
    invoke.mockResolvedValueOnce({ profiles: [profile('ssh1-only')] })
    expect((await loadProfiles()).map((p) => p.id)).toEqual(['ssh1-only'])
    expect(invoke).toHaveBeenLastCalledWith('terminal.profiles', { refresh: false, cwd: ssh1, workspaceId: ssh1 })
  })

  it('does not let an older profile refresh overwrite a newer one', async () => {
    switchTo(ssh0)
    const old = deferred<{ profiles: ShellProfile[] }>()
    const fresh = deferred<{ profiles: ShellProfile[] }>()
    vi.spyOn(ipcClient, 'invoke').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const a = loadProfiles(true)
    const b = loadProfiles(true)
    fresh.resolve({ profiles: [profile('fresh')] })
    await b
    old.resolve({ profiles: [profile('old')] })
    await a
    expect(useTerminalStore.getState().profiles?.map((p) => p.id)).toEqual(['fresh'])
  })

  it('retains background output by unique PTY id, never by cwd or active host', async () => {
    // Reset the bridge module only to install its one-time native subscriptions for this test.
    vi.resetModules()
    const bridge = await import('./terminal-bridge')
    let onData!: (event: { id: string; data: string }) => void
    const previous = window.piDesktop
    window.piDesktop = { ...previous, onTerminalData: (cb) => { onData = cb; return () => {} } } as NonNullable<Window['piDesktop']>
    const localWriter = vi.fn()
    const remoteWriter = vi.fn()
    try {
      const detach = bridge.attachWriter('local-buffer', localWriter)
      onData({ id: 'local-buffer', data: 'local output' })
      onData({ id: 'ssh-term-buffer', data: 'early remote output' })
      expect(localWriter.mock.calls).toEqual([['local output']])
      const detachRemote = bridge.attachWriter('ssh-term-buffer', remoteWriter)
      expect(remoteWriter.mock.calls).toEqual([['early remote output']])
      detach()
      onData({ id: 'local-buffer', data: 'background local output' })
      expect(remoteWriter).toHaveBeenCalledTimes(1)
      const reattach = bridge.attachWriter('local-buffer', localWriter)
      expect(localWriter).toHaveBeenLastCalledWith('background local output')
      reattach()
      detachRemote()
    } finally {
      window.piDesktop = previous
    }
  })
})
