import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'
import type { Routine, RoutineRun } from '../../../packages/shared/routine-types'
import { createSdkRoutineExecutor, hostAgentDirectory, splitRoutineModel } from './executor'

type Sdk = typeof import('@earendil-works/pi-coding-agent')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'routine-executor-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'host-agent'))
  mkdirSync(hostAgentDirectory(), { recursive: true })
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve() }
function fixture() {
  let options!: CreateAgentSessionOptions
  let listener: (event: unknown) => void = () => {}
  const session = {
    sessionFile: undefined as string | undefined,
    subscribe: vi.fn((fn: typeof listener) => { listener = fn; return vi.fn() }),
    prompt: vi.fn(async () => {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'result' } })
      listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    }),
    abort: vi.fn(async () => {}), waitForIdle: vi.fn(async () => {}), dispose: vi.fn(),
  }
  const modelRuntime = { getModel: vi.fn(() => ({ id: 'test' })), getAvailable: vi.fn(async () => [{ id: 'available' }]) }
  const sdk = {
    createExtensionRuntime: vi.fn(() => ({})),
    ModelRuntime: { create: vi.fn(async () => modelRuntime) },
    SettingsManager: { inMemory: vi.fn((settings) => settings) },
    SessionManager: { create: vi.fn((_cwd, sessionDir: string) => {
      session.sessionFile = join(sessionDir, 'internal-session.jsonl')
      writeFileSync(session.sessionFile, 'private session')
      return {}
    }) },
    createAgentSession: vi.fn(async (input: CreateAgentSessionOptions) => { options = input; return { session } }),
  }
  const loadSdk = vi.fn(async () => sdk as unknown as Sdk)
  const executor = createSdkRoutineExecutor(dir, loadSdk)
  const routine: Routine = { id: 'routine', name: 'Saved', description: '', prompt: 'Task', enabled: true, schedule: { type: 'manual' },
    surface: 'chat', permissionMode: 'read-only', createdAt: 1, updatedAt: 1, model: 'openrouter/anthropic/claude' }
  const run: RoutineRun = { id: 'server-generated-run', routineId: routine.id, status: 'running', output: '', scheduledAt: 1 }
  const controller = new AbortController()
  const onOutput = vi.fn(), onSessionFile = vi.fn()
  const execute = (patch: Partial<Routine> = {}) => executor({ routine: { ...routine, ...patch }, run,
    signal: controller.signal, onOutput, onSessionFile })
  return { execute, loadSdk, controller, sdk, session, modelRuntime, onOutput, onSessionFile, getOptions: () => options }
}

describe('isolated SDK routine executor', () => {
  it('lazily imports the SDK, gives Chat zero tools, and disables all discovery/retries', async () => {
    writeFileSync(join(hostAgentDirectory(), 'settings.json'), JSON.stringify({ defaultProvider: 'host', defaultModel: 'saved',
      extensions: ['/tmp/evil.ts'], packages: ['evil'], shellCommandPrefix: 'evil', sessionDir: '/tmp/evil', retry: { enabled: true } }))
    const f = fixture()
    expect(f.loadSdk).not.toHaveBeenCalled()
    await f.execute()
    const options = f.getOptions()
    expect(options.noTools).toBe('all'); expect(options.tools).toEqual([])
    expect(options.customTools).toEqual([])
    expect(options.agentDir).toBe(join(dir, 'routine-runs', 'server-generated-run', 'agent'))
    expect(options.cwd).toBe(join(dir, 'routine-runs', 'server-generated-run'))
    expect(options.settingsManager).toEqual(expect.objectContaining({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off' }))
    expect(f.modelRuntime.getModel).toHaveBeenCalledWith('openrouter', 'anthropic/claude')
    expect(f.sdk.ModelRuntime.create).toHaveBeenCalledWith(expect.objectContaining({
      authPath: join(hostAgentDirectory(), 'auth.json'), modelsPath: join(hostAgentDirectory(), 'models.json'), allowModelNetwork: false,
    }))
    const resources = options.resourceLoader!
    expect(resources.getExtensions().extensions).toEqual([])
    expect(resources.getAgentsFiles().agentsFiles).toEqual([])
    expect(resources.getSkills().skills).toEqual([])
    expect(resources.getPrompts().prompts).toEqual([])
    expect(resources.getThemes().themes).toEqual([])
    expect(resources.getAppendSystemPrompt()).toEqual([])
    expect(resources.getSystemPrompt()).toContain('zero tools')
    await resources.reload()
    expect(f.session.prompt).toHaveBeenCalledWith('Task', { expandPromptTemplates: false })
    expect(f.onOutput).toHaveBeenCalledWith('result')
    expect(f.onSessionFile).toHaveBeenCalledWith(join(dir, 'routine-runs', 'server-generated-run', 'internal-session.jsonl'))
    expect(f.session.dispose).toHaveBeenCalledOnce()
    if (process.platform !== 'win32') expect(statSync(f.session.sessionFile!).mode & 0o777).toBe(0o600)
  })
  it('gives opted-in Chat only the weather custom tool, never builtins or discovered resources', async () => {
    const f = fixture(); await f.execute({ onlineWeather: true })
    expect(f.getOptions().tools).toEqual(['weather'])
    expect(f.getOptions().noTools).toBe('builtin')
    expect(f.getOptions().customTools?.map((tool) => tool.name)).toEqual(['weather'])
    expect(f.getOptions().resourceLoader!.getSystemPrompt()).toContain('explicitly authorized')
    expect(f.getOptions().resourceLoader!.getExtensions().extensions).toEqual([])
    expect(f.getOptions().resourceLoader!.getSkills().skills).toEqual([])
    expect(f.getOptions().resourceLoader!.getAgentsFiles().agentsFiles).toEqual([])
  })
  it('explicitly false keeps Chat tool-free regardless of weather instructions', async () => {
    const f = fixture(); await f.execute({ onlineWeather: false, prompt: 'latest Hangzhou weather' })
    expect(f.getOptions().tools).toEqual([])
    expect(f.getOptions().customTools).toEqual([])
  })
  it('uses only model defaults from host settings when selection is omitted', async () => {
    writeFileSync(join(hostAgentDirectory(), 'settings.json'), JSON.stringify({ defaultProvider: 'saved-provider', defaultModel: 'nested/model', defaultTools: ['bash'] }))
    const f = fixture(); await f.execute({ model: undefined })
    expect(f.modelRuntime.getModel).toHaveBeenCalledWith('saved-provider', 'nested/model')
    expect(f.getOptions().tools).toEqual([])
  })
  it('allows only read/grep/find/ls for read-only Code and discloses it is not root-confined', async () => {
    const f = fixture(); await f.execute({ surface: 'code', cwd: realpathSync(dir) })
    expect(f.getOptions().tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(f.getOptions().resourceLoader!.getSystemPrompt()).toContain('read outside the project root')
  })
  it('allows explicit trusted builtins, never extensions, and states full user access', async () => {
    const f = fixture(); await f.execute({ surface: 'code', cwd: realpathSync(dir), permissionMode: 'trusted-code' })
    expect(f.getOptions().tools).toEqual(['read', 'write', 'edit', 'bash'])
    expect(f.getOptions().resourceLoader!.getSystemPrompt()).toContain('full user filesystem and shell permissions')
    expect(f.getOptions().resourceLoader!.getExtensions().extensions).toEqual([])
  })
  it('rejects a project symlink replacing the saved canonical directory', async () => {
    const actual = join(dir, 'actual'), link = join(dir, 'link')
    mkdirSync(actual); symlinkSync(actual, link, 'dir')
    const f = fixture()
    await expect(f.execute({ surface: 'code', cwd: link })).rejects.toThrow(/canonical path changed/)
    expect(f.sdk.createAgentSession).not.toHaveBeenCalled()
  })
  it('does not load SDK or prompt if already aborted', async () => {
    const f = fixture(); f.controller.abort()
    await expect(f.execute()).rejects.toThrow()
    expect(f.loadSdk).not.toHaveBeenCalled()
  })
  it('waits for real abort/idle cleanup before resolving the executor promise', async () => {
    const f = fixture()
    let finishPrompt!: () => void, finishAbort!: () => void
    f.session.prompt.mockImplementation(() => new Promise<void>((resolve) => { finishPrompt = resolve }))
    f.session.abort.mockImplementation(() => new Promise<void>((resolve) => { finishAbort = resolve }))
    let settled = false
    const execution = f.execute().catch(() => {}).finally(() => { settled = true })
    await flush(); f.controller.abort(); finishPrompt(); await flush()
    expect(f.session.abort).toHaveBeenCalledOnce()
    expect(settled).toBe(false); expect(f.session.dispose).not.toHaveBeenCalled()
    finishAbort(); await execution
    expect(f.session.waitForIdle).toHaveBeenCalledOnce()
    expect(f.session.dispose).toHaveBeenCalledOnce()
  })
  it('treats assistant error completions as failures even if SDK prompt resolves', async () => {
    const f = fixture()
    f.session.prompt.mockImplementation(async () => {
      const callback = f.session.subscribe.mock.calls[0][0]
      callback({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })
    })
    await expect(f.execute()).rejects.toThrow(/execution failed/)
    expect(f.session.dispose).toHaveBeenCalledOnce()
  })
  it('splits only the first slash in model IDs', () => {
    expect(splitRoutineModel('openrouter/anthropic/model')).toEqual(['openrouter', 'anthropic/model'])
    expect(() => splitRoutineModel('missing')).toThrow()
  })
})
