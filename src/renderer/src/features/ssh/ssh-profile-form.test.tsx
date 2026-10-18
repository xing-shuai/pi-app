import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshProfileForm } from './ssh-profile-form'
import type { SshProfile } from '@shared/ssh-workspace'

const initial = { id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Test server', host: 'server.test', user: 'dev', cwd: '/code', piPath: 'pi', nodePath: 'node' }
afterEach(cleanup)
describe('SSH authentication profile', () => {
  it('stores the method but never asks for a password in the saved profile form', async () => {
    const save = vi.fn<(profile: SshProfile) => Promise<void>>(async () => {})
    render(<SshProfileForm initial={initial} zh={false} passwordSupported onSave={save} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'password' } })
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0]).toMatchObject({ authMethod: 'password' })
    expect(save.mock.calls[0][0]).not.toHaveProperty('password')
  })
  it('makes a missing helper explicit instead of accepting an unusable password option', () => {
    render(<SshProfileForm initial={initial} zh={false} passwordSupported={false} passwordUnavailableReason="Install sshpass" onSave={vi.fn(async () => {})} onCancel={vi.fn()} />)
    expect(screen.getByRole('option', { name: /Password/ })).toBeDisabled()
    expect(screen.getByText('Install sshpass')).toBeInTheDocument()
  })
})
