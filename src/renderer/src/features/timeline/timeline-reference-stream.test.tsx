import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import type { ToolTimelineItem } from '@renderer/stores/ui-store-types'
import { buildTimelineDisplayItems, type TimelineRawItem } from './timeline-display-items'
import { ToolGroupSummary } from './tool-group-summary'
import { ToolCallRow } from './tool-call-row'
import MarkdownView from './markdown-view'

const tool = (id: string, extra: Partial<ToolTimelineItem> = {}): TimelineRawItem => ({
  id, type: 'tool-call', toolCallId: id, toolName: 'read', toolPhase: 'end',
  toolArgs: { path: `${id}.txt` }, toolOutput: `Output for ${id}`, ...extra,
})
const prose = (id: string, text: string): TimelineRawItem => ({ id, type: 'assistant-message', text })

function Stream({ items }: { items: TimelineRawItem[] }) {
  return <div className="reference-code">{buildTimelineDisplayItems(items).map((block) =>
    block.kind === 'tool-group'
      ? <ToolGroupSummary key={block.groupId} groupId={block.groupId} tools={block.tools as unknown as ToolTimelineItem[]} clusterChildren={block.children} />
      : <MarkdownView key={block.item.id}>{String(block.item.text || '')}</MarkdownView>,
  )}</div>
}

beforeEach(() => {
  useUIStore.setState({ historySessionFile: '/workspace/stream.jsonl', toolExpandBySession: {},
    fileChanges: [], runState: { status: 'idle', toolCount: 0, errorCount: 0 } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('reference information stream', () => {
  it('keeps real prose/tool/prose slices in order and expands only the selected details', () => {
    const { container } = render(<Stream items={[
      prose('p1', 'Before the reads'), tool('a'), tool('b'),
      prose('p2', 'Between the reads'), tool('c'), prose('p3', 'After the reads'),
    ]} />)
    const summary = screen.getByRole('button', { name: 'explored 2 files' })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Output for a')).toBeNull()
    expect(container.textContent).toMatch(/Before the reads.*explored 2 files.*Between the reads.*Read c.txt.*After the reads/s)
    fireEvent.click(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Read a.txt' }))
    expect(screen.getByText('Output for a')).toBeVisible()
    expect(screen.queryByText('Output for b')).toBeNull()
    fireEvent.click(summary)
    expect(screen.queryByText('Output for a')).toBeNull()
    expect(screen.getByText('Between the reads')).toBeVisible()
    expect(screen.getByText('After the reads')).toBeVisible()
    const single = screen.getByRole('button', { name: 'Read c.txt' })
    fireEvent.click(single)
    expect(single).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Output for c')).toBeVisible()
    expect(container.querySelector('a[href^="file:"], img[src^="file:"]')).toBeNull()
  })

  it('does not count unrelated session file events or omit mixed custom tools', () => {
    useUIStore.setState({ fileChanges: [{ path: '/elsewhere/unrelated.ts', changeType: 'modified' }] as never })
    render(<Stream items={[
      tool('a'), tool('b', { toolName: 'bash', toolArgs: { command: 'pwd' } }),
      tool('c', { toolName: 'custom_check' }), prose('p', 'Complete'),
    ]} />)
    expect(screen.getByRole('button', { name: /explored 1 files, ran 1 commands, 1 tools.*custom_check/ })).toBeVisible()
    expect(screen.queryByText(/unrelated.ts/)).toBeNull()
  })

  it('keeps failures and extension actions visible when their group is collapsed', () => {
    const resume = vi.spyOn(useExtensionUIStore.getState(), 'resumeSuspended').mockImplementation(() => {})
    const { container } = render(<Stream items={[
      tool('bad', { isError: true, toolStatusLine: 'Read denied' }),
      tool('question', { extensionUiSuspended: true }), tool('ok'), prose('p', 'Next step'),
    ]} />)
    expect(screen.getByRole('button', { name: /explored 3 files.*1 failed/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Read denied.*1 failed/ })).toBeVisible()
    expect(screen.getByText('Output for bad')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(resume).toHaveBeenCalledOnce()
    expect(container.querySelector('button button')).toBeNull()
  })

  it('leaves running activity unsealed and its real status visible', () => {
    const running = tool('live', { toolName: 'bash', toolPhase: 'update', toolStatusLine: 'Waiting for approval' })
    expect(buildTimelineDisplayItems([running, prose('p', 'Still waiting')])[0].kind).toBe('single')
    render(<ToolCallRow item={running as unknown as ToolTimelineItem} />)
    expect(screen.getByRole('button', { name: 'Waiting for approval' })).toHaveClass('tool-call-row-hit--live')
  })

  it('scopes sans body, monospace code and wide prose to Code without new preview URLs', () => {
    const css = readFileSync('src/renderer/src/styles/timeline-reference-stream.css', 'utf8')
    expect(css).toContain('.reference-code .timeline-scroll-viewport .prose-chat')
    expect(css).toContain('font-family: var(--font-sans)')
    expect(css).toContain('font-family: var(--font-mono)')
    expect(css).toContain('font-size: 16px')
    expect(css).toContain('font-size: 14px')
    expect(css).toContain('max-width: 960px')
    expect(css).toContain('.reference-code .timeline-files-changed-card')
    expect(css).toContain('border: 1px solid var(--border-base, #373736)')
    expect(css).not.toMatch(/url\(|file:\/\/|https?:\/\//)
  })
})
