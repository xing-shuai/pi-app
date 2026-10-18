import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { detectSshAuthCapabilities } from './auth'

afterEach(() => vi.useRealTimers())
describe('SSH auth capabilities', () => {
  it.each(['linux', 'darwin'] as const)('detects sshpass asynchronously on %s without a shell or output capture', async (platform) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawnProcess = vi.fn(() => child)
    const pending = detectSshAuthCapabilities(platform, spawnProcess as unknown as typeof spawn)
    expect(spawnProcess).toHaveBeenCalledWith('sshpass', ['-V'], { stdio: 'ignore', windowsHide: true })
    child.emit('close', 0)
    expect(await pending).toEqual({ password: true })
  })
  it('reports Windows unavailable explicitly without spawning', async () => {
    const spawnProcess = vi.fn()
    expect(await detectSshAuthCapabilities('win32', spawnProcess)).toEqual({ password: false, passwordUnavailableReason: expect.stringContaining('Windows') })
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it('reports a missing helper without leaking the spawn error', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const result = detectSshAuthCapabilities('linux', vi.fn(() => child) as unknown as typeof spawn)
    child.emit('error', new Error('sensitive-spawn-diagnostic'))
    expect(await result).toEqual({ password: false, passwordUnavailableReason: expect.stringContaining('Install sshpass') })
  })
  it('bounds a stalled helper probe, kills it, and ignores a late successful exit', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const pending = detectSshAuthCapabilities('linux', vi.fn(() => child) as unknown as typeof spawn, 100)
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toMatchObject({ password: false })
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('close', 0)
    expect(await pending).toMatchObject({ password: false })
  })
  it('reports unsuccessful or synchronously unspawnable helpers unavailable', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const pending = detectSshAuthCapabilities('linux', vi.fn(() => child) as unknown as typeof spawn)
    child.emit('close', 1)
    expect(await pending).toMatchObject({ password: false })
    expect(await detectSshAuthCapabilities('linux', (() => { throw new Error('sensitive') }) as typeof spawn)).toMatchObject({ password: false })
  })
})
