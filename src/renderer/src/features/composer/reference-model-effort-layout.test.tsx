import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReferenceModelMenu, placeModelMenus, placeModelSubmenu } from './reference-model-menu'

const browserPath = [process.env.CHROME_BIN, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path): path is string => !!path && existsSync(path))
afterEach(cleanup)

it.skipIf(!browserPath)('measures wrapped real menu DOM and side-panel viewport bounds under CSS zoom and DPR', async () => {
  const name = `Actual ${'long-unbroken-model-模型'.repeat(20)}`
  render(<ReferenceModelMenu models={[{ provider: 'actual', id: name, name, available: true }]} current={`actual/${name}`} recents={[]} pending={null} loading={false} anchorSelector="[data-test-anchor]" label="Model" onPick={vi.fn()} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'More models' }))
  const markup = document.body.innerHTML
  const css = readFileSync(resolve('src/renderer/src/styles/reference-model-effort.css'), 'utf8')
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#141414;font:16px sans-serif}button{border:0;background:none;color:inherit;font:inherit} ${css}</style>${markup}`)
    for (const zoom of [1, 1.25, 1.5]) {
      await page.evaluate(({ zoom, placement }) => {
        document.documentElement.style.zoom = String(zoom)
        Object.assign(document.querySelector<HTMLElement>('.reference-model-menu')!.style, { top: '', bottom: '', ...Object.fromEntries(Object.entries(placement).filter(([, value]) => value !== undefined).map(([key, value]) => [key, `${value}px`])) })
      }, { zoom, placement: placeModelMenus({ right: 950, top: 620 }, { width: 1000, height: 700 }, zoom) })
      const root = await page.locator('.reference-model-menu').first().boundingBox()
      expect(root).not.toBeNull()
      const childPlacement = placeModelSubmenu({ left: root!.x, right: root!.x + root!.width, bottom: root!.y + root!.height }, { width: 1000, height: 700 }, zoom)
      await page.evaluate((placement) => {
        Object.assign(document.querySelector<HTMLElement>('.reference-model-submenu')!.style, Object.fromEntries(Object.entries(placement).filter(([key]) => key !== 'side').map(([key, value]) => [key, `${value}px`])))
      }, childPlacement)
      const child = await page.locator('.reference-model-submenu').boundingBox()
      expect(child!.x).toBeGreaterThanOrEqual(7)
      expect(child!.x + child!.width).toBeLessThanOrEqual(993)
      expect(child!.y).toBeGreaterThanOrEqual(7)
      expect(child!.y + child!.height).toBeLessThanOrEqual(693)
      expect(root!.x + root!.width).toBeLessThanOrEqual(993)
      expect(await page.locator('.reference-model-name').first().evaluate((element) => ({ wrap: getComputedStyle(element).whiteSpace, overflow: element.scrollWidth > element.clientWidth + 1, height: element.clientHeight }))).toMatchObject({ wrap: 'normal', overflow: false })
      expect(await page.locator('.reference-model-name').first().evaluate((element) => element.clientHeight)).toBeGreaterThan(30)
    }
    await context.close()
  } finally { await browser.close() }
}, 30_000)
