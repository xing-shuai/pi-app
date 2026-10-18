import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

const require = createRequire(import.meta.url)
const executable = require('electron') as string

test('Chat is tool-isolated, Code stays separate, and local Routines persist and execute', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-product-e2e-'))
  const agentDir = join(home, '.pi', 'agent')
  const configDir = join(home, '.config', 'Electron')
  const workspace = join(home, 'code', 'project')
  const extensionMarker = join(home, 'extension-loaded')
  const forbiddenMarker = join(home, 'forbidden-chat-command')
  const sshMarker = join(home, 'unexpected-ssh-invocation')
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // A cancelled password prompt must never launch SSH. Even a regression cannot use the network.
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' invoked >> '${sshMarker}'\nexit 97\n`, { mode: 0o700 })
  mkdirSync(agentDir, { recursive: true }); mkdirSync(configDir, { recursive: true }); mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), 'READ_ONLY_ROUTINE_FIXTURE\n')
  const extension = join(agentDir, 'evil-extension.ts')
  writeFileSync(extension, `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(extensionMarker)}, 'loaded'); }`)
  writeFileSync(join(agentDir, 'SYSTEM.md'), 'MUST_NOT_APPEAR_IN_CHAT_OR_ROUTINE')
  const seen: Seen[] = []
  const server = startScriptedModel((first, toolTexts) => {
    if (first.includes('Attempt forbidden Chat tool')) return toolTexts.length ? { text: 'Unavailable tool was rejected.' } : { tool: { name: 'bash', args: { command: `touch ${JSON.stringify(forbiddenMarker)}` } } }
    if (first.includes('Read-only routine smoke')) return toolTexts.length ? { text: 'Read-only routine completed.' } : { tool: { name: 'read', args: { path: 'README.md' } } }
    if (first.includes('Routine smoke task')) return { text: 'Routine smoke output.' }
    return { text: 'This is a tool-free Chat reply.' }
  }, seen)
  const port = await listen(server)
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-test', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: 'scripted', name: 'Scripted', reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8000 }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'scripted', defaultThinkingLevel: 'off', extensions: [extension] }))
  writeFileSync(join(configDir, 'pi-desktop.json'), JSON.stringify({ language: 'en', currentProject: null, recentProjects: [], windowBounds: { width: 1400, height: 950 }, autoCheckRegistryUpdates: false }))
  const desktopEnv = { ...process.env }
  delete desktopEnv.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: executable, args: [resolve('out/main/index.js'), `--user-data-dir=${configDir}`, '--ozone-platform=headless', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], env: { ...desktopEnv, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}`, PI_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 60000 })
  try {
    const win = await app.firstWindow()
    await expect(win.getByTestId('chat-product')).toBeVisible()
    const cdp = await app.context().newCDPSession(win)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1308, height: 1224, deviceScaleFactor: 1.25, mobile: false })
    await win.clock.setFixedTime(await win.evaluate(() => new Date(2026, 9, 17, 19, 0).getTime()))
    await expect.poll(() => win.locator('.reference-chat-sidebar').evaluate((node) => node.getBoundingClientRect().width)).toBe(290)
    await expect.poll(() => win.locator('.reference-shell').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(21, 21, 21)')
    await win.evaluate(() => document.fonts.ready)
    await expect.poll(() => win.locator('.reference-chat-greeting .reference-asterisk').evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 46)).toBe(true)
    const geometry = await win.evaluate(() => {
      const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
      return { sidebar: rect('.reference-chat-sidebar'), chrome: rect('.reference-chrome'), composer: rect('.chat-composer'), greeting: rect('.reference-chat-greeting h1'), mark: rect('.reference-chat-greeting .reference-asterisk'), meta: rect('.reference-chat-composer-meta') }
    })
    expect(geometry.chrome.height).toBe(42)
    expect(geometry.composer.width).toBe(768)
    expect(geometry.composer.height).toBe(122)
    expect(Math.abs(geometry.composer.x - 415)).toBeLessThan(1)
    expect(Math.abs(geometry.composer.y - 589)).toBeLessThan(5)
    await win.screenshot({ path: 'test-results/reference-chat-empty.png' })
    const modelTrigger = win.getByRole('button', { name: 'New chat model', exact: true })
    await expect(modelTrigger).toBeEnabled()
    await modelTrigger.click()
    const modelDialog = win.getByRole('dialog', { name: 'New chat model', exact: true })
    await expect(modelDialog.getByRole('combobox', { name: 'Search models', exact: true })).toBeFocused()
    await modelDialog.getByRole('combobox', { name: 'Search models', exact: true }).fill('Scripted')
    await expect(modelDialog.getByRole('option', { name: /Scripted/ })).toBeVisible()
    await expect(win.locator('select[aria-label="New chat model"]')).toHaveCount(0)
    await win.screenshot({ path: 'test-results/reference-chat-model-popover.png' })
    await win.keyboard.press('Escape')
    await expect(modelDialog).toBeHidden()
    await expect(modelTrigger).toBeFocused()
    const mainTrigger = win.getByRole('button', { name: 'Main menu', exact: true })
    await mainTrigger.hover()
    const tooltip = win.getByRole('tooltip').filter({ hasText: 'Main menu' })
    await expect(tooltip).toBeVisible()
    const tooltipType = await tooltip.evaluate((node) => ({ size: getComputedStyle(node).fontSize, family: getComputedStyle(node).fontFamily, width: node.getBoundingClientRect().width }))
    expect(tooltipType.size).toBe('14px')
    expect(tooltipType.width).toBeLessThan(220)
    await win.screenshot({ path: 'test-results/reference-main-menu-tooltip.png' })
    await mainTrigger.click()
    await expect(tooltip).toBeHidden()
    const mainMenu = win.getByRole('menu', { name: 'Main menu actions', exact: true })
    await expect(mainMenu).toBeVisible()
    const menuType = await mainMenu.getByRole('menuitem').first().evaluate((node) => ({ size: getComputedStyle(node).fontSize, family: getComputedStyle(node).fontFamily, shell: getComputedStyle(document.querySelector('.reference-shell')!).fontFamily }))
    expect(menuType.size).toBe('16px'); expect(menuType.family).toBe(menuType.shell)
    await win.screenshot({ path: 'test-results/reference-main-menu.png' })
    await expect(mainMenu.getByRole('menuitem', { name: 'New chat', exact: true })).toBeFocused()
    await win.keyboard.press('ArrowDown')
    await expect(mainMenu.getByRole('menuitem', { name: 'New routine', exact: true })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(mainMenu).toBeHidden(); await expect(mainTrigger).toBeFocused()
    writeFileSync('test-results/reference-geometry.json', JSON.stringify(geometry, null, 2))
    await win.getByLabel('Chat message', { exact: true }).fill('Hello isolated Chat')
    await win.getByRole('button', { name: 'Send Chat message', exact: true }).click()
    await expect(win.getByText('This is a tool-free Chat reply.', { exact: true })).toBeVisible()
    const bodyType = await win.locator('.chat-message.assistant').first().evaluate((element) => {
      const content = element.querySelector('p') || element
      const nav = document.querySelector('.reference-sidebar-nav > button')!
      return { body: getComputedStyle(content).fontFamily, navigation: getComputedStyle(nav).fontFamily, size: getComputedStyle(content).fontSize }
    })
    expect(bodyType.body).toBe(bodyType.navigation)
    expect(bodyType.size).toBe('16px')
    expect(seen[0].tools).toEqual([])
    expect(seen[0].system).not.toContain('MUST_NOT_APPEAR')
    expect(existsSync(extensionMarker)).toBe(false)
    await win.screenshot({ path: 'test-results/product-chat.png' })

    await win.getByRole('button', { name: 'New chat', exact: true }).click()
    await win.getByLabel('Chat message', { exact: true }).fill('Attempt forbidden Chat tool')
    await win.getByRole('button', { name: 'Send Chat message', exact: true }).click()
    await expect(win.getByText('Unavailable tool was rejected.', { exact: true })).toBeVisible()
    expect(existsSync(forbiddenMarker)).toBe(false)
    expect(existsSync(extensionMarker)).toBe(false)

    await win.getByRole('button', { name: 'Scheduled', exact: true }).click()
    await expect(win.getByTestId('routines-product')).toBeVisible()
    await win.getByRole('button', { name: 'New routine', exact: true }).click()
    await expect(win.getByTestId('routine-online-weather')).not.toBeChecked()
    await win.getByLabel('Name', { exact: true }).fill('Smoke routine')
    await win.getByLabel('Instructions', { exact: true }).fill('Routine smoke task')
    await win.getByRole('button', { name: 'Save routine', exact: true }).click()
    await expect(win.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toContainText('Smoke routine')
    await win.screenshot({ path: 'test-results/reference-scheduled-details.png' })
    await win.getByRole('button', { name: 'Run now', exact: true }).click()
    const runOutput = win.getByRole('article', { name: 'Run output', exact: true })
    await expect(runOutput).toContainText('Routine smoke output.')
    await expect(win.getByTestId('routine-completion-note')).toContainText('not independently verified')
    await expect(win.getByRole('complementary', { name: 'Runs', exact: true })).toBeVisible()
    await win.screenshot({ path: 'test-results/reference-scheduled-runs.png' })
    await win.screenshot({ path: 'test-results/product-routines.png' })
    await win.getByRole('button', { name: 'Task details', exact: true }).click()
    await expect(win.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled()
    const routineRequests = seen.filter((r) => r.firstUser.includes('Routine smoke task'))
    expect(routineRequests.length).toBeGreaterThan(0)
    expect(routineRequests.every((r) => !r.tools.length && !r.system.includes('MUST_NOT_APPEAR'))).toBe(true)
    // Grant through the real editor, inspect persistence, then revoke before any run.
    // No public weather request or fake claim of live-weather desktop acceptance.
    await win.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(win.getByTestId('routine-online-weather')).not.toBeChecked()
    await win.getByTestId('routine-online-weather').check()
    await win.getByRole('button', { name: 'Save routine', exact: true }).click()
    await expect(win.getByTestId('routine-permission-badge')).toContainText('Chat+Weather')
    const weatherGrant = await win.evaluate(async () => {
      const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<{ routines: Array<{ name: string; onlineWeather?: boolean }> }> } }).piDesktop
      return (await api.invoke('ipc:routines.list', {})).routines.find((routine) => routine.name === 'Smoke routine')?.onlineWeather
    })
    expect(weatherGrant).toBe(true)
    await win.screenshot({ path: 'test-results/reference-routine-weather-permission.png' })
    await win.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(win.getByTestId('routine-online-weather')).toBeChecked()
    await win.getByTestId('routine-online-weather').uncheck()
    await win.getByRole('button', { name: 'Save routine', exact: true }).click()
    await expect(win.getByTestId('routine-permission-badge')).toHaveText('Chat')

    const readonly = await win.evaluate(async ({ cwd }) => {
      const routine = { id: crypto.randomUUID(), name: 'Read-only smoke', description: '', prompt: 'Read-only routine smoke', surface: 'code', cwd, model: 'mock/scripted', permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: Date.now(), updatedAt: Date.now() }
      const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<unknown> } }).piDesktop
      const saved = await api.invoke('ipc:routines.save', { routine }) as { routine: { id: string } }
      await api.invoke('ipc:routines.run', { id: saved.routine.id })
      return saved.routine.id
    }, { cwd: workspace })
    await expect.poll(async () => win.evaluate(async (id) => {
      const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<{ runs: Array<{ routineId: string; status: string }> }> } }).piDesktop
      return (await api.invoke('ipc:routines.list', {})).runs.find((r) => r.routineId === id)?.status
    }, readonly)).toBe('succeeded')
    const readonlyRequests = seen.filter((r) => r.firstUser.includes('Read-only routine smoke'))
    expect(readonlyRequests.some((r) => r.toolTexts.some((text) => text.includes('READ_ONLY_ROUTINE_FIXTURE')))).toBe(true)
    expect(readonlyRequests.every((r) => !r.tools.some((t) => ['bash', 'write', 'edit', 'powershell'].includes(t)))).toBe(true)
    expect(existsSync(extensionMarker)).toBe(false)

    await win.getByRole('button', { name: 'Scheduled tasks', exact: true }).click()
    await expect(win.getByTestId('routine-card')).toHaveCount(2)
    await win.screenshot({ path: 'test-results/reference-scheduled-cards.png' })
    await win.reload()
    await expect(win.getByTestId('chat-product')).toBeVisible()
    await win.getByRole('button', { name: 'Scheduled', exact: true }).click()
    await win.getByTestId('routine-card').filter({ hasText: 'Smoke routine' }).click()
    await win.getByTestId('routine-run-row').first().click()
    await expect(win.getByRole('article', { name: 'Run output', exact: true })).toContainText('Routine smoke output.')
    await win.getByRole('button', { name: 'Code', exact: true }).click()
    await expect(win.getByLabel('Code execution environment')).toBeVisible()
    const codeWorkspace = win.locator('[aria-label="Code workspace"]')
    await expect(codeWorkspace.locator('.shell-three-col')).toBeVisible()
    const splitCount = await codeWorkspace.locator('.split-view').count()
    await win.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(codeWorkspace).toBeHidden()
    await win.getByLabel('Chat message', { exact: true }).click()
    await win.keyboard.press('Control+Backslash')
    await expect(codeWorkspace.locator('.split-view')).toHaveCount(splitCount)
    await win.getByRole('button', { name: 'Code', exact: true }).click()
    await expect(codeWorkspace.locator('.shell-three-col')).toBeVisible()
    await win.screenshot({ path: 'test-results/product-code.png' })
    await win.getByLabel('Code execution environment').click()
    await expect(win.getByRole('menuitem', { name: 'Local', exact: true })).toBeVisible()
    await expect(win.locator('.reference-environment-menu')).toHaveCSS('width', '240px')
    await win.screenshot({ path: 'test-results/reference-code-local-menu.png' })

    const passwordSupported = await win.evaluate(async () => {
      const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<{ authCapabilities: { password: boolean } }> } }).piDesktop
      return (await api.invoke('ipc:ssh.profiles', {})).authCapabilities.password
    })
    if (passwordSupported) {
      await win.getByRole('menuitem', { name: 'SSH', exact: true }).click()
      await win.getByRole('menuitem', { name: 'Add SSH connection…', exact: true }).click()
      await expect(win.getByRole('dialog', { name: 'Add SSH connection', exact: true })).toBeVisible()
      await win.getByLabel('Name', { exact: true }).fill('Password UI fixture')
      await win.getByLabel('SSH host', { exact: true }).fill('no-network.invalid')
      await win.getByLabel('SSH authentication', { exact: true }).selectOption('password')
      await win.getByRole('button', { name: 'Add SSH connection', exact: true }).click()
      const secret = win.getByLabel('Password', { exact: true })
      await expect(secret).toHaveAttribute('type', 'password')
      await secret.fill('temporary-gui-fixture-value')
      await win.getByRole('button', { name: 'Cancel', exact: true }).click()
      await win.getByLabel('Code execution environment').click()
      await win.getByRole('menuitem', { name: 'SSH', exact: true }).click()
      await win.getByRole('menuitem', { name: 'Password UI fixture', exact: true }).click()
      await expect(win.getByLabel('Password', { exact: true })).toHaveValue('')
      await win.screenshot({ path: 'test-results/reference-ssh-password.png' })
      await win.getByRole('button', { name: 'Cancel', exact: true }).click()
      const savedProfiles = await win.evaluate(async () => {
        const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<unknown> } }).piDesktop
        return JSON.stringify(await api.invoke('ipc:settings.get', { key: 'sshProfiles' }))
      })
      expect(existsSync(sshMarker)).toBe(false)
      expect(readFileSync(join(configDir, 'pi-desktop.json'), 'utf8')).not.toContain('temporary-gui-fixture-value')
      expect(savedProfiles).toContain('no-network.invalid')
      expect(savedProfiles).not.toContain('temporary-gui-fixture-value')
      expect(JSON.stringify(await win.evaluate(async () => {
        const api = (window as unknown as { piDesktop: { invoke: (channel: string, request?: unknown) => Promise<unknown> } }).piDesktop
        return api.invoke('ipc:code.environment.get', {})
      }))).not.toContain('no-network.invalid')
      await win.getByLabel('Code execution environment').click()
      await win.getByRole('menuitem', { name: 'Local', exact: true }).click()
    }
    // Reproduce the user's actual 1.5-DPR display with the reference density calibration.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1090, height: 1020, deviceScaleFactor: 1.5, mobile: false })
    await win.evaluate(() => localStorage.setItem('pi-desktop:ui-zoom', String(5 / 6)))
    await win.reload()
    await win.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(win.locator('.reference-chat-greeting')).toBeVisible()
    await expect.poll(() => win.locator('.chat-composer').evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(640)
    const nativeDensity = await win.evaluate(() => ({ zoom: document.documentElement.style.zoom, dpr: devicePixelRatio, greetingFont: getComputedStyle(document.querySelector('.reference-chat-greeting h1')!).fontSize, composer: document.querySelector('.chat-composer')!.getBoundingClientRect().toJSON() }))
    expect(nativeDensity.greetingFont).toBe('33px')
    await win.screenshot({ path: 'test-results/reference-native-density.png' })
    writeFileSync('test-results/reference-density.json', JSON.stringify(nativeDensity, null, 2))
    const homeTypography = await win.locator('.reference-sidebar-nav > button').first().evaluate((node) => ({ size: getComputedStyle(node).fontSize, family: getComputedStyle(node).fontFamily }))
    await win.getByRole('button', { name: 'Account and settings', exact: true }).click()
    await win.getByRole('menuitem', { name: /^Settings(?:\s|$)/ }).click()
    await expect(win.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
    await expect(win.locator('.reference-settings-dialog [data-settings-active-page]')).toBeVisible()
    await expect(win.getByRole('button', { name: 'Close Settings', exact: true })).toBeVisible()
    await expect(win.locator('.settings-layout')).toBeVisible()
    await expect(win.locator('.settings-page-header h2')).toBeVisible()
    const settingsTypography = await win.evaluate(() => {
      const style = (selector: string) => { const node = document.querySelector(selector)!; const css = getComputedStyle(node); return { size: css.fontSize, family: css.fontFamily } }
      return { nav: style('.settings-nav-item'), title: style('.settings-page-header h2'), description: style('.settings-page-header p') }
    })
    expect(settingsTypography.nav.size).toBe(homeTypography.size)
    expect(settingsTypography.nav.family).toBe(homeTypography.family)
    expect(parseFloat(settingsTypography.title.size)).toBeGreaterThanOrEqual(22)
    expect(parseFloat(settingsTypography.description.size)).toBeGreaterThanOrEqual(14)
    await win.screenshot({ path: 'test-results/reference-settings-type.png' })
    writeFileSync('test-results/reference-typography.json', JSON.stringify({ home: homeTypography, settings: settingsTypography }, null, 2))
  } finally {
    await app.close()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(home, { recursive: true, force: true })
  }
})
