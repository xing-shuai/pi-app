import type { ModelInfo } from '@shared/ipc-contract'
import { ipcClient } from '@renderer/lib/ipc-client'
import { modelLoadFailure } from './model-load-error'

let snapshot: ModelInfo[] = []
let inFlight: { generation: number; promise: Promise<ModelInfo[]> } | null = null
let generation = 0
let invalidated = true
let lastError: string | null = null
const listeners = new Set<(models: ModelInfo[]) => void>()

/**
 * Right after a cold start neither the worker's model runtime nor the preview process may be
 * ready, and the main side reports that as an empty list (or a failure). An empty snapshot is
 * therefore never treated as settled: it is retried a few times on its own.
 */
const EMPTY_RETRY_DELAYS_MS = [800, 2000, 4000, 8000]
let emptyRetries = 0
let emptyRetryTimer: ReturnType<typeof setTimeout> | null = null

function clearEmptyRetry(): void {
  if (emptyRetryTimer !== null) clearTimeout(emptyRetryTimer)
  emptyRetryTimer = null
}

function scheduleEmptyRetry(): void {
  if (emptyRetryTimer !== null || emptyRetries >= EMPTY_RETRY_DELAYS_MS.length) return
  emptyRetryTimer = setTimeout(() => {
    emptyRetryTimer = null
    if (snapshot.length > 0) return
    void refreshAvailableModels().catch(() => {})
  }, EMPTY_RETRY_DELAYS_MS[emptyRetries++])
}

export function peekAvailableModels(): ModelInfo[] {
  return snapshot
}
export function peekAvailableModelsError(): string | null { return lastError }

/** True while a request is in flight or an empty list is about to be retried. */
export function isAvailableModelsPending(): boolean {
  return inFlight !== null || emptyRetryTimer !== null
}

export function subscribeAvailableModels(listener: (models: ModelInfo[]) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function refreshAvailableModels(): Promise<ModelInfo[]> {
  const requestGeneration = generation
  if (inFlight?.generation === requestGeneration) return inFlight.promise
  invalidated = false
  const invokeResult = ipcClient.invoke('model.list', { scope: 'available' })
  const promise = (invokeResult && typeof (invokeResult as PromiseLike<unknown>).then === 'function'
    ? Promise.resolve(invokeResult)
    : Promise.resolve({ models: snapshot }))
    .then((res) => {
      if (inFlight?.promise === promise) inFlight = null
      if (requestGeneration !== generation) return snapshot
      lastError = null
      snapshot = Array.isArray(res?.models) ? res.models : []
      if (snapshot.length > 0) {
        emptyRetries = 0
        clearEmptyRetry()
      } else {
        invalidated = true
        scheduleEmptyRetry()
      }
      for (const listener of listeners) listener(snapshot)
      return snapshot
    })
    .catch((error) => {
      if (inFlight?.promise === promise) inFlight = null
      if (requestGeneration === generation) {
        invalidated = true
        const failure = modelLoadFailure(error)
        lastError = failure.message
        if (failure.permanent) clearEmptyRetry()
        else if (snapshot.length === 0) scheduleEmptyRetry()
        // Same snapshot, but the pending state changed.
        for (const listener of listeners) listener(snapshot)
      }
      throw error
    })
  inFlight = { generation: requestGeneration, promise }
  return promise
}

export function ensureAvailableModels(): Promise<ModelInfo[]> {
  if (!invalidated && snapshot.length > 0) return Promise.resolve(snapshot)
  return refreshAvailableModels()
}

/**
 * Full SDK catalog, fetched at most once per model-config generation. Only needed for lookups
 * the available list cannot answer (e.g. a session pinned to a catalog-only model).
 */
let catalog: { generation: number; promise: Promise<ModelInfo[]> } | null = null

export function ensureCatalogModels(): Promise<ModelInfo[]> {
  if (catalog?.generation === generation) return catalog.promise
  const requestGeneration = generation
  const promise: Promise<ModelInfo[]> = Promise.resolve(ipcClient.invoke('model.list', { scope: 'catalog' }))
    .then((res) => (Array.isArray(res?.models) ? (res.models as ModelInfo[]) : []))
    .catch(() => {
      if (catalog?.promise === promise) catalog = null
      return []
    })
  catalog = { generation: requestGeneration, promise }
  return promise
}

export function invalidateAvailableModels(): void {
  generation += 1
  invalidated = true
  lastError = null
  emptyRetries = 0
  clearEmptyRetry()
}

/** A host switch is a security/data boundary, not a refresh of the same provider runtime. */
export function resetAvailableModelsForEnvironment(): void {
  invalidateAvailableModels()
  snapshot = []
  catalog = null
  for (const listener of listeners) listener(snapshot)
}

export function prefetchAvailableModels(): void {
  void ensureAvailableModels().catch(() => {})
}

export function clearAvailableModelsCacheForTests(): void {
  snapshot = []
  inFlight = null
  generation = 0
  invalidated = true
  lastError = null
  catalog = null
  emptyRetries = 0
  clearEmptyRetry()
  listeners.clear()
}
