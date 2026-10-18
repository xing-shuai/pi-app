// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Routine, RoutineRun } from '../../../packages/shared/routine-types'
import { createSdkRoutineExecutor, routineResourceLoader } from './executor'
import { createWeatherTool } from './weather'
import { RoutineService, systemClock } from './service'
import { RoutineStore } from './store'

const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('actual bundled SDK weather permission boundary', () => {
  it('declares only weather when opted in, executes it, and sends normalized fake public data back to the model; default Chat stays tool-free', async () => {
    const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> }> = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body) as typeof requests[number]
      requests.push(payload)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'routine-weather-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (payload.tools?.length && !payload.messages.some((m) => m.role === 'tool')) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'weather-call', type: 'function', function: { name: 'weather', arguments: '{"city":"杭州","country":"CN"}' } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: payload.tools?.length ? 'Weather result received with provider observation time.' : 'I cannot retrieve current weather without tools.' })
        chunk({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dir = mkdtempSync(join(tmpdir(), 'routine-weather-sdk-')); dirs.push(dir)
    const host = join(dir, 'host'); mkdirSync(host)
    vi.stubEnv('PI_CODING_AGENT_DIR', host)
    const marker = join(dir, 'UNTRUSTED_EXECUTED')
    mkdirSync(join(host, 'extensions'))
    writeFileSync(join(host, 'extensions/poison.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad')`)
    writeFileSync(join(host, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'test', extensions: ['./extensions/poison.js'], packages: ['npm:DO_NOT_INSTALL'], defaultTools: ['bash'] }))
    writeFileSync(join(host, 'AGENTS.md'), 'POISON_CONTEXT')
    writeFileSync(join(host, 'SYSTEM.md'), 'POISON_SYSTEM')
    writeFileSync(join(host, 'mcp.json'), JSON.stringify({ mcpServers: { poison: { command: 'DO_NOT_RUN' } } }))
    writeFileSync(join(host, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api: 'openai-completions', apiKey: 'dummy', models: [{ id: 'test', input: ['text'] }] } } }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    let lastOptions: Parameters<typeof sdk.createAgentSession>[0]
    const loadSdk = async () => ({ ...sdk, createAgentSession: async (options: Parameters<typeof sdk.createAgentSession>[0]) => {
      lastOptions = options
      const result = await sdk.createAgentSession(options)
      const expected = options?.tools ?? []
      expect(result.session.getActiveToolNames()).toEqual(expected)
      expect(result.session.agent.state.tools.map((t) => t.name)).toEqual(expected)
      result.session.setActiveToolsByName([...expected, 'bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'])
      expect(result.session.getActiveToolNames()).toEqual(expected)
      expect(result.session.systemPrompt).not.toContain('POISON')
      expect(options?.resourceLoader?.getExtensions().extensions).toEqual([])
      expect(options?.resourceLoader?.getSkills().skills).toEqual([])
      expect(options?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([])
      expect(options?.resourceLoader?.getPrompts().prompts).toEqual([])
      return result
    } })
    const weatherFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const parsed = new URL(String(url))
      if (parsed.origin === 'https://geocoding-api.open-meteo.com') return Response.json({ results: [{ name: '杭州', country: '中国', latitude: 30.27, longitude: 120.15 }] })
      expect(parsed.origin).toBe('https://api.open-meteo.com')
      return Response.json({ timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, current: { time: '2026-05-01T16:00', temperature_2m: 23.4, apparent_temperature: 24.1, wind_speed_10m: 9.2, precipitation: 0, weather_code: 3, is_day: 1 } })
    })
    const routine: Routine = { id: 'weather-task', name: 'Weather', description: '', prompt: '杭州天气', surface: 'chat', permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: 1, updatedAt: 1 }
    const executor = createSdkRoutineExecutor(dir, loadSdk, weatherFetch)
    const run: RoutineRun = { id: 'opted-in', routineId: routine.id, status: 'running', scheduledAt: 1, output: '' }
    const onOutput = vi.fn(), onSessionFile = vi.fn()
    try {
      await executor({ routine: { ...routine, onlineWeather: true }, run, signal: new AbortController().signal, onOutput, onSessionFile })
      expect(requests).toHaveLength(2)
      expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['weather'])
      const toolResult = requests[1].messages.find((m) => m.role === 'tool')
      expect(toolResult).toBeDefined()
      for (const part of ['23.4', '24.1', '9.2', '2026-05-01T16:00', 'Asia/Shanghai', 'Open-Meteo', '杭州']) expect(JSON.stringify(toolResult)).toContain(part)
      expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('Weather result received'))
      expect(readFileSync(onSessionFile.mock.calls[0][0], 'utf8')).toContain('23.4')
      expect(weatherFetch).toHaveBeenCalledTimes(2)
      // An old weather instruction is NOT authority. It is still a completed model execution, not a failed run inferred from text.
      await executor({ routine, run: { ...run, id: 'old-off' }, signal: new AbortController().signal, onOutput, onSessionFile })
      expect(requests).toHaveLength(3)
      expect(requests[2].tools ?? []).toEqual([])
      expect(weatherFetch).toHaveBeenCalledTimes(2)
      expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('cannot retrieve'))
      expect(existsSync(marker)).toBe(false)
      // SDK disposal alone (without routine cancellation) must abort nested weather I/O too.
      let disposedFetchSignal: AbortSignal | undefined
      weatherFetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        disposedFetchSignal = options!.signal!
        disposedFetchSignal.addEventListener('abort', () => reject(new Error('SECRET SDK disposal')), { once: true })
      }))
      const isolatedWeather = createWeatherTool(new AbortController().signal, weatherFetch)
      const { session: disposable } = await sdk.createAgentSession({
        ...lastOptions, tools: ['weather'], noTools: 'builtin', customTools: [isolatedWeather.tool],
        resourceLoader: routineResourceLoader(sdk, 'Only the weather tool is available.'), sessionManager: sdk.SessionManager.inMemory(dir),
      })
      const disposingPrompt = disposable.prompt('Use weather for Hangzhou, CN', { expandPromptTemplates: false }).catch(() => {})
      try {
        await vi.waitFor(() => expect(disposedFetchSignal).toBeDefined(), { timeout: 5000 })
        disposable.dispose()
        expect(disposedFetchSignal?.aborted).toBe(true)
        await disposingPrompt
        await disposable.agent.waitForIdle()
      } finally { isolatedWeather.dispose(); disposable.dispose() }
      // Actual SDK + weather + scheduler cancellation: an abort request must not release a busy lock.
      for (const reason of ['cancel', 'timeout'] as const) {
        let fetchSignal: AbortSignal | undefined
        let finishFetch!: () => void
        let deadline!: () => void
        weatherFetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
          fetchSignal = options!.signal!
          finishFetch = () => reject(new Error('SECRET delayed abort cleanup'))
        }))
        const service = new RoutineService(new RoutineStore(join(dir, `ledger-${reason}`)), {
          executor,
          clock: { ...systemClock, setTimeout: (fn, ms) => { deadline = fn; return systemClock.setTimeout(fn, ms) } },
        })
        const granted = service.save({ ...routine, id: '', onlineWeather: true })
        const running = service.runNow(granted.id)
        try {
          await vi.waitFor(() => expect(fetchSignal).toBeDefined(), { timeout: 5000 })
          if (reason === 'cancel') service.cancel(running.id)
          else deadline()
          expect(fetchSignal?.aborted).toBe(true)
          expect(service.history(granted.id).find((r) => r.id === running.id)?.status).toBe('unknown')
          expect(service.hasActiveRuns).toBe(true)
          expect(service.runNow(granted.id).skipReason).toContain('routine-active')
          expect(() => service.save({ ...granted, onlineWeather: false })).toThrow(/active routine definition/)
          finishFetch()
          await vi.waitFor(() => expect(service.hasActiveRuns).toBe(false), { timeout: 5000 })
          const completed = service.history(granted.id).find((r) => r.id === running.id)!
          expect(completed.executionSettledAt).toBeDefined()
          expect(completed.status).toBe(reason === 'cancel' ? 'cancelled' : 'unknown')
          expect(completed.error).not.toContain('SECRET')
        } finally {
          finishFetch?.()
          await service.shutdown()
        }
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)
})
