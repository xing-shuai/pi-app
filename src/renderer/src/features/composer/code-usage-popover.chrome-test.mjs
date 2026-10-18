// From pi-desktop: node src/renderer/src/features/composer/code-usage-popover.chrome-test.mjs
// Real components and CSS in installed Chrome. Only transport/store fixtures are substituted.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

const base = 'src/renderer/src/'
const en = JSON.parse(await readFile(`${base}locales/en/composer.json`, 'utf8'))
const fixture = {
  status: 'ready', semantics: 'subscription-allowance', provider: 'openai-codex', displayLabel: 'OpenAI Codex · subscription allowance', plan: 'pro', stale: false,
  windows: [
    { id: 'codex:primary', label: 'Codex · Primary limit', usedPercent: 9, remainingPercent: 91, windowSeconds: 604800, resetAt: new Date(Date.now() + 86400000).toISOString() },
    { id: 'codex:secondary', label: 'Codex · Secondary limit', usedPercent: 12, remainingPercent: 88, windowSeconds: 18000 },
    ...Array.from({ length: 16 }, (_, index) => ({ id: `additional-${index}:primary`, label: `Additional model ${index} with a deliberately long real provider label`, usedPercent: 25, remainingPercent: 75 })),
  ], balances: [], credits: { amount: '61907.3115230000', available: true }, fetchedAt: new Date().toISOString(), exhausted: false,
}
const bundled = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {CodeUsagePopover} from './${base}features/composer/code-usage-popover';
      import {ComposerToolsMenu} from './${base}features/composer/composer-tools-menu';
      window.calls=[]; window.fixture=${JSON.stringify(fixture)};
      createRoot(document.getElementById('root')).render(<div id="toolbar"><CodeUsagePopover metrics={{estContextTokens:23300,contextWindow:1000000,ctxPct:2.33}}/><ComposerToolsMenu/></div>);`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  alias: { '@renderer': resolve(base), '@shared': resolve('packages/shared') },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /(?:ipc-client|ui-store|react-i18next)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /./, namespace: 'fixture' }, (args) => {
      if (args.path.endsWith('ipc-client')) return { contents: `export const ipcClient={invoke:async(method,payload)=>{window.calls.push([method,payload]); if(method==='providerUsage.get')return window.fixture; if(method==='capabilities.catalog')return {capabilities:[{id:'pi-ui',available:true,promptTokens:2300,tools:0},{id:'browser',available:false,reason:'browser-panel-off',promptTokens:1200,tools:12},{id:'chrome',available:false,reason:'chrome-off',promptTokens:1400,tools:15}]};return {ok:true,settings:{cacheWarming:'streaming'}}}}` }
      if (args.path.endsWith('ui-store')) return { contents: `const state={currentWorkspace:'/work',historySessionFile:'/session',currentSessionId:'A',runState:{model:'codex',usage:{input:211,output:227,cacheRead:44200,cacheWrite:0,cost:0.0071}}};export const useUIStore=(select)=>select(state);useUIStore.getState=()=>state;` }
      return { contents: `const en=${JSON.stringify(en)};export const useTranslation=()=>({t:(key,args={})=>{let v=key.replace('composer:','').split('.').reduce((o,k)=>o?.[k],en)??key;return String(v).replace(/{{(.*?)}}/g,(_,k)=>args[k]??'')}});` }
    })
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }))
  } }],
})
const globals = await readFile(`${base}styles/globals.css`, 'utf8')
const compiled = await postcss([tailwindcss()]).process(globals, { from: `${base}styles/globals.css` })
const compact = await readFile(`${base}styles/compact-composer-popovers.css`, 'utf8')
const existing = (await Promise.all(['desktop-detail-overlays.css', 'compact-scroll-wrap.css', 'product-typography.css'].map((name) => readFile(`${base}styles/${name}`, 'utf8')))).join('\n')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  for (const viewport of [{ width: 320, height: 560 }, { width: 280, height: 300 }]) for (const zoom of [1, 5 / 6]) for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: dpr })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Owned CSS deliberately precedes existing globals/overlays to catch specificity regressions.
    await page.setContent(`<html class="dark" style="zoom:${zoom};--ui-zoom:${zoom}"><head><style>${compiled.css}\n${compact}\n${existing}\nbody{margin:0}#toolbar{position:fixed;bottom:16px;left:16px;right:16px;display:flex;justify-content:space-between}</style></head><body><div id="root"></div><div class="xterm" id="terminal-probe" style="overflow:auto;width:100px;height:20px"><div style="height:100px">terminal</div></div></body></html>`)
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    assert.equal(await page.evaluate(() => window.calls.filter(([method]) => method === 'providerUsage.get').length), 0)
    await page.getByRole('button', { name: 'Context window and usage' }).click()
    await page.getByRole('heading', { name: 'OpenAI Codex · pro' }).waitFor()
    const measure = async (selector) => page.locator(selector).evaluate((element) => {
      const root = element.closest('[role="dialog"]'), rect = root.getBoundingClientRect(), css = getComputedStyle(root)
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, scroll: element.scrollHeight > element.clientHeight, scrollbar: getComputedStyle(element, '::-webkit-scrollbar').width, button: getComputedStyle(element, '::-webkit-scrollbar-button').display, track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor, background: css.backgroundColor, radius: css.borderRadius }
    })
    let result = await measure('.code-usage-content')
    assert.ok(result.x >= 0 && result.right <= viewport.width && result.y >= 0 && result.bottom < viewport.height, JSON.stringify(result))
    assert.ok(result.width <= 360 * zoom + 2 && result.height <= 420 * zoom + 1, JSON.stringify(result))
    if (viewport.height === 560) assert.equal(result.scroll, false, 'default usage must not be a large scroller')
    assert.equal(result.scrollbar, '4px')
    assert.equal(result.button, 'none')
    assert.equal(result.track, 'rgba(0, 0, 0, 0)')
    assert.equal(result.background, 'rgb(32, 32, 31)')
    assert.equal(result.radius, '12px')
    assert.equal(await page.getByText('≈61,907.31').getAttribute('data-app-tooltip'), '61907.3115230000')
    if (process.env.POPOVER_SCREENSHOTS && viewport.height === 560 && dpr === 1) await page.screenshot({ path: `/tmp/compact-usage-${zoom}.png` })
    await page.getByRole('button', { name: 'Show details' }).click()
    result = await measure('.code-usage-content')
    assert.ok(result.scroll && result.height <= 420 * zoom + 1, JSON.stringify(result))
    await page.locator('.code-usage-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.getByRole('button', { name: 'See detailed breakdown' }).waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => window.calls.filter(([method]) => method === 'providerUsage.get').length), 1, 'details/scroll must not query provider')
    await page.keyboard.press('Escape')
    await page.locator('[data-composer-tools]').click()
    await page.getByRole('switch', { name: 'pi-ui visuals' }).waitFor()
    result = await measure('.compact-tools-content')
    assert.ok(result.x >= 0 && result.right <= viewport.width && result.y >= 0 && result.height <= 420 * zoom + 1, JSON.stringify(result))
    if (process.env.POPOVER_SCREENSHOTS && viewport.height === 560 && dpr === 1) await page.screenshot({ path: `/tmp/compact-capabilities-${zoom}.png` })
    assert.equal(result.scrollbar, '4px')
    assert.equal(await page.getByRole('radio', { name: 'My Chrome' }).isDisabled(), true)
    assert.equal(await page.getByRole('radio', { name: 'Built-in' }).isDisabled(), true)
    const help = await page.locator('.compact-help').first().evaluate((element) => getComputedStyle(element).fontSize)
    assert.equal(help, '14px')
    assert.equal(await page.locator('.compact-capability-heading').first().evaluate((element) => getComputedStyle(element).fontSize), '16px')
    await page.locator('.compact-tools-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.getByRole('radio', { name: 'Also idle' }).click()
    assert.ok(await page.evaluate(() => window.calls.some(([method,payload]) => method === 'pi.settings.set' && payload.patch.cacheWarming === 'idle')))
    assert.equal(await page.locator('#terminal-probe').evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width === '4px'), false, 'owned rules must not style xterm')
    assert.deepEqual(errors, [])
    console.log(`PASS real Chrome: ${viewport.width}×${viewport.height}, zoom=${zoom}, DPR=${dpr}; compact default, long details, viewport clamp, native 4px/no buttons, capability actions, no xterm styling`)
    await context.close()
  }
} finally { await browser.close() }
