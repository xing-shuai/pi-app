import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession, CreateAgentSessionOptions, ModelRuntime, SessionEntry } from '@earendil-works/pi-coding-agent'
import { chatHistory, chatResourceLoader, createChatBackend, createIsolatedChatSession, hostChatAgentDir, wrapChatSession } from './sdk'
import type { ChatSdk } from './sdk'
import { ChatStore } from './store'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'chat-sdk-')); dirs.push(dir); return dir }

describe('Chat SDK boundary', () => {
  it('selects the host agent directory, irrespective of Code/WSL configuration', () => {
    expect(hostChatAgentDir({ PI_CODING_AGENT_DIR: '~/host-agent' }, '/home/test')).toBe('/home/test/host-agent')
    expect(hostChatAgentDir({}, '/home/test')).toBe('/home/test/.pi/agent')
  })
  it('lazy-loads only on demand and reads host auth/models explicitly', async () => {
    const runtime = { getAvailable: vi.fn(async () => [{ provider: 'p', id: 'vendor/id', name: 'Name' }]) }
    const create = vi.fn(async () => runtime)
    const load = vi.fn(async () => ({ ModelRuntime: { create } }) as unknown as ChatSdk)
    const backend = createChatBackend(load, '/host/agent')
    expect(load).not.toHaveBeenCalled()
    expect(await backend.models()).toEqual([{ id: 'vendor/id', provider: 'p', name: 'Name', reasoning: false, thinkingLevels: ['off'] }])
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ authPath: '/host/agent/auth.json', modelsPath: '/host/agent/models.json', allowModelNetwork: false }))
    await backend.models()
    expect(load).toHaveBeenCalledOnce()
  })
  it('uses SDK model capabilities for metadata, including explicit exclusions and opt-in extended levels', async () => {
    const plain = { provider: 'p', id: 'plain', name: 'Plain', reasoning: false }
    const reasoning = { provider: 'p', id: 'reasoning', name: 'Reasoning', reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: null } }
    const extended = { provider: 'p', id: 'extended', name: 'Extended', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }
    const runtime = { getAvailable: vi.fn(async () => [plain, reasoning, extended]), getModel: vi.fn((_provider, id) => [plain, reasoning, extended].find((model) => model.id === id)) }
    const backend = createChatBackend(async () => ({ ModelRuntime: { create: async () => runtime } }) as unknown as ChatSdk, '/host/agent')
    expect(await backend.models()).toEqual([
      { ...plain, thinkingLevels: ['off'] },
      { id: 'reasoning', provider: 'p', name: 'Reasoning', reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] },
      { id: 'extended', provider: 'p', name: 'Extended', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ])
    expect(await backend.thinkingLevels('p/plain')).toEqual(['off'])
    expect(await backend.thinkingLevels('p/reasoning')).not.toContain('max')
    await expect(backend.thinkingLevels('p/missing')).rejects.toThrow('CHAT_MODEL_UNAVAILABLE')
    backend.dispose?.()
  })
  it('uses a trusted ResourceLoader, in-memory settings and an empty tool allowlist', async () => {
    const dir = await temp()
    const record = await new ChatStore(dir).create({ model: 'provider/vendor/model' })
    const session = { getActiveToolNames: () => [], agent: { state: { tools: [] } }, dispose: vi.fn() }
    let options!: CreateAgentSessionOptions
    const settings = { marker: 'memory' }
    const sdk = {
      createExtensionRuntime: vi.fn(() => ({})),
      SettingsManager: { inMemory: vi.fn(() => settings) },
      SessionManager: { open: vi.fn(() => ({})) },
      createAgentSession: vi.fn(async (input) => { options = input; return { session } }),
    } as unknown as ChatSdk
    const getModel = vi.fn(() => ({ provider: 'provider', id: 'vendor/model' }))
    await createIsolatedChatSession(sdk, { getModel } as unknown as ModelRuntime, record, '/host/agent')
    expect(getModel).toHaveBeenCalledWith('provider', 'vendor/model')
    expect(options).toMatchObject({ noTools: 'all', tools: [], customTools: [], settingsManager: settings, cwd: record.cwd, agentDir: '/host/agent', thinkingLevel: 'off' })
    expect(sdk.SessionManager.open).toHaveBeenCalledWith(record.sessionFile, record.cwd, record.cwd)
    expect(sdk.SettingsManager.inMemory).toHaveBeenCalledWith(expect.objectContaining({ defaultTools: [], packages: [], extensions: [], skills: [], prompts: [] }))
    const loader = options.resourceLoader!
    await loader.reload()
    loader.extendResources({ skillPaths: [{ path: '/untrusted', metadata: {} as never }] })
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
    expect(loader.getExtensions().extensions).toEqual([])
    expect(loader.getPrompts().prompts).toEqual([])
    expect(loader.getSkills().skills).toEqual([])
    expect(loader.getThemes().themes).toEqual([])
    expect(loader.getSystemPromptSource()).toBeUndefined()
    expect(loader.getAppendSystemPrompt()).toEqual([])
    session.getActiveToolNames = () => ['bash'] as never[]
    await expect(createIsolatedChatSession(sdk, { getModel } as unknown as ModelRuntime, record, '/host/agent')).rejects.toThrow('CHAT_TOOL_POLICY_VIOLATION')
    expect(session.dispose).toHaveBeenCalledOnce()
  })
  it('passes actual ImageContent options and disables prompt/skill/extension command dispatch', async () => {
    const prompt = vi.fn(async () => {})
    const session = {
      sessionManager: { getBranch: () => [] },
      agent: { state: { tools: [] }, streamFunction: vi.fn() },
      getActiveToolNames: () => [], prompt, abort: vi.fn(async () => {}), dispose: vi.fn(),
    } as unknown as AgentSession
    const runtime = wrapChatSession(session)
    const image = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    await runtime.prompt('/skill:untrusted', [image])
    expect(prompt).toHaveBeenCalledWith('/skill:untrusted', { expandPromptTemplates: false, images: [{ type: 'image', ...image }] })
    await runtime.abort()
    expect(() => session.agent.streamFunction({} as never, {} as never)).toThrow('CHAT_ABORTED')
    runtime.dispose()
  })
  it('reconstructs only user and assistant text; excludes thinking, tools, system prompts and errors', () => {
    const entries = [
      { id: 'system', type: 'message', message: { role: 'system', content: 'private' } },
      { id: 'user', type: 'message', message: { role: 'user', content: 'Hello' } },
      { id: 'assistant', type: 'message', message: { role: 'assistant', errorMessage: 'secret', content: [{ type: 'thinking', thinking: 'private' }, { type: 'toolCall', name: 'bash' }, { type: 'text', text: 'Answer' }] } },
      { id: 'tool', type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'private' }] } },
    ] as unknown as SessionEntry[]
    expect(chatHistory(entries)).toEqual([{ id: 'user', role: 'user', text: 'Hello' }, { id: 'assistant', role: 'assistant', text: 'Answer' }])
  })
})

describe('actual bundled SDK isolation policy', () => {
  it('streams a real SDK turn through a local fake provider and durably restores it with no declared tools', async () => {
    const { createServer } = await import('node:http')
    const requests: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      chunk({ role: 'assistant', content: 'Hello ' })
      chunk({ content: 'from Chat' })
      chunk({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const dir = await temp()
    const agentDir = join(dir, 'agent')
    await mkdir(agentDir)
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'dummy', models: [{ id: 'test', input: ['text', 'image'], reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: null } }] } } }))
    const store = new ChatStore(dir)
    const record = await store.create({ model: 'local/test', thinkingLevel: 'high' })
    const sdk = await import('@earendil-works/pi-coding-agent')
    const backend = createChatBackend(async () => sdk, agentDir)
    const runtime = await backend.open(record)
    const events: unknown[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))
    try {
      await runtime.prompt('Say hello', [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=' }])
      expect(requests).toHaveLength(1)
      expect(requests[0].tools ?? []).toEqual([])
      expect(requests[0].reasoning_effort).toBe('high')
      expect(runtime.thinkingLevel).toBe('high')
      expect(runtime.thinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
      expect(() => runtime.setThinkingLevel('max')).toThrow('CHAT_THINKING_UNSUPPORTED')
      expect(runtime.setThinkingLevel('low')).toBe('low')
      await store.update(record.id, (stored) => { stored.thinkingLevel = 'low'; stored.effectiveThinkingLevel = 'low' })
      expect(JSON.stringify(requests[0].messages)).toContain('data:image/png;base64,')
      expect(runtime.history()[0].images).toHaveLength(1)
      expect(runtime.history().map((message) => message.text)).toEqual(['Say hello', 'Hello from Chat'])
      expect(events).toContainEqual(expect.objectContaining({ kind: 'delta', delta: expect.stringContaining('Hello') }))
      await runtime.prompt('Follow up')
      expect(requests).toHaveLength(2)
      expect(requests[1].reasoning_effort).toBe('low')
    } finally {
      unsubscribe()
      runtime.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    const restored = await backend.open(await store.get(record.id))
    try {
      expect(restored.thinkingLevel).toBe('low')
      expect(restored.history().map((message) => message.text)).toEqual(['Say hello', 'Hello from Chat', 'Follow up', 'Hello from Chat'])
      expect(await readFile(record.sessionFile, 'utf8')).toContain('"thinkingLevel":"low"')
    } finally { restored.dispose(); backend.dispose?.() }
  }, 30_000)

  it('does not execute poisoned global/project extensions, MCP, packages, prompts, skills, or context files; restores SDK JSONL', async () => {
    const dir = await temp()
    const agentDir = join(dir, 'host-agent')
    const store = new ChatStore(dir)
    const record = await store.create({ model: 'chat-test/test' })
    const marker = join(dir, 'EXECUTED')
    for (const root of [agentDir, join(record.cwd, '.pi')]) {
      for (const resource of ['extensions', 'skills/poison', 'prompts']) await mkdir(join(root, resource), { recursive: true })
      await writeFile(join(root, 'extensions/poison.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('POISON_EXTENSION')`)
      await writeFile(join(root, 'settings.json'), JSON.stringify({ packages: ['npm:DO_NOT_INSTALL'], defaultTools: ['bash'], extensions: ['./extensions/poison.js'] }))
      await writeFile(join(root, 'SYSTEM.md'), 'POISON_SYSTEM')
      await writeFile(join(root, 'APPEND_SYSTEM.md'), 'POISON_APPEND')
      await writeFile(join(root, 'AGENTS.md'), 'POISON_AGENTS')
      await writeFile(join(root, 'skills/poison/SKILL.md'), '---\nname: poison\ndescription: POISON_SKILL\n---\nPOISON_SKILL')
      await writeFile(join(root, 'prompts/poison.md'), 'POISON_PROMPT')
      await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { poison: { command: 'DO_NOT_EXECUTE' } } }))
    }
    await writeFile(join(dir, 'AGENTS.md'), 'POISON_ANCESTOR')
    await writeFile(join(record.cwd, 'AGENTS.md'), 'POISON_PROJECT_CONTEXT')
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'chat-test': { type: 'api_key', key: 'dummy-local-key' } }))
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'chat-test': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'dummy', models: [{ id: 'test', name: 'Test' }] } } }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false })
    const session = await createIsolatedChatSession(sdk, modelRuntime, record, agentDir)
    try {
      expect(session.getActiveToolNames()).toEqual([])
      expect(session.agent.state.tools).toEqual([])
      expect(session.systemPrompt).not.toContain('POISON')
      session.setActiveToolsByName(['bash', 'read'])
      expect(session.getActiveToolNames()).toEqual([])
      session.sessionManager.appendMessage({ role: 'user', content: 'Durable text', timestamp: Date.now() })
      const loader = chatResourceLoader(sdk)
      expect(loader.getExtensions().extensions).toEqual([])
      expect(await readFile(marker, 'utf8').catch(() => 'not executed')).toBe('not executed')
    } finally { session.dispose() }
    const restored = await createIsolatedChatSession(sdk, modelRuntime, record, agentDir)
    try { expect(chatHistory(restored.sessionManager.getBranch()).map((message) => message.text)).toEqual(['Durable text']) } finally { restored.dispose() }
    expect(await readFile(record.sessionFile, 'utf8')).toContain('Durable text')
  }, 30_000)
})
