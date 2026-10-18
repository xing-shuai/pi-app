import { isVirtualWorkspacePath } from '@shared/remote-code'
import { ipcClient } from './ipc-client'
import { remoteCodeFileTarget } from './remote-code-paths'
import { openWorkspaceRelativePath } from './open-workspace-path'
import { useUIStore } from '@renderer/stores/ui-store'

/** File actions originating in Code must never reinterpret a remote path as a client path. */
export async function openCodeFile(path: string, options: { reveal?: boolean; workspaceId?: string | null; line?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const current = useUIStore.getState().currentWorkspace
  const workspace = options.workspaceId === undefined ? current : options.workspaceId
  if (current !== workspace) return { ok: false, error: 'Workspace changed' }
  if (isVirtualWorkspacePath(workspace)) {
    if (options.reveal) return { ok: false, error: 'Remote files cannot be revealed in the local file manager' }
    const target = remoteCodeFileTarget(path, workspace!)
    return target && openWorkspaceRelativePath(target, options.line) ? { ok: true } : { ok: false, error: 'Path is outside the approved remote workspace' }
  }
  if (isVirtualWorkspacePath(path)) return { ok: false, error: 'Remote file requires its SSH workspace' }
  return ipcClient.invoke(options.reveal ? 'shell.showItemInFolder' : 'shell.openPath', { path })
}
