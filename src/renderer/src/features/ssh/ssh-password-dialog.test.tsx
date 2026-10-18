import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshPasswordDialog } from './ssh-password-dialog'

const profile = { id: '175a1f7f-75bd-47f0-8188-788282755caf', name: 'Test server', host: 'server.test', user: 'dev', cwd: '/code', piPath: 'pi', nodePath: 'node' }
afterEach(cleanup)
describe('transient SSH password dialog', () => {
  it('masks input, preserves password spaces, and clears the field on submission', () => {
    const submit = vi.fn()
    render(<SshPasswordDialog profile={profile} zh={false} onSubmit={submit} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
    fireEvent.change(input, { target: { value: '  test-password  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(submit).toHaveBeenCalledWith('  test-password  ')
    expect(input).toHaveValue('')
  })
  it('clears the field on cancellation or Escape instead of retaining a reconnect secret', () => {
    const cancel = vi.fn()
    render(<SshPasswordDialog profile={profile} zh={false} onSubmit={vi.fn()} onCancel={cancel} />)
    const input = screen.getByLabelText('Password')
    fireEvent.change(input, { target: { value: 'temporary-test-value' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(input).toHaveValue('')
  })
})
