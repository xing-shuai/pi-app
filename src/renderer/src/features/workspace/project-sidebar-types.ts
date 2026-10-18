import { isVirtualWorkspacePath, virtualWorkspaceDisplayName } from '@shared/remote-code'

export type SandboxEntry = {
  id: string
  path: string
  label: string
  createdAt: number
  kind: 'sandbox'
  sessionId?: string
  sessionFile?: string
}

export type SessionItem = {
  sessionId: string
  sessionFile?: string
  parentSessionFile?: string
  title: string
  firstMessage?: string
  workspaceId?: string
  updatedAt: number
  messageCount?: number
  modelId: string
}

export function diskProjectName(path: string) {
  if (isVirtualWorkspacePath(path)) return virtualWorkspaceDisplayName(path)
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function isSandboxPath(path: string) {
  return path.replace(/\\/g, '/').includes('sandbox-workspaces/')
}