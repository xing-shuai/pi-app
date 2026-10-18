/** Metadata only. SSH paths are opaque, fingerprint-scoped server-issued keys. */
export type SessionCatalogEntry = {
  key: string
  sessionId: string
  sessionFile: string
  workspaceId: string
  nativePathDisplay: string
  projectName: string
  title: string
  targetId: 'local' | `ssh:${string}`
  profileId?: string
  locationLabel: string
  status: 'idle' | 'busy' | 'needs-attention'
  updatedAt: number
  messageCount?: number
  firstMessage?: string
  hasUserMessages?: boolean
  readonly disconnected: boolean
}
export type SessionCatalogLocation = {
  targetId: SessionCatalogEntry['targetId']
  profileId?: string
  label: string
  workspaceId: string
  nativePathDisplay: string
  projectName: string
  disconnected: boolean
  error?: string
}
export type SessionCatalogRequest = { filter?: string; search?: string }
export type SessionCatalogResult = { sessions: SessionCatalogEntry[]; locations: SessionCatalogLocation[]; limited?: boolean }
export function filterSessionCatalog(entries: SessionCatalogEntry[], request: SessionCatalogRequest = {}, limit = 500): SessionCatalogEntry[] {
  const search = request.search?.trim().toLocaleLowerCase() || ''
  return entries.filter((entry) => {
    const scope = request.filter || 'all'
    return (scope === 'all' || (scope === 'ssh' ? entry.targetId.startsWith('ssh:') : entry.targetId === scope || entry.workspaceId === scope))
      && (!search || [entry.title, entry.firstMessage, entry.projectName, entry.nativePathDisplay, entry.locationLabel].some((value) => value?.toLocaleLowerCase().includes(search)))
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).slice(0, limit)
}
