// Run: node src/renderer/src/components/ui/app-tooltip-host.chrome-test.mjs
// Real layout regression at CSS uiZoom 5/6 and DPR 1/2; no application/backend needed.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const bundled = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {AppTooltipHost} from './src/renderer/src/components/ui/app-tooltip-host';
      createRoot(document.getElementById('root')).render(<><AppTooltipHost/><button id="anchor" data-app-tooltip="A short hint">Anchor</button></>);`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  alias: { '@renderer': resolve('src/renderer/src') },
  define: { 'process.env.NODE_ENV': '"production"' },
})
const css = await readFile('src/renderer/src/components/ui/app-tooltip-host.css', 'utf8')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: dpr })
    const page = await context.newPage()
    await page.setContent(`<style>html{zoom:${5 / 6};--ui-zoom:${5 / 6};--font-sans:Arial,sans-serif}body{margin:0}#anchor{position:absolute;left:300px;top:240px;width:100px;height:30px}${css}</style><div id="root"></div>`)
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.locator('#anchor').hover()
    await page.getByRole('tooltip').waitFor({ state: 'visible' })
    const result = await page.evaluate(() => {
      const bubble = document.querySelector('[role="tooltip"]')
      const b = bubble.getBoundingClientRect(), a = document.querySelector('#anchor').getBoundingClientRect(), s = getComputedStyle(bubble)
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, center: (a.left + a.right) / 2, anchorTop: a.top, font: s.fontSize, line: s.lineHeight, family: s.fontFamily, background: s.backgroundColor, pointer: s.pointerEvents }
    })
    assert.ok(Math.abs((result.left + result.right) / 2 - result.center) < 1, JSON.stringify(result))
    assert.ok(Math.abs(result.anchorTop - result.bottom - 8 * 5 / 6) < 1)
    assert.ok(result.width < 150, 'short hint must be content fitted')
    assert.equal(result.font, '14px')
    assert.equal(result.line, '19.6px')
    assert.match(result.family, /Arial/)
    assert.equal(result.background, 'rgb(38, 38, 37)')
    assert.equal(result.pointer, 'none')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('tooltip').count(), 0)
    await page.evaluate(() => {
      const a = document.querySelector('#anchor')
      a.style.left = '0px'; a.style.top = '0px'
      a.setAttribute('data-app-tooltip', 'A much longer hint '.repeat(40))
    })
    await page.mouse.move(790, 590)
    await page.locator('#anchor').hover()
    await page.getByRole('tooltip').waitFor({ state: 'visible' })
    const bounds = await page.getByRole('tooltip').boundingBox()
    assert.ok(bounds.x >= 6 && bounds.x + bounds.width <= 794)
    assert.ok(bounds.y > 20 && bounds.y + bounds.height <= 594)
    assert.ok(bounds.width <= 320 * 5 / 6 + 1)
    console.log(`PASS actual Chrome layout: uiZoom=5/6 DPR=${dpr}, short content-fit, font, flip/clamp, long wrapping, Escape`)
    await context.close()
  }
} finally { await browser.close() }
