// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProviderUsageService } from './service'
import type { UsageRuntime } from './runtime'

it('resolves ordinary official OAuth through real bundled SDK 1.0.2 config in a temp HOME without cloud calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-usage-sdk-'))
  vi.stubEnv('HOME', dir)
  vi.stubEnv('PI_CODING_AGENT_DIR', dir)
  const denyCloud = vi.fn(() => { throw new Error('Unexpected network access') })
  vi.stubGlobal('fetch', denyCloud)
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access, refresh: 'synthetic-refresh-never-sent', expires: Date.now() + 86400000, accountId: 'synthetic-account' } }), { mode: 0o600 })
    await writeFile(join(dir, 'models.json'), '{}')
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false })
    const model = runtime.getModels('openai-codex')[0]
    expect(model).toBeDefined()
    const fetchUsage = vi.fn(async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000 } } })))
    const service = new ProviderUsageService(async () => ({ kind: 'local', runtimeId: 'sdk-test', viewKey: '/synthetic-session', runtime: runtime as unknown as UsageRuntime, model }), fetchUsage)
    expect(await service.get()).toMatchObject({ status: 'ready', windows: [{ usedPercent: 17, remainingPercent: 83 }] })
    expect(fetchUsage).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': 'synthetic-account' }) }))
    expect(denyCloud).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) }
}, 20000)
