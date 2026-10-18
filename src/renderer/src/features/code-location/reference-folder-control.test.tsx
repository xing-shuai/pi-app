import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReferenceFolderControl } from './reference-folder-control'

const f = vi.hoisted(() => ({
  ui: { currentWorkspace: null as string | null, recentProjects: [] as string[], ephemeralSandboxDraft: false },
  location: {
    selectedProfile: undefined as { id: string } | undefined,
    snapshot: { targetId: 'local', workspaces: [] as { profileId: string; workspaceId: string; nativePath: string; name: string; hostLabel: string }[] },
    noProject: false, chooseNoProject: vi.fn(), chooseFolder: vi.fn(), chooseWorkspace: vi.fn(),
  },
}))
vi.mock('@renderer/stores/ui-store', () => ({ useUIStore: (selector: (state: typeof f.ui) => unknown) => selector(f.ui) }))
vi.mock('./code-location-context', () => ({ useCodeLocation: () => f.location }))
beforeEach(() => {
  vi.clearAllMocks()
  f.ui.currentWorkspace = null; f.ui.recentProjects = []; f.ui.ephemeralSandboxDraft = false
  f.location.selectedProfile = undefined; f.location.snapshot = { targetId: 'local', workspaces: [] }; f.location.noProject = false
})
afterEach(cleanup)

describe('Optional project folder control', () => {
  it('always opens a compact menu with No project and Browse even without recents', () => {
    render(<ReferenceFolderControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Select project folder' }))
    expect(screen.getByRole('menuitem', { name: 'Browse local folder…' })).toBeInTheDocument()
    expect(screen.queryByText('Recent')).not.toBeInTheDocument()
    expect(f.location.chooseFolder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'No project' }))
    expect(f.location.chooseNoProject).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('labels a Local scratch draft No project while retaining project history and Browse', () => {
    f.ui.ephemeralSandboxDraft = true; f.ui.recentProjects = ['/saved/project']
    render(<ReferenceFolderControl />)
    expect(screen.getByRole('button', { name: 'Select project folder' })).toHaveTextContent('No project')
    fireEvent.click(screen.getByRole('button', { name: 'Select project folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'project' }))
    expect(f.location.chooseWorkspace).toHaveBeenCalledExactlyOnceWith('/saved/project')
    fireEvent.click(screen.getByRole('button', { name: 'Select project folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browse local folder…' }))
    expect(f.location.chooseFolder).toHaveBeenCalledOnce()
  })
  it('offers explicitly remote HOME even when disconnected/no recents, never a Local choice', () => {
    f.location.selectedProfile = { id: 'exact-host' }; f.location.snapshot.targetId = 'ssh:exact-host'
    render(<ReferenceFolderControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Select project folder' }))
    expect(screen.getByRole('menuitem', { name: 'Browse remote folder…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'No project' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'No project · Remote home' }))
    expect(f.location.chooseNoProject).toHaveBeenCalledOnce(); expect(f.location.chooseFolder).not.toHaveBeenCalled()
  })
  it('shows No project rather than the home basename, without disguising a different host root', () => {
    const path = '/__pi_ssh__/exact-host/root-fingerprint/home'
    f.location.selectedProfile = { id: 'exact-host' }; f.location.snapshot.targetId = 'ssh:exact-host'
    f.location.snapshot.workspaces = [
      { profileId: 'exact-host', workspaceId: path, nativePath: '/home/me', name: 'me', hostLabel: 'host' },
      { profileId: 'other-host', workspaceId: '/__pi_ssh__/other-host/other/home', nativePath: '/home/me', name: 'other home', hostLabel: 'other' },
    ]
    f.ui.currentWorkspace = path; f.location.noProject = true
    render(<ReferenceFolderControl />)
    expect(screen.getByRole('button', { name: 'Select project folder' })).toHaveTextContent('No project')
    fireEvent.click(screen.getByRole('button', { name: 'Select project folder' }))
    expect(screen.queryByRole('menuitem', { name: 'me' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'other home' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'No project · Remote home' })).toBeInTheDocument()
  })
})
