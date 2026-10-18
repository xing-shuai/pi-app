/** Product surface and execution location are separate concepts. Never normalize remote paths locally. */
export type ProductSurface = 'chat' | 'code'
export type ExecutionCapability = 'sessions' | 'files' | 'git' | 'pty' | 'browser' | 'routines' | 'file-preview' | 'command-console'
export type ExecutionTarget = {
  id: string
  kind: 'local' | 'wsl' | 'ssh'
  name: string
  available: boolean
  reason?: string
  experimental?: boolean
  capabilities: ExecutionCapability[]
  lifetime: 'desktop' | 'ssh-connection'
}
export type EnvironmentList = { targets: ExecutionTarget[]; activeCodeTargetId: string }
export function workspaceIdentity(targetId: string, nativePath: string): string {
  if (!targetId || !nativePath) throw new Error('Execution target and native path are required')
  return JSON.stringify([targetId, nativePath])
}
export function supportsCapability(target: ExecutionTarget, capability: ExecutionCapability): boolean {
  return target.available && target.capabilities.includes(capability)
}
