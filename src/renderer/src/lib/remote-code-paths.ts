import { isVirtualWorkspacePath, type RemoteCodeWorkspace } from '@shared/remote-code'

const roots = new Map<string, string>()
/** Display metadata only; never a source of local filesystem authority. */
export function rememberRemoteWorkspacePaths(workspaces: readonly RemoteCodeWorkspace[]): void {
  for (const workspace of workspaces) roots.set(workspace.workspaceId, workspace.nativePath)
  while (roots.size > 128) roots.delete(roots.keys().next().value!)
}
/** Map a remote transcript path to its approved virtual root; outside paths fail closed. */
export function remoteCodeFileTarget(path: string, workspaceId: string): string | null {
  if (!isVirtualWorkspacePath(workspaceId) || !path || /[\0\r\n\\]/.test(path)) return null
  let relative: string
  if (isVirtualWorkspacePath(path)) {
    if (!path.startsWith(workspaceId + '/')) return null
    relative = path.slice(workspaceId.length + 1)
  } else if (path.startsWith('/')) {
    const native = roots.get(workspaceId)?.replace(/\/+$/, '')
    if (native === undefined || !path.startsWith(native + '/')) return null
    relative = path.slice(native.length + 1)
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
    relative = path.replace(/^\.\//, '')
  }
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.outside' || !part)) return null
  return `${workspaceId}/${relative}`
}
