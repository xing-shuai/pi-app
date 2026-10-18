import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatModelPicker } from '../features/chat/chat-model-picker'
import { ModelPicker } from '../features/composer/model-picker'
import { CodeBlockView } from '../features/timeline/code-block-view'
import MarkdownView from '../features/timeline/markdown-view'
import { FileSourcePreview } from '../features/workspace-files/file-source-preview'
import { LocalFolderDialog } from '../features/code-location/local-folder-dialog'
import { RemoteFolderDialog } from '../features/code-location/remote-folder-dialog'
import { OverlayScrollHost } from '../components/ui/overlay-scrollbar'
import { useUIStore } from '../stores/ui-store'

const { longId, output } = vi.hoisted(() => ({
  longId: `provider/${'unbroken-model-模型'.repeat(24)}`,
  output: `const path = "/${'verylongpath目录'.repeat(40)}"\n\treturn path // 保留换行\n`,
}))
vi.mock('@renderer/lib/available-models-cache', () => ({
  peekAvailableModels: () => [{ provider: 'provider', id: longId, name: longId, available: true }],
  isAvailableModelsPending: () => false,
  peekAvailableModelsError: () => null,
  refreshAvailableModels: async () => [],
  subscribeAvailableModels: () => () => {},
}))
vi.mock('@renderer/lib/model-thinking-bindings', () => ({ loadModelThinkingBindings: async () => {}, boundThinkingLevelFor: () => 'off' }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async () => ({})) }, onAppEvent: () => () => {} }))
vi.mock('@renderer/lib/shiki-highlighter', () => ({
  highlightCodeToHtml: async (text: string) => `<pre class="shiki"><code>${text.split('\n').map(line => `<span class="line"><span style="color: #adf">${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</span></span>`).join('\n')}</code></pre>`,
}))

const source = (path: string) => readFileSync(resolve('src/renderer/src', path), 'utf8')
const css = source('styles/compact-scroll-wrap.css')
const browserPath = [process.env.CHROME_BIN, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((path): path is string => !!path && existsSync(path))
afterEach(cleanup)

describe('compact scroll/wrap scope', () => {
  it('does not mutate typography, hide content, or disable scrollbars', () => {
    const ast = postcss.parse(css)
    ast.walkDecls(decl => {
      expect(decl.prop).not.toMatch(/^(font|line-height|letter-spacing|content$)/)
      expect(decl.important).toBeFalsy()
      if (decl.prop === 'overflow') expect(decl.value).toBe('visible')
      if (decl.prop === 'scrollbar-width') expect(['thin', 'auto']).toContain(decl.value)
      if (decl.prop === 'scrollbar-width' && decl.value === 'auto') {
        expect(decl.parent?.type).toBe('atrule')
        expect(decl.parent && 'params' in decl.parent ? decl.parent.params : '').toBe('selector(::-webkit-scrollbar)')
      }
      expect(`${decl.prop}:${decl.value}`).not.toMatch(/overflow-[xy]:hidden|display:none|user-select:none/)
    })
    expect(css).toContain('.xterm *')
    expect(css).toContain('[contenteditable] *')
    expect(css).toContain('forced-colors: active')
  })

  it('retains custom thumb drag and track hit-area behavior', () => {
    const view = render(<OverlayScrollHost showRailOnHostHover><div>Output</div></OverlayScrollHost>)
    const pane = view.container.querySelector<HTMLElement>('.overlay-scroll-pane')!
    const rail = view.container.querySelector<HTMLElement>('.overlay-scrollbar-rail')!
    Object.defineProperties(pane, { scrollHeight: { value: 300 }, clientHeight: { value: 100 } })
    Object.defineProperty(rail, 'clientHeight', { value: 100 })
    rail.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect
    fireEvent.scroll(pane)
    const thumb = rail.querySelector<HTMLElement>('[data-thumb="1"]')!
    fireEvent.mouseDown(thumb, { clientY: 10 })
    fireEvent.mouseMove(window, { clientY: 50 })
    expect(pane.scrollTop).toBeCloseTo(120)
    fireEvent.mouseUp(window)
    fireEvent.mouseDown(rail, { clientY: 70 })
    expect(pane.scrollTop).toBeCloseTo(160)
  })

  it('keeps original code copy payload despite Shiki wrapping', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<CodeBlockView code={output} lang="typescript" defaultExpanded />)
    await waitFor(() => expect(view.container.querySelector('.shiki code')?.textContent).toBe(output))
    fireEvent.click(view.container.querySelector('button')!)
    expect(writeText).toHaveBeenCalledWith(output)
  })
})

it.skipIf(!browserPath)('measures current rendered DOM in headless Chromium at 300px, including body portals and lazy CSS', async () => {
  // Render the real components first: this catches selector drift rather than
  // testing a made-up model picker or assuming portals have product ancestors.
  render(<><ChatModelPicker models={[{ provider: 'provider', id: longId, name: longId }]} value="" onChange={() => {}} /><ModelPicker /></>)
  fireEvent.click(screen.getByRole('button', { name: 'New chat model' }))
  const chatPortal = document.querySelector('.chat-model-popover')!.cloneNode(true) as HTMLElement
  act(() => useUIStore.setState({ modelPickerOpen: true }))
  await waitFor(() => expect(document.querySelector('.composer-popover')).not.toBeNull())
  const codePortal = document.querySelector('.composer-popover')!.cloneNode(true) as HTMLElement
  chatPortal.removeAttribute('style')
  codePortal.removeAttribute('style')
  expect(chatPortal.querySelectorAll('.chat-model-name')).toHaveLength(1)
  expect(codePortal.querySelectorAll('.picker-row .reference-model-name')).toHaveLength(1)
  cleanup()

  const codeView = render(<CodeBlockView code={output} lang="typescript" defaultExpanded />)
  await waitFor(() => expect(codeView.container.querySelector('.shiki code')?.textContent).toBe(output))
  const highlighted = codeView.container.innerHTML
  cleanup()
  // Full pre/source fallback is also real component markup. The numbered preview
  // is tested separately: its gutter must NOT be accidentally desynchronised.
  const largeSource = output.repeat(150)
  const plainPreview = renderToStaticMarkup(<FileSourcePreview code={largeSource} />)
  const numberedPreview = renderToStaticMarkup(<FileSourcePreview code={output} path="source.ts" />)
  const markdownView = render(<MarkdownView children={`A URL: https://example.test/${'long'.repeat(100)}\n\n| Path | Result |\n| --- | --- |\n| ${longId} | 内容${longId} |\n\n\`\`\`text\n${output}\`\`\``} />)
  const markdown = markdownView.container.innerHTML
  cleanup()
  const overlay = renderToStaticMarkup(<OverlayScrollHost><button>Focus content</button></OverlayScrollHost>)
  const folder = { path: `/${longId}`, home: '/home/test', entries: [{ name: longId, path: `/${longId}/child`, directory: true as const }] }
  const local = render(<LocalFolderDialog initialPath={folder.path} recentPaths={[folder.path]} browse={async () => ({ ...folder, parent: '/', roots: [{ name: longId, path: '/' }], truncated: false })} resolve={async path => ({ path, name: longId })} onSelect={() => {}} onClose={() => {}} />)
  await waitFor(() => expect(local.container.querySelector('.local-folder-list > button > span')?.textContent).toBe(longId))
  const localDirectory = local.container.querySelector('.code-location-dialog')!.outerHTML
  cleanup()
  const remote = render(<RemoteFolderDialog initialPath={folder.path} hostLabel="Development" browse={async () => folder} onSelect={() => {}} onClose={() => {}} />)
  await waitFor(() => expect(remote.container.querySelector('.remote-folder-list')?.textContent).toContain(longId))
  const directory = remote.container.querySelector('.code-location-dialog')!.outerHTML
  cleanup()
  const markup = `
    <section class="fixture portal-chat">${chatPortal.outerHTML}</section>
    <section class="fixture portal-code">${codePortal.outerHTML}</section>
    <section class="fixture chat"><div class="chat-message-scroll" tabindex="0"><article class="chat-message assistant"><div class="chat-message-prose">${markdown}</div></article></div></section>
    <section class="fixture reference-code"><div class="timeline-scroll-viewport"><div class="chat-content-column"><div class="prose-chat">${markdown}</div><div class="tool-call-body">${highlighted}<div class="overflow-auto"><div class="flex gap-1"><span class="shrink-0">${longId}</span><span class="shrink-0">:123</span><span class="min-w-0 flex-1 truncate">${longId}</span></div></div></div></div></div></section>
    <section class="fixture directory">${directory}</section>
    <section class="fixture local-directory">${localDirectory}</section>
    <section class="fixture plain-source">${plainPreview}</section>
    <section class="fixture numbered-source">${numberedPreview}</section>
    <section class="fixture custom-overlay">${overlay}</section>
    <section class="fixture protected"><div class="prose-chat"><div class="xterm"><pre class="xterm-rows">${longId}</pre><div class="xterm-viewport overflow-auto"></div><canvas width="250" height="20"></canvas></div><input value="${longId}"><textarea>${output}</textarea><div contenteditable="true"><code>${output}</code></div><button class="control">Copy</button></div></section>`
  const tailwindConfig = loadConfig(resolve('tailwind.config.ts'))
  const globals = await postcss([tailwindcss({ ...tailwindConfig, content: [{ raw: markup, extension: 'html' }] })])
    .process(source('styles/globals.css'), { from: undefined })
  const productCss = [source('app/product-shell.css'), source('app/reference-layout.css'), source('features/chat/chat-refinements.css'), source('features/code-location/code-location.css')].join('\n')
  const lazyCodeCss = [source('features/shell/reference-code.css'), source('styles/timeline-reference-stream.css'), source('styles/reference-model-effort.css')].join('\n')
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } })
    await page.setContent(`<style>${globals.css}\n${source('styles/scrollbar-overlay.css')}\n${productCss}\n${lazyCodeCss}</style><style>
      .fixture { width: 300px; margin: 10px; }
      .fixture .chat-model-popover, .fixture .composer-popover { position: static; width: 300px; max-height: 240px; }
      .fixture .code-location-dialog { max-width: 100%; width: 300px; }
      .fixture .chat-message-scroll { max-height: 280px; padding: 8px; }
      .fixture .timeline-scroll-viewport { max-height: 400px; }
      .fixture .files-preview-scroll-host { height: 200px; }
      .custom-overlay .overlay-scroll-host { height: 100px; }
      .protected pre, .protected [contenteditable] code { white-space: pre; overflow-wrap: normal; }
    </style>${markup}`)
    const protectedMetrics = () => page.locator('.protected :is(pre, input, textarea, [contenteditable], code, canvas, .xterm-viewport, .control)').evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el)
      return [style.whiteSpace, style.overflowWrap, style.wordBreak, style.fontSize, style.fontFamily, style.lineHeight, style.scrollbarWidth, style.width, style.height]
    }))
    const before = await protectedMetrics()
    const monoBefore = await page.locator('.tool-call-body pre code').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize])
    const selectCode = () => page.locator('.tool-call-body pre code').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      return selection.toString()
    })
    const selectionBefore = await selectCode()
    await page.addStyleTag({ content: css })
    // Verify specificity even if the lazy Code and Chat style chunks arrive later.
    await page.addStyleTag({ content: `${productCss}\n${lazyCodeCss}` })
    expect(await protectedMetrics()).toEqual(before)
    expect(await page.locator('.tool-call-body pre code').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize])).toEqual(monoBefore)
    expect(monoBefore[0]).toContain('mono')
    const noOverflow = async (selector: string) => {
      const sizes = await page.locator(selector).evaluateAll(elements => elements.map(el => [el.clientWidth, el.scrollWidth]))
      expect(sizes.length, selector).toBeGreaterThan(0)
      for (const [client, scroll] of sizes) expect(scroll, `${selector}: ${client}/${scroll}`).toBeLessThanOrEqual(client + 1)
    }
    for (const selector of [
      '.chat-model-list', '.chat-model-option', '.reference-model-scroll', '.picker-row',
      '.chat-message-scroll', '.chat-message-prose pre', '.chat-message-prose table',
      '.timeline-scroll-viewport', '.reference-code .prose-chat pre', '.reference-code table',
      '.tool-call-body .native-code-shiki', '.tool-call-body .overflow-auto',
      '.remote-folder-list', '.remote-folder-breadcrumb', '.plain-source .overlay-scroll-pane',
      '.local-folder-list', '.local-folder-list > button', '.local-folder-breadcrumb', '.local-folder-recents',
    ]) await noOverflow(selector)
    for (const selector of ['.chat-message-prose pre', '.tool-call-body pre', '.tool-call-body pre code']) {
      expect(await page.locator(selector).first().evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
    }
    expect(await page.locator('.tool-call-body pre code').textContent()).toBe(output)
    expect(await selectCode()).toBe(selectionBefore)
    expect(await page.locator('.plain-source pre').textContent()).toBe(largeSource)
    expect(await page.locator('.numbered-source pre').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre')
    expect(await page.locator('.numbered-source [aria-hidden] .tabular-nums').count()).toBe(output.split('\n').length)

    // Chromium uses actual 4px WebKit rails (standard thin overrides their width).
    // Firefox's thin fallback is asserted in the portable CSS contract above.
    const native = page.locator('.chat-model-list')
    await page.mouse.move(350, 890)
    const resting = await native.evaluate(el => ({
      mode: getComputedStyle(el).scrollbarWidth,
      color: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
      width: getComputedStyle(el, '::-webkit-scrollbar').width,
      track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor,
    }))
    expect(resting.mode).toBe('auto')
    expect(resting.width).toBe('4px')
    expect(resting.track).toBe('rgba(0, 0, 0, 0)')
    // Linux overlay scrollbars may reserve no layout width at all.
    expect(await native.evaluate(el => (el as HTMLElement).offsetWidth - el.clientWidth)).toBeLessThanOrEqual(4)
    await native.hover()
    expect(await native.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor)).not.toBe(resting.color)
    const thumb = page.locator('.custom-overlay .overlay-scrollbar-rail__thumb')
    expect(await thumb.evaluate(el => getComputedStyle(el).width)).toBe('4px')
    expect(await page.locator('.custom-overlay .overlay-scrollbar-rail').evaluate(el => [getComputedStyle(el).width, getComputedStyle(el).backgroundColor])).toEqual(['10px', 'rgba(0, 0, 0, 0)'])
    await page.mouse.move(350, 890)
    await page.locator('.custom-overlay button').focus()
    expect(await thumb.evaluate(el => [getComputedStyle(el).opacity, getComputedStyle(el).pointerEvents])).toEqual(['0', 'none'])
    await thumb.evaluate(el => { (el as HTMLElement).style.height = '20%' })
    await expect.poll(() => thumb.evaluate(el => [getComputedStyle(el).opacity, getComputedStyle(el).pointerEvents])).toEqual(['1', 'auto'])
    expect(await page.locator('.plain-source .overlay-scroll-pane').evaluate(el => getComputedStyle(el).scrollbarWidth)).toBe('none')
    // Native keyboard scrolling still works; no blanket scrollbar hiding.
    await page.locator('.chat-message-scroll').focus()
    await page.keyboard.press('End')
    await expect.poll(() => page.locator('.chat-message-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  } finally {
    await browser.close()
  }
}, 60_000)
