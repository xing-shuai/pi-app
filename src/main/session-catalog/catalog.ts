import type { SessionCatalogEntry, SessionCatalogLocation, SessionCatalogRequest, SessionCatalogResult } from '@shared/session-catalog-types'
import { filterSessionCatalog } from '@shared/session-catalog-types'

export type CatalogSource = { location: SessionCatalogLocation; list: () => Promise<SessionCatalogEntry[]> }
function matches(source: CatalogSource, filter = 'all'): boolean {
  return filter === 'all' || (filter === 'ssh' ? source.location.targetId.startsWith('ssh:') : source.location.targetId === filter || source.location.workspaceId === filter)
}
/** One busy Local target cannot consume every source slot before SSH is considered. */
function balanced(sources: CatalogSource[]): CatalogSource[] {
  const groups = new Map<string, CatalogSource[]>()
  for (const source of sources) { const group = groups.get(source.location.targetId) || []; group.push(source); groups.set(source.location.targetId, group) }
  const result: CatalogSource[] = []
  for (let index = 0; result.length < 500; index++) {
    let added = false
    for (const group of groups.values()) if (group[index] && result.length < 500) { result.push(group[index]); added = true }
    if (!added) break
  }
  return result
}
/** Serialize differing queries and share identical in-flight refreshes: at most two sources run. */
export class SessionCatalog {
  private pending?: { key: string; promise: Promise<SessionCatalogResult> }
  constructor(private sources: () => Promise<CatalogSource[]>) {}
  async list(request: SessionCatalogRequest = {}): Promise<SessionCatalogResult> {
    const query = { filter: request.filter || 'all', search: request.search?.trim() || '' }, key = JSON.stringify(query)
    for (;;) {
      if (this.pending?.key === key) return this.pending.promise
      if (this.pending) { await this.pending.promise.catch(() => {}); continue }
      const promise = this.collect(query), pending = { key, promise }
      this.pending = pending
      void promise.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => {})
      return promise
    }
  }
  private async collect(request: SessionCatalogRequest): Promise<SessionCatalogResult> {
    const all = await this.sources(), matching = all.filter((source) => matches(source, request.filter)), sources = balanced(matching)
    const locations = [...new Map([...balanced(all), ...sources].map((source) => [source.location.workspaceId, { ...source.location }])).values()]
    let entries: SessionCatalogEntry[] = [], limited = matching.length > sources.length, next = 0
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < sources.length) {
        const source = sources[next++]
        try {
          const rows = await source.list()
          const matched = filterSessionCatalog([...new Map([...entries, ...rows.slice(0, 500)].map((entry) => [entry.key, entry])).values()], request, 501)
          if (matched.length > 500) limited = true
          entries = matched.slice(0, 500)
        } catch { const location = locations.find((item) => item.workspaceId === source.location.workspaceId); if (location) location.error = 'Session metadata unavailable' }
      }
    }))
    return { locations, sessions: entries, ...(limited ? { limited: true } : {}) }
  }
}
