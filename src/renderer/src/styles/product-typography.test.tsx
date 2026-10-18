import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPageHeader } from '../features/settings/settings-shell'
import { SettingRow, SettingsSection } from '../features/settings/settings-page-shared'
import { btnCompact, inputCls, numberInputCls, textareaCls } from '../features/settings/settings-controls'
import { SshPasswordDialog } from '../features/ssh/ssh-password-dialog'
import { SshProfileForm } from '../features/ssh/ssh-profile-form'

const source = (path: string) => readFileSync(resolve('src/renderer/src', path), 'utf8')
const css = source('styles/product-typography.css')
const ast = postcss.parse(css)
const tailwindConfig = loadConfig(resolve('tailwind.config.ts'))
const browserPath = [process.env.CHROME_BIN, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((path): path is string => !!path && existsSync(path))

describe('secondary product typography CSS contracts', () => {
  it('only changes scoped typography, never reference geometry or density', () => {
    ast.walkRules((rule) => {
      expect(rule.selector).toContain('.reference-shell')
      expect(rule.selector).toMatch(/settings-layout|routines-product|ssh-workspace/)
      expect(rule.selector).not.toMatch(/\*|\[class[~*^$]?=/)
    })
    ast.walkDecls((decl) => {
      expect(decl.prop).toMatch(/^(--product-|font-family$|font-size$|line-height$|letter-spacing$)/)
      expect(decl.important).toBeFalsy()
      expect(decl.value).not.toMatch(/\d(?:\.\d+)?em\b/)
      if (decl.value.endsWith('px')) expect(Number.parseFloat(decl.value)).toBeGreaterThanOrEqual(12)
    })
    expect(css).not.toMatch(/zoom:|transform:|--ui-zoom|--chat-font-size|font-size:\s*inherit/)
    const shell = source('app/product-shell.tsx')
    expect(shell.match(/import '@renderer\/styles\/product-typography.css'/g)).toHaveLength(1)
  })

  it('covers every existing small Settings pixel utility, including half sizes', () => {
    const directory = resolve('src/renderer/src/features/settings')
    const classes = new Set(readdirSync(directory).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .flatMap((name) => readFileSync(resolve(directory, name), 'utf8').match(/text-\[(?:10|11|12|13)(?:\.5)?px\]/g) || []))
    expect(classes.size).toBeGreaterThanOrEqual(8)
    for (const cls of classes) {
      const escaped = cls.replace(/[\[\].]/g, '\\$&')
      expect(css, cls).toContain(`.${escaped}`)
    }
    for (const cls of ['text-2xs', 'text-xs', 'text-sm', 'text-base', 'settings-key', 'settings-badge']) {
      expect(css).toContain(`.${cls}`)
    }
  })
})

/* Real headless CSS measurements, not native Electron screenshots. Portable unit
   contracts above still run if neither Playwright Chromium nor CHROME_BIN exists. */
it.skipIf(!browserPath)('computes readable hierarchy even when SSH legacy CSS loads last; leaves reference UI unchanged', async () => {
  const profile = { id: 'typography', name: 'Development', host: 'dev.example', cwd: '/srv/project', piPath: 'pi', nodePath: 'node' }
  const noop = () => {}
  const markup = renderToStaticMarkup(<div className="reference-shell">
    <div className="reference-chat-main is-empty" data-reference="chat">
      <div className="reference-chat-greeting"><h1 data-reference="greeting">Hello</h1></div>
      <div className="chat-composer-dock" data-reference="dock"><div className="chat-composer"><textarea data-reference="composer" defaultValue="" /></div></div>
    </div>
    <div className="reference-code" data-reference="code">
      <div className="reference-code-home"><h1 data-reference="code-heading">Build something</h1></div>
      <nav className="reference-code-nav"><button data-reference="code-nav">New session<svg data-reference="code-icon" /></button></nav>
      <div data-composer-variant="reference"><div className="composer-shell" data-reference="code-composer"><div className="composer-input">Describe a task</div></div></div>
    </div>
    <nav className="reference-sidebar-nav"><button data-reference="reference-nav">Chat<svg width="16" height="16" data-reference="icon" /></button></nav>
    <div className="product-settings-workspace"><div className="settings-layout">
      <SettingsPageHeader title="Preferences" description="Page helper" />
      <div className="settings-nav-caption">Application</div><button className="settings-nav-item">General</button>
      <SettingsSection title="Appearance" description="Section helper">
        <SettingRow label="Language" description="Row helper" badge={<span className="settings-badge">Preview</span>}>
          <select><option>English</option></select>
        </SettingRow>
      </SettingsSection>
      <div id="compat">{['text-2xs', 'text-xs', 'text-sm', 'text-base', 'text-[10px]', 'text-[10.5px]', 'text-[11px]', 'text-[11.5px]', 'text-[12px]', 'text-[12.5px]', 'text-[13px]', 'text-[13.5px]'].map((cls, index) => <div key={cls} id={`legacy-${index}`} className={cls}>{cls}</div>)}</div>
      <input id="ui-input" className={inputCls} /><input id="number-input" className={numberInputCls} />
      <textarea id="code-input" className={`${textareaCls} text-[12px]`} defaultValue="{}" />
      <button id="compact" className={btnCompact}>Refresh</button>
      <div id="save-bar" className="text-sm">Saved <span className="text-2xs">Changed sections</span><button className="text-sm">Save</button></div>
      <p id="validation" className="text-[11px] leading-4">Invalid value</p>
      <pre id="settings-log" className="text-xs"><code>Log</code></pre>
    </div></div>
    <div className="routines-product">
      <nav className="reference-sidebar-nav"><button data-reference="routine-nav">Chat</button></nav>
      <nav className="routine-sidebar-list"><button>Review<small>Active</small></button></nav>
      <div className="routine-welcome"><h1>Routines</h1><p>Helper</p><button className="product-primary">Create</button></div>
      <form className="routine-editor"><h1>Edit</h1><label>Name<input /></label><select><option>Manual</option></select><textarea defaultValue="Instructions" /><label className="routine-checkbox"><input type="checkbox" />Enabled</label><label className="routine-permission-warning">Warning<span className="routine-checkbox">Confirm</span></label></form>
      <div className="routine-detail"><h1>Review</h1><h2 className="routine-history-title">History</h2><span className="routine-surface-badge">Code</span><div className="routine-run-status">Done</div><section className="routine-run-detail"><header>Result<button>Cancel</button></header><pre>Output</pre></section></div>
    </div>
    <div className="ssh-workspace">
      <div className="ssh-setup"><h1>Remote development</h1><p>Helper</p><SshProfileForm initial={profile} zh={false} onSave={async () => {}} onCancel={noop} /></div>
      <span className="ssh-prototype-badge">Prototype</span>
      <div className="ssh-composer-footer"><select><option>Model</option></select></div>
      <aside className="ssh-inspector"><textarea aria-label="Remote command" defaultValue="ls" /></aside>
      <pre className="ssh-console-output">Console</pre><details className="ssh-diagnostics"><pre>Diagnostics</pre></details>
      <article className="ssh-message assistant"><div><pre><code id="nested-code">const x = 1</code></pre></div></article>
      <SshPasswordDialog profile={profile} zh={false} onSubmit={noop} onCancel={noop} />
    </div>
  </div>)
  const globals = await postcss([tailwindcss({ ...tailwindConfig, content: [{ raw: markup, extension: 'html' }] })])
    .process(source('styles/globals.css'), { from: undefined })
  const legacy = [globals.css, source('app/product-shell.css'), source('app/reference-layout.css'), source('features/shell/reference-code.css')].join('\n')
  const sshCss = [source('features/ssh/ssh-workspace.css'), source('features/ssh/ssh-password.css')].join('\n')
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${legacy}\n${sshCss}</style>${markup}`)
    const referenceMetrics = () => page.locator('[data-reference]').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return [element.getAttribute('data-reference'), style.fontSize, style.fontFamily, style.lineHeight, style.width, style.height]
    }))
    const before = await referenceMetrics()
    await page.addStyleTag({ content: css })
    // Test asynchronous SSH imports after the shared stylesheet, too.
    await page.addStyleTag({ content: sshCss })
    expect(await referenceMetrics()).toEqual(before)
    const size = async (selector: string, pixels: number) => {
      const sizes = await page.locator(selector).evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontSize))
      expect(sizes.length, selector).toBeGreaterThan(0)
      expect(sizes, selector).toEqual(sizes.map(() => `${pixels}px`))
    }
    await size('.settings-page-title', 24)
    await size('.settings-section-title, .routine-history-title, .ssh-password-dialog h2', 18)
    await size('.settings-nav-item, .settings-row-label, .settings-row-control select, #ui-input, #number-input, #save-bar, #save-bar button', 16)
    await size('.settings-nav-caption, .settings-page-description, .settings-section-description, .settings-row-description, #validation, #compact, #code-input, #settings-log, #settings-log code', 14)
    await size('.settings-badge, #save-bar > span', 12)
    const expected = [12, 14, 16, 16, 12, 12, 14, 14, 14, 14, 16, 16]
    for (const [index, pixels] of expected.entries()) await size(`#legacy-${index}`, pixels)
    await size('.routine-welcome h1, .routine-editor h1, .routine-detail h1, .ssh-setup h1, .ssh-profile-form h2', 24)
    await size('.routine-sidebar-list > button, .routine-welcome > button, .routine-editor label:not(.routine-permission-warning), .routine-editor input:not([type=checkbox]), .routine-editor select, .routine-editor textarea, .routine-checkbox', 16)
    await size('.routine-sidebar-list small, .routine-welcome > p, .routine-permission-warning, .routine-run-detail > pre', 14)
    await size('.routine-surface-badge, .routine-run-status, .ssh-prototype-badge', 12)
    await size('.ssh-profile-form label, .ssh-profile-form input, .ssh-profile-form select, .ssh-actions button, .ssh-password-dialog input, .ssh-password-dialog > label, .ssh-composer-footer select', 16)
    await size('.ssh-hint, .ssh-password-privacy, .ssh-console-output, .ssh-diagnostics pre, .ssh-inspector > textarea, #nested-code, .ssh-message.assistant pre', 14)
    for (const selector of ['#code-input', '#number-input', '.routine-run-detail > pre', '#nested-code', '.ssh-console-output', '.ssh-inspector > textarea']) {
      expect(await page.locator(selector).evaluate((element) => getComputedStyle(element).fontFamily), selector).toContain('mono')
    }
    expect(await page.locator('#ui-input').evaluate((element) => getComputedStyle(element).fontFamily)).not.toContain('mono')
    expect(await page.locator('#validation').evaluate((element) => getComputedStyle(element).lineHeight)).toBe('22.4px')
    // Settings' portal boundary applies only while that surface exists.
    await page.locator('body').evaluate((body) => {
      body.insertAdjacentHTML('beforeend', '<div class="overlay-backdrop"><div class="overlay-panel"><p id="portal-helper" class="text-xs">Hint</p><input id="portal-input"><textarea id="portal-code" class="font-mono text-sm"></textarea></div></div>')
    })
    await size('#portal-helper, #portal-code', 14)
    await size('#portal-input', 16)
    await page.locator('.product-settings-workspace').evaluate((element) => element.remove())
    await size('#portal-helper', 11)
  } finally {
    await browser.close()
  }
}, 30_000)
