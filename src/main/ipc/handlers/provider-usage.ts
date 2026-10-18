import { registerHandler } from '../registry'
import type { ProviderUsageRequest, ProviderUsageSnapshot } from '@shared/provider-usage-types'
import { ProviderUsageService, unavailableUsage } from '../../provider-usage/service'
import type { ResolveViewedUsageContext } from '../../provider-usage/runtime'
import { getWorkerProviderUsage } from '../../provider-usage/worker-bridge'

export interface ProviderUsageDependencies {
  resolveViewedContext: ResolveViewedUsageContext
  fetch?: typeof fetch
  now?: () => number
}
export function createProviderUsageHandler(deps?: ProviderUsageDependencies): (request: unknown) => Promise<ProviderUsageSnapshot> {
  // Engine injection remains available for isolated tests; production uses the authorized bridge.
  const service = deps ? new ProviderUsageService(deps.resolveViewedContext, deps.fetch, deps.now) : undefined
  const get = service ? (request: ProviderUsageRequest) => service.get(request) : getWorkerProviderUsage
  return async (raw) => {
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return unavailableUsage('invalid-request')
    const request = (raw ?? {}) as Record<string, unknown>
    if (Object.keys(request).some((key) => !['workspaceId', 'sessionFile', 'force'].includes(key))
      || ['workspaceId', 'sessionFile'].some((key) => request[key] !== undefined && (typeof request[key] !== 'string' || (request[key] as string).length > 8192))
      || request.force !== undefined && typeof request.force !== 'boolean') return unavailableUsage('invalid-request')
    return get(request as ProviderUsageRequest)
  }
}
/** Production prefers a pinned existing worker, or resolves the exact detached local
 * history through the readonly account path. Parent owns allowlists and remote routing.
 */
export function registerProviderUsageHandlers(deps?: ProviderUsageDependencies): void {
  registerHandler('ipc:providerUsage.get', createProviderUsageHandler(deps))
}
