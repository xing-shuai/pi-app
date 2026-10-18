import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listen, startScriptedModel, type Seen } from './helpers/scripted-agent'
const require = createRequire(import.meta.url)
const executable = require('electron') as string

test('Chat thinking reaches the real SDK request and long returned results wrap', async () => {
  test.setTimeout(90000)
  const home = mkdtempSync(join(tmpdir(), 'pi-chat-thinking-e2e-'))
  const agentDir = join(home, '.pi/agent'), configDir = join(home, '.config/Electron')
  for (const path of [agentDir, configDir]) mkdirSync(path, { recursive: true })
  const seen: Seen[] = [], long = 'unbroken_result_path_'.repeat(70)
  const server = startScriptedModel(() => ({ text: `CHAT_THINKING_RESULT\n\n${long}\n\n\`\`\`text\n${long}\n\`\`\``, delayMs: 700 }), seen)
  const port = await listen(server)
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fixture-only', compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, models: [{ id: 'reasoner', name: 'Reasoning fixture', reasoning: true, input: ['text'], contextWindow: 64000, maxTokens: 4096 }, { id: 'plain', name: 'Plain fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 4096 }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'reasoner', defaultThinkingLevel: 'off' }))
  writeFileSync(join(configDir, 'pi-desktop.json'), JSON.stringify({ language: 'en', currentProject: null, recentProjects: [], autoCheckRegistryUpdates: false, windowBounds: { width: 1090, height: 1020 } }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: executable, args: [resolve('out/main/index.js'), `--user-data-dir=${configDir}`, '--ozone-platform=headless', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: agentDir, PI_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 60000 })
  try {
    const win = await app.firstWindow()
    await expect(win.getByTestId('chat-product')).toBeVisible()
    await win.getByRole('button', { name: 'New chat model', exact: true }).click()
    await win.getByRole('option', { name: /^Reasoning fixture/ }).click()
    const thinking = win.getByRole('button', { name: 'Chat thinking intensity', exact: true })
    await expect(thinking).toBeEnabled()
    await thinking.click()
    await win.getByRole('dialog', { name: 'Chat thinking intensity', exact: true }).getByRole('option', { name: 'High', exact: true }).click()
    await expect(thinking).toContainText('High')
    await win.getByRole('textbox', { name: 'Chat message', exact: true }).fill('Reason through this fixture')
    await win.getByRole('button', { name: 'Send Chat message', exact: true }).click()
    await expect(thinking).toBeDisabled()
    await expect(win.getByText('CHAT_THINKING_RESULT', { exact: true })).toBeVisible()
    await expect(thinking).toBeEnabled()
    expect(seen[0].reasoningEffort).toBe('high')
    expect(seen[0].tools).toEqual([])
    const wrap = await win.locator('.chat-message.assistant').evaluate((element) => {
      const pre = element.querySelector('pre')!, p = element.querySelectorAll('p')[1]
      return { pre: getComputedStyle(pre).whiteSpace, overflow: getComputedStyle(pre).overflowWrap, preWidth: pre.scrollWidth - pre.clientWidth, paragraphWidth: p.scrollWidth - p.clientWidth, scrollbar: getComputedStyle(document.querySelector('.chat-message-scroll')!, '::-webkit-scrollbar').width }
    })
    expect(wrap.pre).toBe('pre-wrap'); expect(wrap.overflow).toBe('anywhere')
    expect(wrap.preWidth).toBeLessThanOrEqual(1); expect(wrap.paragraphWidth).toBeLessThanOrEqual(1)
    expect(wrap.scrollbar).toBe('4px')
    await thinking.click()
    await win.getByRole('dialog', { name: 'Chat thinking intensity', exact: true }).getByRole('option', { name: 'Low', exact: true }).click()
    await expect(thinking).toContainText('Low')
    const session = await win.evaluate(async () => {
      const api = (window as unknown as { piDesktop: { invoke: (method: string, request?: unknown) => Promise<{ sessions: { thinkingLevel?: string; effectiveThinkingLevel?: string }[] }> } }).piDesktop
      return (await api.invoke('ipc:chat.list')).sessions[0]
    })
    expect(session).toMatchObject({ thinkingLevel: 'low', effectiveThinkingLevel: 'low' })
    await win.screenshot({ path: 'test-results/reference-chat-thinking-wrap.png' })
    await win.reload()
    await win.getByRole('button', { name: 'Reason through this fixture', exact: true }).click()
    await expect(win.getByRole('button', { name: 'Chat thinking intensity', exact: true })).toContainText('Low')
    await win.getByRole('button', { name: 'New chat', exact: true }).click()
    await win.getByRole('button', { name: 'New chat model', exact: true }).click()
    await win.getByRole('option', { name: /^Plain fixture/ }).click()
    await win.getByRole('button', { name: 'Chat thinking intensity', exact: true }).click()
    const onlyOff = win.getByRole('dialog', { name: 'Chat thinking intensity', exact: true })
    await expect(onlyOff.getByRole('option')).toHaveCount(1)
    await expect(onlyOff.getByRole('option', { name: 'Off', exact: true })).toBeVisible()
    await win.keyboard.press('Escape')
  } finally { await app.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }) }
})
