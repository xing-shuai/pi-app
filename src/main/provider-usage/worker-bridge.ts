import type { ProviderUsageRequest, ProviderUsageSnapshot } from '@shared/provider-usage-types'
import { isNonLocalUsageRequest } from './runtime'
import { unavailableUsage } from './service'

type Authorization = { ok: true; cwd: string; sessionFile: string } | { ok: false; error: string }
export interface ProviderUsageBridgeDependencies {
  authorize: (cwd: string | undefined, sessionFile: string | undefined) => Promise<Authorization>
  isWsl: () => boolean
  getProviderUsage: (sessionFile: string, cwd: string, force?: boolean) => Promise<ProviderUsageSnapshot>
  hasLiveSessionWorker?: (sessionFile: string) => boolean
  getHistoryUsage?: (request: ProviderUsageRequest, signal: AbortSignal) => Promise<ProviderUsageSnapshot>
}

/** Prefer the exact bound worker; a detached history may use the readonly account path. */
export function createProviderUsageWorkerBridge(deps: ProviderUsageBridgeDependencies) {
  return async (request: ProviderUsageRequest): Promise<ProviderUsageSnapshot> => {
    let expired = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (isNonLocalUsageRequest(request) || deps.isWsl()) return unavailableUsage('remote-unsupported')
      // No implicit foreground session selection, even during startup or on unknown IDs.
      if (!request.sessionFile) return unavailableUsage('runtime-unavailable')
      const query = async () => {
        const authorized = await deps.authorize(request.workspaceId, request.sessionFile)
        if (expired) return unavailableUsage('timeout', 'error')
        if (!authorized.ok) return unavailableUsage('session-unavailable')
        if (isNonLocalUsageRequest({ workspaceId: authorized.cwd, sessionFile: authorized.sessionFile }) || deps.isWsl()) {
          return unavailableUsage('remote-unsupported')
        }
        if (deps.hasLiveSessionWorker && !deps.hasLiveSessionWorker(authorized.sessionFile) && deps.getHistoryUsage) {
          return deps.getHistoryUsage({ workspaceId: authorized.cwd, sessionFile: authorized.sessionFile, force: request.force }, controller.signal)
        }
        // Never retry a failed/racing live-worker query through another account resolver.
        return deps.getProviderUsage(authorized.sessionFile, authorized.cwd, request.force)
      }
      return await Promise.race([query(), new Promise<ProviderUsageSnapshot>((resolve) => {
        timer = setTimeout(() => { expired = true; controller.abort(); resolve(unavailableUsage('timeout', 'error')) }, 8000)
      })])
    } catch { return unavailableUsage('request-failed', 'error') }
    finally { if (timer) clearTimeout(timer) }
  }
}

let historyService: import('./service').ProviderUsageService | undefined
// Lazy imports keep handler construction safe, and cannot load host auth on remote queries.
export async function getWorkerProviderUsage(request: ProviderUsageRequest): Promise<ProviderUsageSnapshot> {
  if (isNonLocalUsageRequest(request)) return unavailableUsage('remote-unsupported')
  if (!request.sessionFile) return unavailableUsage('runtime-unavailable')
  try {
    const [{ authorizeTrustedSessionFile }, { workerManager }, { isWslRuntimeActive }] = await Promise.all([
      import('../trusted-workspace'), import('../worker-manager'), import('../wsl/runtime-config'),
    ])
    const getHistoryUsage = async (historyRequest: ProviderUsageRequest, signal: AbortSignal) => {
      if (!historyService) {
        const { createHistoryUsageService } = await import('./history-context')
        const { getSessionLeafOverride } = await import('../session-leaf-override')
        historyService = createHistoryUsageService({
          authorize: authorizeTrustedSessionFile, isWsl: isWslRuntimeActive,
          hasLiveSessionWorker: (file) => workerManager.hasLiveSessionWorker(file),
          getLeaf: getSessionLeafOverride,
          loadSdk: async () => {
            const [{ app }, { resolveActiveSdk }, { getActiveSdkModule }] = await Promise.all([
              import('electron'), import('../sdk-loader'), import('../ipc/sdk-session'),
            ])
            const userData = app.getPath('userData')
            const active = resolveActiveSdk(userData)
            if (active.fallbackReason) throw new Error('Unavailable selected SDK')
            return getActiveSdkModule(userData, active.kind === 'builtin' ? undefined : active.entryPath)
          },
        })
      }
      return historyService.get(historyRequest, signal)
    }
    return await createProviderUsageWorkerBridge({
      authorize: authorizeTrustedSessionFile,
      isWsl: isWslRuntimeActive,
      getProviderUsage: (sessionFile, cwd, force) => workerManager.getProviderUsage(sessionFile, cwd, force),
      hasLiveSessionWorker: (file) => workerManager.hasLiveSessionWorker(file),
      getHistoryUsage,
    })(request)
  } catch { return unavailableUsage('request-failed', 'error') }
}
