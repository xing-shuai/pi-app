// @vitest-environment node
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { QuotaBridge } from './quota-bridge'
import { QUOTA_EXTENSION_SOURCE } from './quota-extension-source'
import { readJsonl } from './common'

it('queries the actual bundled CLI SDK through its private pipe without a model turn or real network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-real-cli-')), agent = join(root, 'agent'), cwd = join(root, 'project')
  await Promise.all([mkdir(agent), mkdir(cwd)])
  const file = join(root, 'history.jsonl'), ext = join(root, 'quota.mjs'), preload = join(root, 'deny-network.mjs'), calls = join(root, 'quota-calls'), debug = join(root, 'public-registry-status')
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'quota-fixture-session', cwd, timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 })
  await writeFile(join(agent, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: 'synthetic-fixture-only-key' } }), { mode: 0o600 })
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', models: [{ id: 'quota-custom-fixture', name: 'Custom fixture model', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1024 }] } } }))
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'quota-custom-fixture', defaultThinkingLevel: 'off', packages: [], extensions: [] }))
  await writeFile(ext, QUOTA_EXTENSION_SOURCE.replace('context = ctx; epoch++;', 'context = ctx; globalThis.__quotaFixtureDebug?.(ctx); epoch++;').replace('const agent = await agentDirectory();', 'const agent = await agentDirectory(); globalThis.__quotaFixtureDebug?.({pathOnly:true, agent});').replace('const credential = JSON.parse(authRaw)[p];', 'const credential = JSON.parse(authRaw)[p]; globalThis.__quotaFixtureDebug?.({credentialOnly:true, credential});').replace('await fetch(', 'await globalThis.__quotaFixtureFetch('), { mode: 0o600 })
  await writeFile(preload, `import {appendFileSync,writeFileSync} from 'node:fs'; const info={}; globalThis.__quotaFixtureDebug = ctx => { if(ctx.pathOnly) info.expectedAgent=ctx.agent===${JSON.stringify(agent)}; else if(ctx.credentialOnly) Object.assign(info,{credentialPresent:!!ctx.credential,credentialType:ctx.credential?.type,keyType:typeof ctx.credential?.key,keyLength:ctx.credential?.key?.length}); else Object.assign(info,{provider:ctx.model?.provider,api:ctx.model?.api,source:ctx.modelRegistry?.getProviderAuthStatus?.(ctx.model?.provider)?.source}); writeFileSync(${JSON.stringify(debug)}, JSON.stringify(info)); }; const fixtureFetch = async (url) => { if (String(url) !== 'https://api.deepseek.com/user/balance') throw new Error('Network forbidden in quota CLI fixture'); appendFileSync(${JSON.stringify(calls)}, 'quota\\n'); return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'12.30',granted_balance:'2.00',topped_up_balance:'10.30'}]}); }; globalThis.__quotaFixtureFetch=fixtureFetch; Object.defineProperty(globalThis,'fetch',{configurable:false,get:()=>fixtureFetch,set:()=>{}});`)
  const nonce = 'a'.repeat(64)
  const child = spawn(process.execPath, ['--import', preload, resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '--mode', 'rpc', '--session', file, '--approve', '--offline', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--extension', ext], {
    cwd, env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_DESKTOP_QUOTA_NONCE: nonce, PATH: dirname(process.execPath) + ':/usr/bin:/bin', SHELL: '/bin/sh' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const pipe = child.stdio[3] as Duplex, bridge = new QuotaBridge(pipe, nonce)
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  let diagnostics = ''
  child.stderr?.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-6000) }) // Synthetic fixture only.
  let stop = () => {}
  try {
    const state = await new Promise<Record<string, unknown>>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture CLI state timeout')), 12000)
      stop = readJsonl(child.stdout!, (record) => { if (record.id === 'state') { clearTimeout(timer); record.success ? done(record.data) : reject(new Error('Fixture CLI state rejected')) } }, () => { clearTimeout(timer); reject(new Error('Fixture CLI invalid protocol')) }, true)
      child.stdin!.write(JSON.stringify({ type: 'get_state', id: 'state' }) + '\n')
    })
    // A model-only custom catalog must not be mistaken for a credential override.
    expect(state.model).toMatchObject({ provider: 'deepseek', id: 'quota-custom-fixture' })
    const before = await readFile(file, 'utf8')
    const result = await bridge.query(String(state.sessionId), String(state.sessionFile))
    expect(result.status, `phase=${result.reason || 'ready'}; registry=${await readFile(debug, 'utf8').catch(() => 'not-started')}; fixture CLI: ${diagnostics.replaceAll(root, '[fixture]').replaceAll('synthetic-fixture-only-key', '[redacted]')}`).toBe('ready')
    expect(result).toMatchObject({ status: 'ready', provider: 'deepseek', balances: [{ currency: 'USD', amount: '12.30', kind: 'total' }, { currency: 'USD', amount: '2.00', kind: 'granted' }, { currency: 'USD', amount: '10.30', kind: 'topped-up' }] })
    expect(await readFile(calls, 'utf8')).toBe('quota\n')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(JSON.stringify(result)).not.toContain('synthetic-fixture-only-key')
  } finally {
    stop(); bridge.close(); child.stdin?.end()
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500)
    await closed; clearTimeout(kill)
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
