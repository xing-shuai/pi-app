import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownLink } from '../markdown-link'
import { MarkdownWorkspaceOrigin } from '@renderer/lib/markdown-workspace-origin'
import { rememberRemoteWorkspacePaths } from '@renderer/lib/remote-code-paths'
import { openReviewGitForPath, openReviewSessionForPath } from '@renderer/lib/open-workspace-path'
import { useUIStore } from '@renderer/stores/ui-store'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })) }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke } }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
const a = '/__pi_ssh__/host-a/hash/project', b = '/__pi_ssh__/host-b/hash/project'
beforeEach(() => {
  invoke.mockClear()
  rememberRemoteWorkspacePaths([a, b].map((workspaceId, index) => ({ workspaceId, targetId: `ssh:host-${index}` as const, profileId: `host-${index}`, nativePath: '/srv/project', name: 'project', hostLabel: `host-${index}` })))
  useUIStore.setState({ currentWorkspace: a, workspaceFileToOpen: null, activePanel: 'files' })
})
afterEach(cleanup)
describe('Markdown file provenance across execution targets', () => {
  it.each([b, '/local/project'])('retains SSH A authority after rerender under %s', (next) => {
    const view = render(<MarkdownLink href="/srv/project/file.ts">Remote source</MarkdownLink>)
    act(() => useUIStore.setState({ currentWorkspace: next }))
    view.rerender(<MarkdownLink href="/srv/project/file.ts">Remote source</MarkdownLink>)
    fireEvent.click(screen.getByRole('link', { name: 'Remote source' }))
    expect(invoke).not.toHaveBeenCalled()
    expect(useUIStore.getState().workspaceFileToOpen).toBeNull()
  })
  it('recognizes a retained virtual baseDirectory even when remounted in Local', () => {
    useUIStore.setState({ currentWorkspace: '/local/project' })
    render(<MarkdownLink href="/srv/project/file.ts" baseDirectory={`${a}/docs`}>Remote source</MarkdownLink>)
    fireEvent.click(screen.getByRole('link'))
    expect(invoke).not.toHaveBeenCalled()
    expect(useUIStore.getState().workspaceFileToOpen).toBeNull()
  })
  it('passes immutable transcript origin to newly mounted descendants', () => {
    useUIStore.setState({ currentWorkspace: b })
    render(<MarkdownWorkspaceOrigin.Provider value={a}><MarkdownLink href="/srv/project/file.ts">Remote source</MarkdownLink></MarkdownWorkspaceOrigin.Provider>)
    fireEvent.click(screen.getByRole('link'))
    expect(invoke).not.toHaveBeenCalled()
    expect(useUIStore.getState().workspaceFileToOpen).toBeNull()
  })
  it('opens a current SSH file in Files rather than local system applications', () => {
    render(<MarkdownLink href="/srv/project/file.ts">Remote source</MarkdownLink>)
    fireEvent.click(screen.getByRole('link'))
    expect(useUIStore.getState().workspaceFileToOpen).toEqual({ workspaceRoot: a, rel: 'file.ts' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('does not reintroduce rejected remote paths as raw Review focus requests', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    for (const path of [`${b}/file.ts`, '/etc/passwd', '../private']) { openReviewGitForPath(path); openReviewSessionForPath(path) }
    expect(dispatch).not.toHaveBeenCalled()
    expect(useUIStore.getState().activePanel).toBe('files')
    dispatch.mockRestore()
  })
})
