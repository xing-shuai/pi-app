import { createHmac, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { sessionFilePathsEqual } from '@shared/session-file-path'
import { isNonLocalUsageRequest, UsageFailure, type UsageModel, type UsageRuntime, type ResolveViewedUsageContext } from './runtime'
import { ProviderUsageService } from './service'

export type UsageSdk = Pick<typeof import('@earendil-works/pi-coding-agent'), 'ModelRuntime' | 'getAgentDir'>
export interface HistoryUsageDependencies {
  authorize: (cwd: string | undefined, file: string | undefined) => Promise<{ ok: true; cwd: string; sessionFile: string } | { ok: false; error: string }>
  isWsl: () => boolean
  hasLiveSessionWorker: (file: string) => boolean
  getLeaf: (file: string) => string | null | undefined
  loadSdk: () => Promise<UsageSdk>
  fetch?: typeof fetch
}

/** Bounded, read-only file access. Never SessionManager.open: it can migrate/rewrite history. */
async function readBounded(path: string, cap: number, optional = false): Promise<string> {
  let handle
  try {
    handle = await open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > cap) throw new UsageFailure('runtime-unavailable')
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== stat.size) throw new UsageFailure('account-changed')
    return buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'
    throw error
  } finally { await handle?.close() }
}

type Entry = {
  type?: string; id?: string; parentId?: string | null; version?: number; cwd?: string
  provider?: unknown; modelId?: unknown
  message?: { role?: unknown; provider?: unknown; model?: unknown }
}
/** The same active-branch model_change/assistant ordering used by SDK buildSessionContext.
 * Missing/legacy/ambiguous metadata is unavailable, never the desktop's default model. */
export function recordedUsageModel(raw: string, cwd: string, leaf: string | null | undefined): { provider: string; id: string } {
  const entries = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Entry)
  const header = entries.shift()
  if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string'
    || typeof header.cwd !== 'string' || !sessionFilePathsEqual(header.cwd, cwd)) throw new UsageFailure('session-unavailable')
  const index = new Map<string, Entry>()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || index.has(entry.id) || entry.type === 'session'
      || entry.parentId !== null && typeof entry.parentId !== 'string') throw new UsageFailure('session-unavailable')
    index.set(entry.id, entry)
  }
  let id = leaf === undefined ? entries.at(-1)?.id : leaf
  const visited = new Set<string>()
  let recorded: { provider: string; id: string } | undefined
  while (id) {
    const entry = index.get(id)
    if (!entry || visited.has(id)) throw new UsageFailure('session-unavailable')
    visited.add(id)
    const model = entry.type === 'model_change' ? { provider: entry.provider, id: entry.modelId }
      : entry.type === 'message' && entry.message?.role === 'assistant' ? { provider: entry.message.provider, id: entry.message.model } : undefined
    if (model && !recorded) {
      if (typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id) throw new UsageFailure('runtime-unavailable')
      recorded = { provider: model.provider, id: model.id }
    }
    id = entry.parentId
  }
  if (!recorded) throw new UsageFailure('runtime-unavailable')
  return recorded
}

function hasCommand(value: unknown): boolean {
  if (typeof value === 'string') return value.trimStart().startsWith('!')
  return !!value && typeof value === 'object' && Object.values(value).some(hasCommand)
}

/** Explicit detached-history account access only. No AgentSession, discovery, tools or turns.
 * Reauthorize and re-read history/config/auth on every service race guard. Runtime/cache keys
 * are process-salted and bounded; no account identifier or credential leaves this module. */
export function createHistoryUsageService(deps: HistoryUsageDependencies): ProviderUsageService {
  const salt = randomBytes(32)
  const hash = (value: string) => createHmac('sha256', salt).update(value).digest('hex')
  const sdkIds = new WeakMap<object, number>()
  let nextSdk = 0
  const runtimes = new Map<string, Promise<UsageRuntime & { getModel: (provider: string, id: string) => UsageModel | undefined }>>()
  const resolve: ResolveViewedUsageContext = async (request, signal) => {
    if (isNonLocalUsageRequest(request) || deps.isWsl()) return { kind: 'unavailable', reason: 'remote-unsupported' }
    if (!request.workspaceId || !request.sessionFile) return { kind: 'unavailable', reason: 'session-unavailable' }
    const authorized = await deps.authorize(request.workspaceId, request.sessionFile)
    signal.throwIfAborted()
    if (!authorized.ok) return { kind: 'unavailable', reason: 'session-unavailable' }
    if (isNonLocalUsageRequest({ workspaceId: authorized.cwd, sessionFile: authorized.sessionFile }) || deps.isWsl()) return { kind: 'unavailable', reason: 'remote-unsupported' }
    // A newly bound runtime invalidates a detached request; do not change account owner mid-query.
    if (deps.hasLiveSessionWorker(authorized.sessionFile)) return { kind: 'unavailable', reason: 'account-changed' }
    const leaf = deps.getLeaf(authorized.sessionFile)
    const raw = await readBounded(authorized.sessionFile, 32 * 1024 * 1024)
    const recorded = recordedUsageModel(raw, authorized.cwd, leaf)
    if (!['openai-codex', 'deepseek'].includes(recorded.provider)) return { kind: 'unavailable', reason: 'provider-unsupported' }
    const sdk = await deps.loadSdk()
    signal.throwIfAborted()
    const agentDir = sdk.getAgentDir()
    if (isNonLocalUsageRequest({ workspaceId: agentDir })) return { kind: 'unavailable', reason: 'remote-unsupported' }
    const modelsPath = join(agentDir, 'models.json')
    const [authRaw, modelsRaw] = await Promise.all([
      readBounded(join(agentDir, 'auth.json'), 1024 * 1024, true), readBounded(modelsPath, 1024 * 1024, true),
    ])
    // Commands are never executed by this account-only runtime (including model headers).
    const auth = JSON.parse(authRaw) as Record<string, Credential>
    const credential = Object.hasOwn(auth, recorded.provider) ? auth[recorded.provider] : undefined
    if (!credential || hasCommand(credential) || credential.type !== 'oauth' && credential.type !== 'api_key') return { kind: 'unavailable', reason: 'auth-unavailable' }
    // This readonly path intentionally does not resolve key commands/interpolation or
    // fall back to ambient credentials when the recorded provider's stored key is absent.
    if (credential.type === 'api_key' && (typeof credential.key !== 'string' || !credential.key.trim() || credential.key.trimStart().startsWith('$'))) return { kind: 'unavailable', reason: 'auth-unavailable' }
    if (credential.type === 'oauth' && (typeof credential.access !== 'string' || typeof credential.expires !== 'number'
      || !Number.isFinite(credential.expires) || credential.expires <= Date.now() + 300_000)) return { kind: 'unavailable', reason: 'auth-unavailable' }
    // Fail closed for command config rather than starting a shell to resolve quota credentials.
    for (const literal of modelsRaw.match(/"(?:\\.|[^"\\])*"/g) ?? []) {
      if (hasCommand(JSON.parse(literal))) return { kind: 'unavailable', reason: 'runtime-unavailable' }
    }
    if (!sdkIds.has(sdk)) sdkIds.set(sdk, ++nextSdk)
    const key = hash(JSON.stringify([sdkIds.get(sdk), agentDir, authRaw, modelsRaw, recorded.provider]))
    let pending = runtimes.get(key)
    if (!pending) {
      while (runtimes.size >= 32) runtimes.delete(runtimes.keys().next().value!)
      const readonly = async (): Promise<never> => { throw new UsageFailure('auth-unavailable') }
      const credentials: CredentialStore = {
        read: async (provider) => provider === recorded.provider ? structuredClone(credential) : undefined,
        list: async () => [{ providerId: recorded.provider, type: credential.type }],
        // Refuse BEFORE invoking the refresh callback: no OAuth network/writes either.
        modify: readonly, delete: readonly,
      }
      pending = sdk.ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false, refreshOnCreate: false, signal,
        modelsStore: { read: async () => undefined, write: readonly, delete: readonly },
      }).then((runtime) => {
        if (runtime.getError() || hasCommand(runtime.getRegisteredProviderConfig?.(recorded.provider))) throw new UsageFailure('runtime-unavailable')
        return runtime as unknown as UsageRuntime & { getModel: (provider: string, id: string) => UsageModel | undefined }
      })
      runtimes.set(key, pending)
      void pending.catch(() => { if (runtimes.get(key) === pending) runtimes.delete(key) })
    }
    const runtime = await pending
    signal.throwIfAborted()
    const model = runtime.getModel(recorded.provider, recorded.id)
    if (hasCommand(model)) return { kind: 'unavailable', reason: 'runtime-unavailable' }
    if (!model || model.provider !== recorded.provider || model.id !== recorded.id) return { kind: 'unavailable', reason: 'runtime-unavailable' }
    return { kind: 'local', runtimeId: key, viewKey: hash(JSON.stringify([authorized.sessionFile, authorized.cwd, leaf, raw])), model: { ...model }, runtime }
  }
  return new ProviderUsageService(resolve, deps.fetch)
}
