import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ warm: vi.fn(async () => {}), probe: vi.fn() }))
vi.mock('./config-store', () => ({ configStore: { get: () => '/project' } }))
vi.mock('./wsl/runtime-config', () => ({ getAgentRuntimeConfig: () => ({ mode: 'host' }) }))
vi.mock('./session-preview-process', () => ({ sessionPreviewProcess: { warm: mocks.warm } }))
vi.mock('./extension-probe-cache', () => ({ prewarmExtensionProbe: mocks.probe }))
beforeEach(() => { vi.resetModules(); mocks.warm.mockClear(); mocks.probe.mockClear() })
describe('Chat startup isolation', () => {
  it('does not warm coding SDKs or load user extension probes merely because the shell painted', async () => {
    const startup = await import('./startup-warmup')
    startup.runStartupWarmup()
    await Promise.resolve()
    expect(mocks.warm).not.toHaveBeenCalled()
    expect(mocks.probe).not.toHaveBeenCalled()
  })
  it('enables code-only warmup only after the Code workspace is visited', async () => {
    const startup = await import('./startup-warmup')
    startup.enableCodeWarmup()
    await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledOnce())
    expect(mocks.warm).toHaveBeenCalledOnce()
    startup.runStartupWarmup()
    expect(mocks.probe).toHaveBeenCalledOnce()
  })
})
