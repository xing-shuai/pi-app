import { basename } from 'node:path'
import { z } from 'zod'
import { configStore } from '../../config-store'
import { sessionPreviewProcess } from '../../session-preview-process'
import { listSandboxWorkspaces } from '../../sandbox-workspaces'
import { getRemoteCodeService } from '../../remote-code'
import { resolveSessionListTitle } from '../../session-display-names'
import { workerManager } from '../../worker-manager'
import { isVirtualWorkspacePath } from '@shared/remote-code'
import { uniqueWorkspacePaths, workspacePathsEqual } from '@shared/workspace-path'
import { getAgentRuntimeConfig } from '../../wsl/runtime-config'
import { wslPathToWindows } from '@shared/wsl-path'
import { SessionCatalog, type CatalogSource } from '../../session-catalog/catalog'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'
import { registerHandler } from '../registry'

const requestSchema = z.object({ filter: z.string().max(4096).optional(), search: z.string().max(512).optional() }).strict()
export function createSessionCatalog(): SessionCatalog {
  return new SessionCatalog(async () => {
    // Read persisted local settings directly; settings.get is a selected-location projection.
    const roots = uniqueWorkspacePaths([
      ...(configStore.get('recentProjects') || []),
      ...(configStore.get('currentProject') ? [configStore.get('currentProject')!] : []),
      ...(await listSandboxWorkspaces().catch(() => [])).map((box) => box.path),
    ]).filter((path) => !isVirtualWorkspacePath(path)).slice(0, 500)
    const sources: CatalogSource[] = roots.map((workspaceId) => {
      const projectName = basename(workspaceId.replace(/\\/g, '/')) || workspaceId
      return {
        location: { targetId: 'local', label: 'Local', workspaceId, nativePathDisplay: workspaceId, projectName, disconnected: false },
        list: async () => {
          // The preview process caches empty lists too. A just-created conversation must
          // not remain invisible after switching locations or refreshing this catalog.
          await sessionPreviewProcess.invalidateListSessions(workspaceId)
          const rows = await sessionPreviewProcess.listSessions(workspaceId)
          const runtime = getAgentRuntimeConfig()
          const live = workerManager.listSessionRuntime()
          return rows.filter((row) => !row.cwd || workspacePathsEqual(row.cwd, workspaceId) || runtime.mode === 'wsl' && !!runtime.distro && workspacePathsEqual(wslPathToWindows(runtime.distro, row.cwd), workspaceId)).slice(0, 500).map((row): SessionCatalogEntry => ({
            key: `local:${workspaceId}:${row.path}`, sessionId: row.id, sessionFile: row.path, workspaceId, nativePathDisplay: workspaceId, projectName,
            title: resolveSessionListTitle(row.path, row.firstMessage?.slice(0, 60) || 'New session', row.name),
            targetId: 'local', locationLabel: 'Local', status: live.some((slot) => slot.running && slot.sessionFile === row.path) ? 'busy' : 'idle',
            updatedAt: row.modified?.getTime() || row.created?.getTime() || 0, messageCount: row.messageCount, firstMessage: row.firstMessage?.slice(0, 120), disconnected: false,
          }))
        },
      }
    })
    const remote = getRemoteCodeService()
    sources.push(...remote.sessionCatalogLocations.map((location) => ({ location, list: () => remote.listSessionCatalog(location.workspaceId) })))
    return sources
  })
}
/** Parent registers once in main IPC index and adds the literal channel to preload contracts. */
export function registerSessionCatalogHandlers(): void {
  const catalog = createSessionCatalog()
  registerHandler('ipc:code.sessions.list', async (raw) => {
    const parsed = requestSchema.safeParse(raw ?? {})
    if (!parsed.success) throw new Error('Invalid session catalog request')
    return catalog.list(parsed.data)
  })
  registerHandler('ipc:code.sessions.prepareOpen', async (raw) => {
    const parsed = z.object({ workspaceId: z.string().min(1).max(4096) }).strict().safeParse(raw)
    if (!parsed.success) throw new Error('Invalid session catalog open request')
    return { workspace: await getRemoteCodeService().prepareSessionCatalogOpen(parsed.data.workspaceId) }
  })
}
