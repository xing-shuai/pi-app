import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRemoteHostFixture, piStarts, REMOTE_REPLY, REMOTE_USAGE } from './helpers/remote-host-fixture'
import { startScriptedModel } from './helpers/scripted-agent'
import type { SessionCatalogResult } from '../packages/shared/session-catalog-types'

// Read existing E2E hooks, never replace the UI store, IPC bridge, helper, or routing.
async function ui(win: Page) {
  return win.evaluate(() => {
    const s = (window as any).__piE2E.useUIStore.getState()
    return { workspace: s.currentWorkspace, sessionFile: s.currentSessionFile, sessionId: s.currentSessionId, runState: s.runState, recentProjects: s.recentProjects }
  })
}
async function invoke<T = any>(win: Page, method: string, request: unknown = {}): Promise<T> {
  return win.evaluate(async ({ method, request }) => (window as any).piDesktop.invoke(`ipc:${method}`, request), { method, request })
}
async function rejection(win: Page, method: string, request: unknown): Promise<string> {
  return win.evaluate(async ({ method, request }) => {
    try { await (window as any).piDesktop.invoke(`ipc:${method}`, request); return 'UNEXPECTED_SUCCESS' } catch (error) { return String(error) }
  }, { method, request })
}

test('SSH uses the SAME Code workbench with real remote files, Git, PTY and durable RPC history', async ({}, testInfo) => {
  test.setTimeout(180000)
  const localModel = startScriptedModel(() => ({ text: 'LOCAL_CATALOG_REPLY' }), [])
  await new Promise<void>((resolve) => localModel.listen(0, '127.0.0.1', resolve))
  const port = (localModel.address() as { port: number }).port
  const f = await launchRemoteHostFixture({ localModelPort: port }).catch(async (error) => { await new Promise<void>((resolve) => localModel.close(() => resolve())); throw error })
  const { win } = f
  const errors: string[] = []
  win.on('pageerror', (error) => errors.push(error.stack || error.message))
  let terminalId: string | undefined
  try {
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1050))
    const cdp = await f.app.context().newCDPSession(win)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false })
    await win.getByRole('button', { name: 'Code', exact: true }).click()
    const code = win.getByLabel('Code workspace', { exact: true })
    await expect(code.locator('.shell-three-col')).toBeVisible()
    // Code opens a blank draft on first visit; native recents no longer depend on the old tree.
    await expect.poll(async () => (await ui(win)).recentProjects).toContain(f.local)
    await win.getByRole('button', { name: 'Select project folder', exact: true }).click()
    await win.getByRole('menuitem', { name: 'local-project', exact: true }).click()
    const localTrust = win.getByRole('dialog', { name: 'Trust this workspace?', exact: true })
    await expect(localTrust).toContainText(f.local)
    await localTrust.getByRole('button', { name: 'Trust workspace', exact: true }).click()
    await expect.poll(async () => (await ui(win)).workspace).toBe(f.local)
    const codeNode = await code.elementHandle()
    const shellNode = await code.locator('.shell-three-col').elementHandle()
    const sameWorkbench = async (target: string) => {
      await expect(code).toHaveAttribute('data-execution-target', target)
      expect(await codeNode!.evaluate((node) => node === document.querySelector('[aria-label="Code workspace"]'))).toBe(true)
      expect(await shellNode!.evaluate((node) => node === document.querySelector('[aria-label="Code workspace"] .shell-three-col'))).toBe(true)
      await expect(win.getByLabel('SSH workspace', { exact: true })).toHaveCount(0)
    }
    await sameWorkbench('local')
    const localComposer = code.getByRole('textbox', { name: 'Describe a task or ask a question', exact: true })
    await localComposer.fill('Local catalog conversation'); await localComposer.press('Enter')
    await expect(code.locator('.timeline-prose-row').filter({ hasText: 'LOCAL_CATALOG_REPLY' })).toBeVisible()
    await expect.poll(async () => (await ui(win)).runState.status).toBe('idle')
    expect(JSON.stringify(await invoke(win, 'workspace.fs.listDir', { workspaceRoot: f.local }))).toContain('LOCAL_ONLY.txt')
    await win.screenshot({ path: 'test-results/reference-unified-ssh-home.png' })

    const selectHost = async () => {
      await win.getByLabel('Code execution environment').click()
      await win.getByRole('menuitem', { name: 'SSH', exact: true }).click()
      await win.getByRole('menuitem', { name: 'Fixture host', exact: true }).click()
    }
    const chooseRemote = async () => {
      const folder = win.getByRole('dialog', { name: 'Select remote folder', exact: true })
      await expect(folder).toBeVisible()
      await expect(folder).toContainText('Fixture host')
      expect(piStarts(f)).toEqual([])
      await folder.getByLabel('Remote folder path').fill(f.remote)
      await folder.getByRole('button', { name: 'Go', exact: true }).click()
      await expect(folder.getByRole('button', { name: 'Select folder', exact: true })).toBeEnabled()
      await win.screenshot({ path: 'test-results/reference-unified-ssh-folder.png' })
      await folder.getByRole('button', { name: 'Select folder', exact: true }).click()
      const trust = win.getByRole('dialog', { name: 'Trust this workspace?', exact: true })
      await expect(trust).toBeVisible()
      await expect(trust).toContainText(f.remote)
      await expect(trust).toContainText('fixture.invalid')
      expect(piStarts(f)).toEqual([])
      return trust
    }
    await selectHost()
    const cancelledTrust = await chooseRemote()
    expect(existsSync(f.sshMarker)).toBe(true)
    await win.screenshot({ path: 'test-results/reference-unified-ssh-trust.png' })
    await cancelledTrust.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(cancelledTrust).toBeHidden()
    expect(piStarts(f)).toEqual([])
    expect((await invoke(win, 'code.environment.get')).workspaces).toEqual([])
    await selectHost()
    const trust = await chooseRemote()
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click()
    await expect(trust).toBeHidden()
    await sameWorkbench('ssh')
    await expect.poll(async () => (await ui(win)).workspace).toMatch(/^\/__pi_ssh__\//)
    const remoteId = (await ui(win)).workspace as string
    const settings = (await invoke(win, 'settings.get', { key: 'currentProject' })).settings
    expect(settings.currentProject).toBe(remoteId)
    const disk = JSON.parse(readFileSync(f.configFile, 'utf8'))
    expect(disk.currentProject).toBe(f.local)
    expect(disk.recentProjects).toEqual([f.local])
    expect(JSON.stringify(disk)).not.toContain('/__pi_ssh__/')

    await test.step('remote namespaces fail closed rather than opening local paths', async () => {
      expect(await rejection(win, 'shell.openPath', { workspaceId: remoteId, path: join(f.local, 'sentinel.txt') })).toMatch(/Mixed local and remote|native|not supported/i)
      expect(await rejection(win, 'workspace.fs.listDir', { workspaceRoot: '/__pi_ssh__/unknown/root' })).toMatch(/Unknown reserved/i)
    })

    // Metadata may need a Pi runtime, but it must not manufacture a visible conversation.
    await invoke(win, 'model.list', { workspaceId: remoteId })
    await expect.poll(async () => (await invoke<SessionCatalogResult>(win, 'code.sessions.list')).sessions.some((entry) => entry.targetId === 'local' && entry.title.includes('Local catalog conversation'))).toBe(true)
    const beforePrompt = await invoke<SessionCatalogResult>(win, 'code.sessions.list')
    expect(beforePrompt.sessions.filter((entry) => entry.targetId === `ssh:${f.profileId}`)).toEqual([])
    await expect(code.locator('.unified-session-row').filter({ hasText: 'Local catalog conversation' })).toBeVisible()
    await expect(code.locator('.unified-session-row').filter({ hasText: 'New session' })).toHaveCount(0)
    // New remote project, no history yet: selecting a model must load its real
    // Effort capabilities on the hidden probe, not require the first model prompt.
    await code.locator('[data-composer-model-chip]').click()
    await win.getByRole('dialog', { name: 'Select Model', exact: true }).getByRole('button', { name: /Remote fixture model — fixture/ }).click()
    await code.locator('[data-composer-thinking-chip]').click()
    const draftEffort = win.getByRole('slider', { name: 'Effort', exact: true })
    await expect(draftEffort).toHaveAttribute('aria-disabled', 'false')
    await draftEffort.press('End')
    await expect.poll(async () => (await ui(win)).runState.thinkingLevel).toBe('high')
    await win.keyboard.press('Escape')
    expect((await invoke<SessionCatalogResult>(win, 'code.sessions.list', { filter: remoteId })).sessions).toEqual([])
    await expect(win.getByRole('button', { name: 'Code', exact: true })).toBeEnabled()
    await expect(code.locator('.reference-code-session-controls')).toHaveCount(0)
    const drawer = code.getByRole('complementary', { name: 'Workspace panel', exact: true })
    if (!await drawer.count()) await code.getByRole('button', { name: 'Open workspace panel', exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('tablist', { name: 'Workspace functions' })).toHaveCount(1)
    await expect(drawer.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(1)
    await expect(drawer.getByRole('button', { name: 'Toggle terminal', exact: true })).toHaveCount(1)
    await test.step('Files panel lists and reads only the remote sentinel', async () => {
      const listing = await invoke(win, 'workspace.fs.listDir', { workspaceRoot: remoteId })
      expect(listing.ok).toBe(true)
      expect(listing.entries.map((entry: any) => entry.name)).toContain('REMOTE_ONLY.txt')
      expect(JSON.stringify(listing)).not.toContain('LOCAL_ONLY.txt')
      const file = await invoke(win, 'workspace.fs.readText', { workspaceRoot: remoteId, path: 'REMOTE_ONLY.txt' })
      expect(file.text).toBe('REMOTE_FILESYSTEM_SENTINEL\n')
      await drawer.getByRole('tab', { name: 'Files', exact: true }).click()
      const files = code.locator('.workspace-files-panel')
      await expect(files.getByText('REMOTE_ONLY.txt', { exact: true })).toBeVisible()
      await expect(files.getByText('LOCAL_ONLY.txt', { exact: true })).toHaveCount(0)
      await files.getByText('REMOTE_ONLY.txt', { exact: true }).dblclick()
      await expect(files).toContainText('REMOTE_FILESYSTEM_SENTINEL')
      await expect(files).not.toContainText('LOCAL_NOT_REMOTE')
    })

    await test.step('real Git status/diff appears in Review', async () => {
      const catalog = await invoke(win, 'rightPanels.catalog', { workspaceId: remoteId }).catch((error) => ({ error: String(error) }))
      expect.soft(catalog, 'Remote panel catalog must preserve enabled Review without local adapter probing').toMatchObject({ prefs: { review: true } })
      const diff = await invoke(win, 'review.getDiff', { cwd: remoteId, scope: 'git' })
      expect(diff.diff.isRepo).toBe(true)
      expect(JSON.stringify(diff)).toContain('REMOTE_GIT_CHANGED')
      expect(JSON.stringify(diff)).not.toContain('LOCAL_NOT_REMOTE')
      expect(JSON.stringify(await invoke(win, 'git.branchStatus', { cwd: remoteId }))).toContain('fixture-branch')
      const reviewButton = drawer.getByRole('tab', { name: 'Review', exact: true })
      await expect.soft(reviewButton, 'Configured Review must be available on the SSH workbench').toBeVisible({ timeout: 5000 })
      if (!await reviewButton.count()) return // Already failed; continue independent PTY/RPC checks.
      await reviewButton.click()
      const review = code.locator('.review-panel')
      await review.getByRole('button', { name: 'Git workspace', exact: true }).click()
      await expect(review).toContainText('sentinel.txt')
      await review.getByRole('button', { name: 'Expand all', exact: true }).click()
      await expect(review).toContainText('REMOTE_GIT_CHANGED')
    })

    await test.step('a real remote PTY echoes and resizes through production terminal IPC', async () => {
      await win.evaluate(() => {
        ;(window as any).__remotePtyEvents = []
        ;(window as any).__offRemotePty = (window as any).piDesktop.onTerminalData((event: unknown) => (window as any).__remotePtyEvents.push(event))
      })
      const term = await invoke(win, 'terminal.create', { cwd: remoteId, profileId: 'remote-default', cols: 83, rows: 27 })
      terminalId = term.id
      expect(terminalId).toMatch(/^ssh-term-/)
      await invoke(win, 'terminal.resize', { id: terminalId, cols: 101, rows: 33 })
      // Construct sentinel in the shell so a typed-command echo cannot satisfy the assertion.
      await win.evaluate(({ id }) => (window as any).piDesktop.terminalWrite(id, `printf 'REMOTE_PTY_%s\\n' "$((39+3))"; pwd; stty size\n`), { id: terminalId })
      await expect.poll(async () => win.evaluate((id) => (window as any).__remotePtyEvents.filter((e: any) => e.id === id).map((e: any) => e.data).join(''), terminalId)).toContain('REMOTE_PTY_42')
      const output = await win.evaluate((id) => (window as any).__remotePtyEvents.filter((e: any) => e.id === id).map((e: any) => e.data).join(''), terminalId)
      expect(output).toContain(f.remote)
      expect(output).toContain('33 101')
      expect(output).not.toContain(f.local)
    })

    await test.step('SAME composer streams into SAME Timeline and persists private remote history', async () => {
      const models = await invoke(win, 'model.list', { workspaceId: remoteId })
      expect(models.models).toContainEqual(expect.objectContaining({ id: 'fixture-model', name: 'Remote fixture model', provider: 'fixture', contextWindow: 64000 }))
      await win.evaluate(() => {
        ;(window as any).__remoteAppEvents = []
        ;(window as any).__offRemoteApp = (window as any).piDesktop.onEvent((event: unknown) => (window as any).__remoteAppEvents.push(event))
      })
      const composer = code.getByRole('textbox', { name: 'Describe a task or ask a question', exact: true })
      await composer.fill('Remote integration prompt from the SAME composer')
      await composer.press('Enter')
      await expect(code.locator('.timeline-prose-row').filter({ hasText: 'REMOTE_FIXTURE_STREAM:' })).toHaveText('REMOTE_FIXTURE_STREAM:')
      expect((await ui(win)).runState.status).toBe('running')
      const timelineNode = await code.locator('.timeline-scroll-viewport').elementHandle()
      await expect(code.locator('.timeline-prose-row').filter({ hasText: REMOTE_REPLY })).toBeVisible()
      expect(await timelineNode!.evaluate((node) => node === document.querySelector('[aria-label="Code workspace"] .timeline-scroll-viewport'))).toBe(true)
      await sameWorkbench('ssh')
      await expect.poll(async () => (await ui(win)).runState.status).toBe('idle')
      const events = await win.evaluate(() => (window as any).__remoteAppEvents)
      expect(events).toContainEqual(expect.objectContaining({ type: 'run', phase: 'running', usage: { input: 120, output: 24, cacheRead: 8, cacheWrite: 4, cost: 0.00372 } }))
      expect.soft({ usage: (await ui(win)).runState.usage }, 'Real remote usage events must reach the SAME composer usage store').toMatchObject({ usage: { input: 120, output: 24, cost: REMOTE_USAGE.cost.total } })
      const activity = code.locator('.timeline-tool-group').first()
      await expect(activity).toContainText(/2 commands/)
      const disclosure = activity.locator('button[aria-expanded]').first()
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      const transcriptType = await code.locator('.timeline-text-body').first().evaluate((element) => ({ body: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize, shell: getComputedStyle(document.querySelector('.reference-shell')!).fontFamily }))
      expect(transcriptType.body).toBe(transcriptType.shell)
      expect(transcriptType.size).toBe('16px')
      await drawer.getByRole('button', { name: 'Close workspace panel', exact: true }).click()
      await expect(drawer).toBeHidden()
      await win.screenshot({ path: 'test-results/reference-continuous-code-stream.png' })
      await code.getByRole('button', { name: 'Open workspace panel', exact: true }).click()
      await expect(drawer.getByRole('tab', { name: 'Review', exact: true })).toHaveAttribute('aria-selected', 'true')
      await disclosure.click()
      await expect(activity).toContainText('CONTROLLED_COMMAND_ONE')
      await expect(activity).toContainText('CONTROLLED_COMMAND_TWO')
      await disclosure.click()
      const sessions = await invoke(win, 'session.list', { workspaceId: remoteId })
      expect(sessions.sessions).toHaveLength(1)
      const session = sessions.sessions[0]
      expect(session.sessionFile).toMatch(/^\/__pi_ssh__\/.+\/\.sessions\/.+\.jsonl$/)
      expect(session.workspaceId).toBe(remoteId)
      expect(session.title).toContain('Remote integration prompt')
      expect(JSON.stringify(await invoke(win, 'session.getMessages', { sessionFile: session.sessionFile }))).toContain(REMOTE_REPLY)
      const starts = piStarts(f)
      expect(starts.length).toBeGreaterThan(0)
      expect(starts.every((start) => start.cwd === f.remote && start.home === f.remoteHome && !start.envKeys.includes('PI_CODING_AGENT_DIR'))).toBe(true)
      // Metadata and explicit user sessions may have distinct runtimes. Inspect the
      // transcript actually selected by the session list, not the first utility start.
      const userStart = starts.find((start) => {
        const file = start.argv[start.argv.indexOf('--session') + 1]
        return !!file && existsSync(file) && JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]).id === session.sessionId
      })
      expect(userStart).toBeDefined()
      const argv = userStart!.argv
      const sessionFile = argv[argv.indexOf('--session') + 1]
      const sessionDir = argv[argv.indexOf('--session-dir') + 1]
      expect(sessionFile.startsWith(`${f.remoteHome}/.pi/desktop-code/sessions/`)).toBe(true)
      expect(sessionFile.startsWith(sessionDir + '/')).toBe(true)
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600)
      const rows = readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(rows[0]).toMatchObject({ type: 'session', version: 3, cwd: f.remote, id: session.sessionId })
      expect(Number.isFinite(Date.parse(rows[0].timestamp))).toBe(true)
      expect(rows.some((row) => row.type === 'message' && row.message.role === 'user')).toBe(true)
      expect(rows.find((row) => row.message?.role === 'assistant' && row.message.content?.some((part: { text?: string }) => part.text === REMOTE_REPLY)).message).toMatchObject({ usage: REMOTE_USAGE, content: [{ type: 'text', text: REMOTE_REPLY }] })
      await win.screenshot({ path: 'test-results/reference-unified-ssh-working.png' })
      // Live usage is real reported data. Restored views below reload their own remote
      // stats instead of copying whichever live turn happened to be foreground.
      await code.getByRole('button', { name: 'Context window and usage', exact: true }).click()
      const usage = win.getByRole('dialog', { name: 'Context window and usage', exact: true })
      await usage.getByRole('button', { name: 'Show details', exact: true }).click()
      await expect(usage, 'Usage popover must show reported remote tokens').toContainText('120 / 24')
      await expect(usage, 'Usage popover must show reported remote cost').toContainText('$0.0037')
      await expect(usage).toContainText('Your desktop account was not queried.')
      await win.screenshot({ path: 'test-results/reference-unified-ssh-usage.png' })
      await win.keyboard.press('Escape')
      await expect(code.locator('.unified-session-row').filter({ hasText: 'Remote integration prompt' })).toBeVisible()
      await code.getByRole('button', { name: 'Filter sessions', exact: true }).click()
      await win.getByRole('menuitemradio', { name: 'Local', exact: true }).click()
      await expect(code.locator('.unified-session-row').filter({ hasText: 'Remote integration prompt' })).toHaveCount(0)
      await code.locator('.unified-session-row').filter({ hasText: 'Local catalog conversation' }).locator('.unified-session-open').click()
      await sameWorkbench('local')
      await expect(code.locator('.timeline-prose-row').filter({ hasText: 'LOCAL_CATALOG_REPLY' })).toBeVisible()
      await code.getByRole('button', { name: 'Filter sessions', exact: true }).click()
      await win.getByRole('menuitemradio', { name: 'SSH', exact: true }).click()
      await code.locator('.unified-session-row').filter({ hasText: 'Remote integration prompt' }).locator('.unified-session-open').click()
      await sameWorkbench('ssh')
      await expect(code.locator('.timeline-prose-row').filter({ hasText: REMOTE_REPLY })).toBeVisible()
      await expect.poll(async () => (await ui(win)).runState.availableThinkingLevels).toContain('high')
      await code.locator('[data-composer-thinking-chip]').click()
      const effort = win.getByRole('slider', { name: 'Effort', exact: true })
      await expect(effort).toHaveAttribute('aria-disabled', 'false')
      await effort.press('Home')
      await expect.poll(async () => (await ui(win)).runState.thinkingLevel).toBe('off')
      await effort.press('End')
      await expect.poll(async () => (await ui(win)).runState.thinkingLevel).toBe('high')
      await win.keyboard.press('Escape')
      await code.getByRole('button', { name: 'Context window and usage', exact: true }).click()
      const restoredUsage = win.getByRole('dialog', { name: 'Context window and usage', exact: true })
      await expect(restoredUsage.locator('.code-usage-heading')).toContainText('64.0k')
      await expect(restoredUsage.locator('.code-usage-heading')).not.toContainText('Unavailable')
      await restoredUsage.getByRole('button', { name: 'Show details', exact: true }).click()
      await expect(restoredUsage).toContainText('Context estimate reported by this remote Pi session')
      await expect(restoredUsage).toContainText('120 / 24')
      await win.screenshot({ path: 'test-results/reference-restored-remote-context-effort.png' })
      await win.keyboard.press('Escape')
      await expect(code.locator('.reference-account-summary small')).toHaveText('SSH · Fixture host')
      await code.getByRole('button', { name: 'Filter sessions', exact: true }).click()
      await win.getByRole('menuitemradio', { name: 'All sessions', exact: true }).click()
      await code.getByRole('button', { name: 'Filter sessions', exact: true }).click()
      await win.screenshot({ path: 'test-results/reference-unified-session-filter.png' })
      await win.keyboard.press('Escape')

      await win.getByRole('button', { name: 'Account and settings', exact: true }).click()
      await win.getByRole('menuitem', { name: /^Settings(?:\s|$)/ }).click()
      const settingsDialog = win.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(settingsDialog).toBeVisible()
      await expect(settingsDialog.locator('[data-settings-active-page="general"]')).toBeVisible()
      await expect(settingsDialog.locator('.settings-page-header h2')).toHaveText('General')
      await sameWorkbench('ssh')
      await win.screenshot({ path: 'test-results/reference-unified-ssh-settings.png' })
      await settingsDialog.getByRole('button', { name: 'Close Settings', exact: true }).click()

      await win.getByLabel('Code execution environment').click()
      await win.getByRole('menuitem', { name: 'Local', exact: true }).click()
      await sameWorkbench('local')
      await expect.poll(async () => (await ui(win)).workspace).toBe(f.local)
      expect((await invoke(win, 'settings.get', { key: 'currentProject' })).settings.currentProject).toBe(f.local)
      expect((await ui(win)).recentProjects).toEqual([f.local])
      // Local is restored to project home; open Files through its real command-palette action.
      await expect(win.getByRole('button', { name: 'Code', exact: true })).toBeEnabled()
      await win.keyboard.press('Control+k')
      await win.getByRole('option', { name: /^Open Files panel/ }).click()
      await expect(code.locator('.workspace-files-panel')).toContainText('LOCAL_ONLY.txt')
      await expect(code.locator('.workspace-files-panel')).not.toContainText('REMOTE_ONLY.txt')
      // The old remote resource stays pinned even after Local becomes foreground.
      expect(JSON.stringify(await invoke(win, 'session.getMessages', { sessionFile: session.sessionFile }))).toContain(REMOTE_REPLY)
      expect((await invoke(win, 'workspace.fs.readText', { workspaceRoot: remoteId, path: 'REMOTE_ONLY.txt' })).text).toBe('REMOTE_FILESYSTEM_SENTINEL\n')
      await win.keyboard.press('Control+Backquote')
      await expect(code.locator('.terminal-drawer .xterm-rows').first()).toBeVisible()
      await code.locator('.terminal-drawer .xterm').first().click()
      await win.keyboard.type("printf 'LOCAL_FOREGROUND_%s\\n' 731\n")
      await expect(code.locator('.terminal-drawer .xterm-rows').first()).toContainText('LOCAL_FOREGROUND_731')
      const remoteOutput = await win.evaluate((id) => (window as any).__remotePtyEvents.filter((e: any) => e.id === id).map((e: any) => e.data).join(''), terminalId)
      expect(remoteOutput).not.toContain('LOCAL_FOREGROUND_731')
      await invoke(win, 'terminal.resize', { id: terminalId, cols: 90, rows: 29 })
      expect((await ui(win)).workspace).toBe(f.local)
      // Clean UI-created local PTYs before Electron's close guard.
      await win.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.terminal-drawer [aria-label="Close terminal"]').forEach((button) => button.click()))

      // One targeted integration for the user's deletion bug: real row menu, explicit
      // in-app confirmation, exact helper-owned file, current-view reset, no local fallback.
      const remoteRow = code.locator('.unified-session-row').filter({ hasText: 'Remote integration prompt' })
      await remoteRow.locator('.unified-session-open').click()
      await sameWorkbench('ssh')
      await expect(code.locator('.timeline-prose-row').filter({ hasText: REMOTE_REPLY })).toBeVisible()
      await remoteRow.getByRole('button', { name: /^Session actions:/ }).click()
      await win.getByRole('menu').getByRole('button', { name: 'Delete', exact: true }).click()
      const confirmDelete = win.getByRole('dialog', { name: 'Delete', exact: true })
      await expect(confirmDelete).toContainText('permanently removed')
      await confirmDelete.getByRole('button', { name: 'OK', exact: true }).click()
      await expect(remoteRow).toHaveCount(0)
      await expect(code.getByRole('region', { name: 'Code home' })).toBeVisible()
      await sameWorkbench('ssh')
      expect((await ui(win)).workspace).toBe(remoteId)
      expect(existsSync(sessionFile)).toBe(false)
      expect((await invoke<SessionCatalogResult>(win, 'code.sessions.list')).sessions.some((entry) => entry.sessionFile === session.sessionFile)).toBe(false)
      expect(JSON.stringify(await invoke(win, 'workspace.fs.listDir', { workspaceRoot: remoteId }))).toContain('REMOTE_ONLY.txt')
      const startsBeforeHome = piStarts(f).length
      await code.getByRole('button', { name: 'Select project folder', exact: true }).click()
      await win.getByRole('menuitem', { name: 'No project · Remote home', exact: true }).click()
      const homeTrust = win.getByRole('dialog', { name: 'Use remote home without a project?', exact: true })
      await expect(homeTrust).toContainText('not a private scratch folder or a sandbox')
      await homeTrust.getByRole('button', { name: 'Trust remote home', exact: true }).click()
      await expect(code.getByRole('button', { name: 'Select project folder', exact: true })).toContainText('No project')
      await expect(code.locator('.reference-code-branch-group')).toHaveCount(0)
      await sameWorkbench('ssh')
      expect((await ui(win)).workspace).not.toBe(remoteId)
      // The UI may lazily discover remote models/commands after HOME is trusted.
      // Those probes must stay remote and must not materialize a visible conversation.
      expect(piStarts(f).slice(startsBeforeHome).every((start) => start.cwd === f.remoteHome && start.home === f.remoteHome)).toBe(true)
      expect((await invoke<SessionCatalogResult>(win, 'code.sessions.list', { filter: (await ui(win)).workspace })).sessions).toEqual([])
      await expect(code.locator('.unified-session-row').filter({ hasText: 'New session' })).toHaveCount(0)
      await win.screenshot({ path: 'test-results/reference-remote-no-project.png' })
    })
    expect(errors).toEqual([])
  } finally {
    const diagnostics = { errors, ui: await ui(win).catch(() => null), piStarts: piStarts(f), sshStarted: existsSync(f.sshMarker), events: await win.evaluate(() => ({ app: (window as any).__remoteAppEvents, terminal: (window as any).__remotePtyEvents })).catch(() => null) }
    writeFileSync(testInfo.outputPath('remote-host-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
    writeFileSync(testInfo.outputPath('last-dom.txt'), await win.locator('body').ariaSnapshot().catch(() => 'unavailable'))
    await win.screenshot({ path: testInfo.outputPath('last-screen.png') }).catch(() => {})
    if (terminalId) await invoke(win, 'terminal.kill', { id: terminalId }).catch(() => {})
    try { await f.close() } finally { await new Promise<void>((resolve) => localModel.close(() => resolve())) }
  }
})
