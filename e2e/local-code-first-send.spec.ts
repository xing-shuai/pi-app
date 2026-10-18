import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listen, startScriptedModel, type Seen } from './helpers/scripted-agent'
const require = createRequire(import.meta.url)
const executable = require('electron') as string

test('custom local project selection leaves the ephemeral draft and sends the first real Code message', async () => {
  test.setTimeout(90000)
  const home = mkdtempSync(join(tmpdir(), 'pi-local-first-send-'))
  const agentDir = join(home, '.pi/agent'), configDir = join(home, '.config/Electron'), project = join(home, 'code', 'first-project')
  for (const path of [agentDir, configDir, project]) mkdirSync(path, { recursive: true })
  writeFileSync(join(project, 'README.md'), 'LOCAL_FIRST_SEND_READ_FIXTURE\n')
  const seen: Seen[] = []
  const server = startScriptedModel((_first, toolTexts) => toolTexts.length ? { text: 'Local first session sent successfully.' } : { tool: { name: 'read', args: { path: 'README.md' } } }, seen)
  const port = await listen(server)
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fixture-only', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: 'scripted', name: 'Local fixture model', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 4096 }] } } }))
  const onboardingMarker = join(home, 'optional-onboarding-result')
  const onboardingExtension = join(agentDir, 'optional-onboarding.ts')
  writeFileSync(onboardingExtension, `import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', async (_event, ctx) => { const value = await ctx.ui.input('Agent name: (default: fixture-project)', { defaultValue: 'fixture-project' }); writeFileSync(${JSON.stringify(onboardingMarker)}, value === undefined ? 'cancelled' : 'unexpected'); }); }`)
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'scripted', defaultThinkingLevel: 'off', extensions: [onboardingExtension] }))
  writeFileSync(join(configDir, 'pi-desktop.json'), JSON.stringify({ language: 'en', currentProject: null, recentProjects: [], autoCheckRegistryUpdates: false, windowBounds: { width: 1308, height: 1000 } }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: executable, args: [resolve('out/main/index.js'), `--user-data-dir=${configDir}`, '--ozone-platform=headless', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: agentDir, PI_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 60000 })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ dialog }) => {
      const state = globalThis as { nativeProjectPickerCalls?: number }; state.nativeProjectPickerCalls = 0
      dialog.showOpenDialog = async () => { state.nativeProjectPickerCalls!++; throw new Error('Native directory picker must not be used') }
    })
    await expect(win.getByTestId('chat-product')).toBeVisible()
    await win.getByRole('button', { name: 'Code', exact: true }).click()
    const code = win.getByLabel('Code workspace', { exact: true })
    await expect(code).toBeVisible()
    await expect(code.getByText('Open a folder to start a project', { exact: true })).toHaveCount(0)
    await expect(win.getByRole('button', { name: 'What’s new', exact: true })).toHaveCount(0)
    await expect.poll(async () => win.evaluate(() => {
      const w = window as unknown as { __piE2E?: { useUIStore: { getState: () => { ephemeralSandboxDraft: boolean } } } }
      return w.__piE2E?.useUIStore.getState().ephemeralSandboxDraft
    })).toBe(true)
    await code.getByRole('button', { name: 'Select project folder', exact: true }).click()
    await win.getByRole('menuitem', { name: 'Browse local folder…', exact: true }).click()
    const picker = win.getByRole('dialog', { name: 'Select local folder', exact: true })
    await expect(picker).toBeVisible()
    await picker.getByLabel('Local folder path').fill(project)
    await picker.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(picker.getByRole('button', { name: 'Select folder', exact: true })).toBeEnabled()
    await win.screenshot({ path: 'test-results/reference-local-folder-picker.png' })
    await picker.getByRole('button', { name: 'Select folder', exact: true }).click()
    const trust = win.getByRole('dialog', { name: 'Trust this workspace?', exact: true })
    await expect(trust).toContainText(project)
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click()
    await expect(trust).toBeHidden()
    await expect(win.getByRole('button', { name: 'Code', exact: true })).toBeEnabled()
    const editor = code.getByRole('textbox', { name: 'Describe a task or ask a question', exact: true })
    await editor.fill('Read the local project README for the first message')
    await editor.press('Enter')
    await expect(code.getByText('Local first session sent successfully.', { exact: true })).toBeVisible({ timeout: 45000 })
    expect(seen.some((entry) => entry.toolTexts.some((text) => text.includes('LOCAL_FIRST_SEND_READ_FIXTURE')))).toBe(true)
    await expect(win.getByRole('dialog', { name: /Agent name:/ })).toHaveCount(0)
    expect(existsSync(onboardingMarker)).toBe(true)
    expect(readFileSync(onboardingMarker, 'utf8')).toBe('cancelled')
    const allowance = await win.evaluate(async () => {
      const w = window as unknown as { __piE2E: { useUIStore: { getState: () => { currentWorkspace: string; historySessionFile: string } } }; piDesktop: { invoke: (method: string, request: unknown) => Promise<unknown> } }
      const view = w.__piE2E.useUIStore.getState()
      return w.piDesktop.invoke('ipc:providerUsage.get', { workspaceId: view.currentWorkspace, sessionFile: view.historySessionFile })
    })
    // The production bridge reached the actual worker/model, not a missing-runtime facade.
    // This fixture intentionally has an unsupported mock provider and no real credentials.
    expect(allowance).toMatchObject({ status: 'unavailable', reason: 'provider-unsupported' })
    await code.locator('[data-composer-model-chip]').click()
    const quickModels = win.locator('.reference-model-menu:not(.reference-model-submenu)')
    await expect(quickModels.getByRole('button', { name: /Local fixture model/ })).toBeVisible()
    await quickModels.getByRole('button', { name: 'More models', exact: true }).click()
    const allModels = win.getByRole('dialog', { name: 'All models', exact: true })
    await allModels.getByRole('textbox', { name: 'Search models', exact: true }).fill('Local fixture')
    await expect(allModels.getByRole('button', { name: /Local fixture model/ })).toBeVisible()
    await win.screenshot({ path: 'test-results/reference-model-more-menu.png' })
    await win.keyboard.press('Escape')
    await expect(allModels).toBeHidden(); await expect(quickModels).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(quickModels).toBeHidden()
    await code.locator('[data-composer-thinking-chip]').click()
    const effort = win.getByRole('dialog', { name: 'Effort', exact: true })
    await expect(effort.getByRole('slider', { name: 'Effort', exact: true })).toBeVisible()
    await expect(effort).toContainText('Faster'); await expect(effort).toContainText('Smarter')
    await win.screenshot({ path: 'test-results/reference-effort-slider.png' })
    await win.keyboard.press('Escape')
    await expect(effort).toBeHidden()
    await expect(win.getByText('Send failed', { exact: true })).toHaveCount(0)
    expect(await app.evaluate(() => (globalThis as { nativeProjectPickerCalls?: number }).nativeProjectPickerCalls)).toBe(0)
    await win.screenshot({ path: 'test-results/reference-local-first-message.png' })
  } finally { await app.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }) }
})
