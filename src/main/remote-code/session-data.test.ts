// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sshProfileSchema } from '@shared/ssh-workspace'
import type { HostOperation } from '@shared/ssh-host-types'
import { RemoteCodeService, type HostTransport } from './service'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
async function setup() {
  const profile = sshProfileSchema.parse({ id: randomUUID(), name: 'Synthetic remote', host: 'test.invalid', cwd: '/' })
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-data-')); roots.push(dir)
  const calls: { op: HostOperation; args: Record<string, unknown> }[] = [], events: unknown[] = []
  let thinking = 'low'
  let blockStats: Promise<void> | undefined
  let onStats: (() => void) | undefined
  const transport: HostTransport = {
    hasActiveWork: false, connect: async () => {}, disconnect: () => {},
    getHostState: () => ({ home: '/remote', nodeVersion: 'v22', platform: 'linux', capabilities: { files: true, git: true, pty: false, sessions: true }, workspaces: [] }),
    requestHost: async (op, args) => {
      calls.push({ op, args })
      if (op === 'browse') return { path: '/remote/project', home: '/remote', entries: [] }
      if (op === 'workspace.register') return { id: 'ws', root: '/remote/project', name: 'project' }
      if (op === 'session.list') return { sessions: [{ sessionId: 'saved', sessionFile: '/private/saved.jsonl', title: 'Saved' }] }
      if (op === 'session.start') return { runtimeId: 'runtime', sessionId: 'saved', sessionFile: args.sessionFile, cwd: '/remote/project', isStreaming: false }
      if (op === 'session.rpc') {
        const q = args.command as { type: string; level?: string }
        let data: unknown = {}
        if (q.type === 'get_state') data = { sessionId: 'saved', sessionFile: '/private/saved.jsonl', model: { provider: 'deepseek', id: 'exact', contextWindow: 64000 }, thinkingLevel: thinking }
        if (q.type === 'get_available_models') data = { models: [{ provider: 'deepseek', id: 'exact', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' }, contextWindow: 64000, maxTokens: 1000 }] }
        if (q.type === 'get_available_thinking_levels') data = { levels: ['off', 'low', 'high'] }
        if (q.type === 'set_thinking_level') thinking = q.level === 'max' ? 'high' : q.level!
        if (q.type === 'get_session_stats') { onStats?.(); await blockStats; data = { sessionId: 'saved', sessionFile: '/private/saved.jsonl', tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 }, cost: 0.01, contextUsage: { tokens: 12000, contextWindow: 64000, percent: 18.75 } } }
        if (q.type === 'get_messages') data = { messages: [{ role: 'user', content: 'actual remote history' }] }
        if (q.type === 'desktop_provider_usage') data = { status: 'unavailable', reason: 'remote-unsupported', semantics: 'unavailable', windows: [], balances: [], stale: false, displayLabel: 'Remote' }
        return { success: true, data }
      }
      return { ok: true }
    },
  }
  const service = new RemoteCodeService({ metadataDirectory: dir, profiles: () => [profile], bootstrap: async () => 'synthetic', transport: () => transport, localSettings: () => ({ recentProjects: [], currentProject: null }), emit: (_, e) => events.push(e) })
  await service.connect({ profile })
  const prep = await service.prepareWorkspace(profile.id, '/remote/project')
  const { workspace } = await service.openWorkspace(profile.id, prep.path, prep.trustToken)
  const [session] = await service.listSessionCatalog(workspace.workspaceId)
  const identity = { workspaceId: workspace.workspaceId, sessionFile: session.sessionFile }
  const invoke = async (method: string, args = identity) => {
    const result = await service.route('ipc:' + method, args)
    if (!result.handled) throw new Error('local fallthrough')
    return result.value as any
  }
  return { service, profile, calls, events, identity, invoke, block: (p: Promise<void>, entered: () => void) => { blockStats = p; onStats = entered } }
}
describe('remote restored session data', () => {
  it('hydrates exact restored context/usage and real thinking capabilities without a model turn', async () => {
    const f = await setup()
    const result = await f.invoke('runtime.getState')
    expect(result.state).toMatchObject({ sessionFile: f.identity.sessionFile, model: 'deepseek/exact', thinkingLevel: 'low', availableThinkingLevels: ['off', 'low', 'high'], usage: { input: 10 }, contextUsage: { tokens: 12000, contextWindow: 64000 } })
    const context = await f.invoke('context.preview')
    expect(context.preview).toMatchObject({ sessionFile: f.identity.sessionFile, messageCount: 1, remoteContext: { model: 'deepseek/exact', contextUsage: { tokens: 12000, contextWindow: 64000 } } })
    const models = await f.invoke('model.list')
    expect(models.models[0]).toMatchObject({ reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } })
    const effective = await f.service.route('ipc:thinkingLevel.set', { ...f.identity, level: 'max' })
    expect(effective).toEqual({ handled: true, value: { level: 'high' } })
    expect(f.events.some((e: any) => e.availableThinkingLevels?.includes('max'))).toBe(false)
    expect(f.calls.filter(c => c.op === 'session.start')).toHaveLength(1)
    expect(f.calls.filter(c => c.op === 'session.rpc').every(c => !['prompt', 'steer', 'follow_up', 'bash'].includes((c.args.command as any).type))).toBe(true)
  })
  it('queries quota only through the exact restored remote runtime and never uses a default/utility conversation', async () => {
    const f = await setup()
    expect((await f.invoke('providerUsage.get', { workspaceId: f.identity.workspaceId } as any)).reason).toBe('session-unavailable')
    expect(f.calls.some(c => c.op === 'session.start')).toBe(false)
    expect((await f.invoke('providerUsage.get')).reason).toBe('remote-unsupported')
    expect(f.calls.filter(c => c.op === 'session.start')).toMatchObject([{ args: { sessionFile: '/private/saved.jsonl', utility: false } }])
    expect(f.calls.at(-1)?.args).toMatchObject({ runtimeId: 'runtime', command: { type: 'desktop_provider_usage' } })
    expect(await f.service.route('ipc:providerUsage.get', { workspaceId: '/local', sessionFile: '/local/s.jsonl' })).toEqual({ handled: false })
  })
  it('discards disconnected in-flight hydration instead of publishing old model/usage', async () => {
    const f = await setup()
    await f.invoke('runtime.getState')
    let release!: () => void
    let entered!: () => void
    const statsEntered = new Promise<void>(resolve => { entered = resolve })
    f.block(new Promise<void>(resolve => { release = resolve }), entered)
    const before = f.events.length
    const pending = f.invoke('runtime.getState')
    await statsEntered
    f.service.disconnect(f.profile.id, true)
    release()
    await expect(pending).rejects.toThrow()
    expect(f.events.slice(before).some((e: any) => e.usage || e.availableThinkingLevels)).toBe(false)
  })
})
