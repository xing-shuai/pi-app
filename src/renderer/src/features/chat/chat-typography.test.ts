import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve('src/renderer/src', path), 'utf8')
const css = [source('app/product-shell.css'), source('app/reference-layout.css'), source('features/chat/chat-refinements.css')].join('\n')
const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path): path is string => !!path && existsSync(path))

describe('Chat typography', () => {
  it('loads its own scoped styles without requiring a root import', () => {
    expect(source('features/chat/chat-page.tsx')).toContain("import './chat-refinements.css'")
    expect(source('features/chat/chat-refinements.css')).not.toContain('font-serif')
  })

  it.skipIf(!executablePath)('computes shared sans prose, mono code and preserves empty-state reference dimensions', async () => {
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
      await page.setContent(`<style>
        * { box-sizing: border-box; }
        :root { --font-sans: Arial, sans-serif; --font-mono: monospace; --font-serif-base: Georgia, serif; --prose-font: Georgia, serif; }
        .reference-shell { display: flex; width: 1280px; height: 800px; }
        ${css}
        .ssh-markdown { font-family: Georgia, serif; }
        .ssh-markdown p, .ssh-markdown li, .ssh-markdown h2 { font-family: Georgia, serif; }
      </style><div class="reference-shell"><div class="chat-product reference-chat">
        <aside class="product-sidebar"></aside><main class="chat-main reference-chat-main is-empty">
          <div class="chat-message-scroll"><div class="chat-welcome reference-chat-greeting"><h1>Morning, how are things?</h1></div></div>
          <div class="chat-composer-dock"><div class="chat-composer"><textarea></textarea><div class="chat-composer-actions"></div></div><div class="reference-chat-composer-meta"></div></div>
        </main>
      </div></div>
      <div class="chat-product reference-chat"><article class="chat-message assistant"><div class="chat-message-prose ssh-markdown"><h2>Heading</h2><p>Shared body <code>inline</code></p><ul><li>Item</li></ul><pre><code><span>const x = 1</span></code></pre></div></article><article class="chat-message user">Question</article></div>`)
      const result = await page.evaluate(() => {
        const style = (selector: string) => { const value = getComputedStyle(document.querySelector(selector)!); return { font: value.fontFamily, size: value.fontSize, lineHeight: value.lineHeight } }
        const rect = (selector: string) => { const value = document.querySelector(selector)!.getBoundingClientRect(); return { width: value.width, height: value.height } }
        return { greeting: style('h1'), body: style('.ssh-markdown p'), list: style('li'), heading: style('h2'), user: style('.chat-message.user'), code: style('p code'), nestedCode: style('pre span'), input: style('textarea'), sidebar: rect('aside'), composer: rect('.chat-composer') }
      })
      for (const name of ['greeting', 'body', 'list', 'heading', 'user', 'input'] as const) expect(result[name].font).toBe('Arial, sans-serif')
      for (const name of ['body', 'list', 'user', 'input'] as const) expect(result[name].size).toBe('16px')
      expect(result.body.lineHeight).toBe('26.4px')
      expect(result.greeting.size).toBe('33px')
      expect(result.heading.size).toBe('20px')
      expect(result.code).toMatchObject({ font: 'monospace', size: '14px' })
      expect(result.nestedCode).toMatchObject({ font: 'monospace', size: '14px' })
      expect(result.sidebar.width).toBe(290)
      expect(result.composer).toEqual({ width: 768, height: 122 })
    } finally { await browser.close() }
  })
})
