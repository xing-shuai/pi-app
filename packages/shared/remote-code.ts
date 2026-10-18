import type { HostState } from './ssh-host-types'

/** Reserved: these paths must NEVER be passed to a client filesystem or shell. */
export const REMOTE_CODE_PREFIX = '/__pi_ssh__/'
export const REMOTE_CODE_EVENT_CHANNEL = 'ipc:code-environment-event'
export type RemoteCodeConnection = {
  profileId: string
  name: string
  status: 'connecting' | 'connected' | 'disconnected'
  home?: string
  nodeVersion?: string
  error?: string
  capabilities?: HostState['capabilities']
}
export type RemoteCodeWorkspace = {
  workspaceId: string
  targetId: `ssh:${string}`
  profileId: string
  nativePath: string
  name: string
  hostLabel: string
}
export type RemoteCodeSnapshot = {
  targetId: 'local' | `ssh:${string}`
  connections: RemoteCodeConnection[]
  workspaces: RemoteCodeWorkspace[]
  selectedWorkspace?: RemoteCodeWorkspace
}
/** Exact restored remote runtime facts, attached to context.preview without local schema changes. */
export type RemoteSessionContext = {
  model?: string
  contextUsage?: { tokens: number | null; contextWindow: number }
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
}
export type RemoteCodeEnvironmentEvent = { kind: 'snapshot'; snapshot: RemoteCodeSnapshot }
export function isVirtualWorkspacePath(path: unknown): boolean {
  return typeof path === 'string' && (path === '/__pi_ssh__' || path.startsWith(REMOTE_CODE_PREFIX))
}
export function virtualWorkspacePath(profileId: string, rootHash: string, basename: string): string {
  return `${REMOTE_CODE_PREFIX}${profileId}/${rootHash}/${encodeURIComponent(basename || 'root')}`
}
export function virtualWorkspaceDisplayName(path: string, workspaces?: readonly RemoteCodeWorkspace[]): string {
  const known = workspaces?.find((w) => w.workspaceId === path)
  if (known) return `${known.name} · ${known.hostLabel}`
  if (!isVirtualWorkspacePath(path)) return path.split(/[\\/]/).filter(Boolean).pop() || path
  try { return decodeURIComponent(path.split('/')[4] || 'Remote workspace') } catch { return 'Remote workspace' }
}
/** Display only. Never feed the native result back into local Code IPC requests. */
export function virtualWorkspaceDisplayPath(path: string, workspaces?: readonly RemoteCodeWorkspace[]): string {
  const known = workspaces?.find((w) => w.workspaceId === path)
  return known ? `${known.hostLabel}:${known.nativePath}` : isVirtualWorkspacePath(path) ? `SSH · ${virtualWorkspaceDisplayName(path)}` : path
}
