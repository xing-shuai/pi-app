import { randomUUID } from 'node:crypto'
import { sessionFilePathsEqual } from '@shared/session-file-path'
import type { ProviderUsageWorkerRequest, ProviderUsageWorkerResponse } from '@shared/worker-message'
import { ProviderUsageService, unavailableUsage } from '../../main/provider-usage/service'
import { isNonLocalUsageRequest, type UsageRuntime } from '../../main/provider-usage/runtime'
import { st } from '../worker-runtime.js'
import type { WorkerIncomingMessage } from '../worker-port-types.js'
import type { WorkerReply } from '../worker-handler-types.js'

// Audited Node-only engine: service -> node:crypto, normalizers, runtime, pure DTOs.
// No Electron/config imports, SDK creation, extension execution or separate auth storage.
const identities = new WeakMap<object, string>()
function identity(value: object): string {
  let id = identities.get(value)
  if (!id) { id = randomUUID(); identities.set(value, id) }
  return id
}

export function createWorkerProviderUsageService(fetcher?: typeof fetch): ProviderUsageService {
  return new ProviderUsageService(async (request) => {
    const session = st.session
    if (!session || st.runtime && st.runtime.session !== session
      || !request.sessionFile || !sessionFilePathsEqual(session.sessionFile, request.sessionFile)) {
      return { kind: 'unavailable', reason: 'session-unavailable' }
    }
    if (isNonLocalUsageRequest({ workspaceId: st.currentCwd, sessionFile: session.sessionFile })) {
      return { kind: 'unavailable', reason: 'remote-unsupported' }
    }
    if (!request.workspaceId || !sessionFilePathsEqual(st.currentCwd, request.workspaceId)) {
      return { kind: 'unavailable', reason: 'session-unavailable' }
    }
    const runtime = st.runtime?.services.modelRuntime ?? st.modelRuntime
    if (!runtime || typeof runtime.getAuth !== 'function' || !session.model) {
      return { kind: 'unavailable', reason: 'runtime-unavailable' }
    }
    return {
      kind: 'local', runtimeId: `${identity(runtime)}:${identity(session)}:${st.runtime ? identity(st.runtime) : ''}`,
      viewKey: JSON.stringify([st.currentCwd, session.sessionFile]),
      // Copy to pin model identity even if the SDK mutates its current model in-place.
      model: { ...session.model }, runtime: runtime as unknown as UsageRuntime,
    }
  }, fetcher)
}
const service = createWorkerProviderUsageService()

export async function handleGetProviderUsage(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  let snapshot
  try {
    if (Object.keys(msg).some((key) => !['type', 'requestId', 'sessionFile', 'cwd', 'force'].includes(key))
      || typeof msg.sessionFile !== 'string' || !msg.sessionFile || msg.sessionFile.length > 8192
      || typeof msg.cwd !== 'string' || !msg.cwd || msg.cwd.length > 8192
      || msg.force !== undefined && typeof msg.force !== 'boolean') {
      snapshot = unavailableUsage('invalid-request')
    } else {
      const request = msg as ProviderUsageWorkerRequest
      snapshot = await service.get({ sessionFile: request.sessionFile, workspaceId: request.cwd, force: request.force })
    }
  } catch { snapshot = unavailableUsage('request-failed', 'error') }
  const response: ProviderUsageWorkerResponse = { type: 'getProviderUsage-done', snapshot }
  reply(response)
}
