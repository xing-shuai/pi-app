import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { terminalActions, terminalProfilesForWorkspace, terminalTabsForWorkspace, terminalWorkspaceKey, useTerminalStore, type ShellProfile, type TerminalPaneState, type TerminalWorkspaceId } from './terminal-store'

type Writer = (data: string) => void

/** pty output per id; output that arrives before its pane mounted is held until it does. */
const writers = new Map<string, Writer>()
const pending = new Map<string, string[]>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.piDesktop?.onTerminalData?.(({ id, data }) => {
    const w = writers.get(id)
    if (w) w(data)
    else pending.set(id, [...(pending.get(id) ?? []), data])
  })
  window.piDesktop?.onTerminalExit?.(({ id, code }) => terminalActions.markExited(id, code))
}

export function attachWriter(id: string, w: Writer): () => void {
  wire()
  writers.set(id, w)
  for (const chunk of pending.get(id) ?? []) w(chunk)
  pending.delete(id)
  return () => {
    if (writers.get(id) === w) writers.delete(id)
  }
}

/** Check at send time too: a hidden xterm can still own focus or finish an async paste. */
export function canInteractWithPty(id: string): boolean {
  const s = useTerminalStore.getState()
  return s.inputEnabled && s.open && terminalTabsForWorkspace(s.tabs, useUIStore.getState().currentWorkspace)
    .some((tab) => tab.id === s.activeTab && tab.panes.some((pane) => pane.ptyId === id))
}

export function writeToPty(id: string, data: string): void {
  // Keep the existing fast ipc:terminal-write transport. Main pins the globally unique id to its namespace.
  if (canInteractWithPty(id)) window.piDesktop?.terminalWrite?.(id, data)
}

function paneWorkspace(id: string): TerminalWorkspaceId | undefined {
  const pane = useTerminalStore.getState().tabs.flatMap((tab) => tab.panes).find((pane) => pane.ptyId === id)
  return pane ? pane.workspaceId ?? null : undefined
}

export function resizePty(id: string, cols: number, rows: number): void {
  void ipcClient.invoke('terminal.resize', { id, cols, rows, workspaceId: paneWorkspace(id) }).catch(() => {})
}

const profileLoads = new Map<string, { promise: Promise<ShellProfile[]> }>()

export async function loadProfiles(refresh = false, workspaceId: TerminalWorkspaceId = useUIStore.getState().currentWorkspace): Promise<ShellProfile[]> {
  const key = terminalWorkspaceKey(workspaceId)
  const cached = terminalProfilesForWorkspace(useTerminalStore.getState().profilesByWorkspace, workspaceId)
  if (cached && !refresh) return cached
  const loading = profileLoads.get(key)
  if (loading && !refresh) return loading.promise
  const request = { promise: Promise.resolve([] as ShellProfile[]) }
  request.promise = (async () => {
    const r = (await ipcClient.invoke('terminal.profiles', { refresh, cwd: workspaceId ?? undefined, workspaceId })) as { profiles?: ShellProfile[] }
    const profiles = r?.profiles ?? []
    if (profileLoads.get(key) === request) terminalActions.setProfiles(profiles, workspaceId)
    return profiles
  })().finally(() => {
    if (profileLoads.get(key) === request) profileLoads.delete(key)
  })
  profileLoads.set(key, request)
  return request.promise
}

/** Spawn a shell (default: pi's own) in `cwd`; the pane sizes it on mount. */
export async function spawnPane(profileId: string | undefined, workspaceId: TerminalWorkspaceId = useUIStore.getState().currentWorkspace): Promise<TerminalPaneState | { error: string }> {
  if (!useTerminalStore.getState().inputEnabled) return { error: 'terminal execution locked' }
  wire()
  const r = (await ipcClient.invoke('terminal.create', { profileId, cwd: workspaceId ?? undefined, workspaceId, cols: 100, rows: 24 })
    .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' }))) as { ok: boolean; id?: string; profile?: ShellProfile; error?: string }
  if (!r?.ok || !r.id || !r.profile) return { error: r?.error || 'spawn failed' }
  if (Boolean(workspaceId?.startsWith('/__pi_ssh__/')) !== r.id.startsWith('ssh-term-')) return { error: 'terminal namespace mismatch' }
  return { ptyId: r.id, profile: r.profile, workspaceId }
}

export function killPty(id: string, workspaceId: TerminalWorkspaceId | undefined = paneWorkspace(id)): void {
  writers.delete(id)
  pending.delete(id)
  void ipcClient.invoke('terminal.kill', { id, workspaceId }).catch(() => {})
}

/** Quote a path for the shell it is typed into (WSL sees Windows drives under /mnt). */
export function shellPath(path: string, kind: string): string {
  if (kind === 'wsl') {
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(path)
    if (m) path = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
  }
  if (kind === 'cmd' || kind === 'pwsh' || kind === 'powershell') return `"${path.replace(/"/g, '""')}"`
  return `'${path.replace(/'/g, `'\\''`)}'`
}
