import { describe, expect, it, vi } from 'vitest'
import type { SessionCatalogEntry } from '@shared/session-catalog-types'
import { filterSessionCatalog } from '@shared/session-catalog-types'
import { SessionCatalog, type CatalogSource } from './catalog'
const entry = (key: string, targetId: SessionCatalogEntry['targetId'], updatedAt: number): SessionCatalogEntry => ({ key, sessionId: 'same', sessionFile: key, workspaceId: `${targetId}/workspace`, nativePathDisplay: '/same/path', title: 'A real conversation', projectName: 'project', locationLabel: targetId, targetId, status: 'idle', updatedAt, disconnected: false })
describe('metadata session catalog', () => {
  it('keeps native and two same-path SSH hosts distinct, sorts and filters', () => {
    const rows = [entry('native', 'local', 1), entry('host-a', 'ssh:a', 3), entry('host-b', 'ssh:b', 2)]
    expect(filterSessionCatalog(rows).map((row) => row.key)).toEqual(['host-a', 'host-b', 'native'])
    expect(filterSessionCatalog(rows, { filter: 'ssh' })).toHaveLength(2)
    expect(filterSessionCatalog(rows, { filter: 'ssh:b', search: 'PROJECT' }).map((row) => row.key)).toEqual(['host-b'])
    expect(filterSessionCatalog(rows, { filter: 'local', search: 'missing' })).toEqual([])
  })
  it('applies filter/search before the 500-row cap, and keeps SSH source slots among many Local roots', async () => {
    const location = (id: string, targetId: SessionCatalogEntry['targetId']) => ({ targetId, label: targetId, workspaceId: id, nativePathDisplay: id, projectName: id, disconnected: false })
    const localRows = Array.from({ length: 500 }, (_, index) => entry(`local-${index}`, 'local', index + 10))
    const ssh = { ...entry('old-ssh', 'ssh:a', 1), title: 'Unique old remote history' }
    const catalog = new SessionCatalog(async () => [{ location: location('local', 'local'), list: async () => localRows }, { location: location('ssh', 'ssh:a'), list: async () => [ssh] }])
    expect((await catalog.list()).limited).toBe(true)
    expect((await catalog.list({ filter: 'ssh' })).sessions).toEqual([ssh])
    expect((await catalog.list({ search: 'Unique old' })).sessions).toEqual([ssh])
    const many = new SessionCatalog(async () => [...Array.from({ length: 500 }, (_, index) => ({ location: location(`local-${index}`, 'local'), list: async () => [] })), { location: location('ssh', 'ssh:a'), list: async () => [ssh] }])
    expect((await many.list()).sessions).toEqual([ssh])
    expect((await many.list({ filter: 'ssh' })).sessions).toEqual([ssh])
  })
  it('shares in-flight refresh, bounds concurrency to two, returns partial failures and at most 500', async () => {
    let active = 0, peak = 0
    const sources: CatalogSource[] = Array.from({ length: 5 }, (_, index) => ({
      location: { targetId: 'local', label: 'Local', workspaceId: String(index), nativePathDisplay: '/known', projectName: 'known', disconnected: false },
      list: async () => {
        active++; peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1)); active--
        if (index === 2) throw new Error('missing root')
        return Array.from({ length: 300 }, (_, row) => entry(`${index}:${row}`, 'local', row))
      },
    }))
    const getSources = vi.fn(async () => sources)
    const catalog = new SessionCatalog(getSources)
    const [a, b] = await Promise.all([catalog.list(), catalog.list()])
    expect(getSources).toHaveBeenCalledOnce(); expect(peak).toBe(2)
    expect(a.sessions).toHaveLength(500); expect(b.sessions).toHaveLength(500)
    expect(a.locations[2].error).toBeDefined()
    expect(a.locations[0].error).toBeUndefined()
  })
})
