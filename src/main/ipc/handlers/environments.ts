import type { EnvironmentList, ExecutionCapability } from '@shared/execution-target'
import { configStore } from '../../config-store'
import { registerHandler } from '../registry'

const codeCapabilities: ExecutionCapability[] = ['sessions', 'files', 'git', 'pty', 'browser']
export function registerEnvironmentHandlers(): void {
  registerHandler('ipc:environment.list', async (): Promise<EnvironmentList> => {
    const runtime = configStore.get('agentRuntime')
    const isWsl = runtime.mode === 'wsl' && !!runtime.distro
    return {
      activeCodeTargetId: isWsl ? `wsl:${runtime.distro}` : 'local',
      targets: [
        { id: 'local', kind: 'local', name: 'Local', available: true, reason: isWsl ? 'Local Routines remain available. Interactive Code currently uses WSL; change it in Settings → Runtime.' : undefined, capabilities: isWsl ? ['routines'] : [...codeCapabilities, 'routines'], lifetime: 'desktop' },
        ...(isWsl ? [{ id: `wsl:${runtime.distro}`, kind: 'wsl' as const, name: `WSL · ${runtime.distro}`, available: true, capabilities: codeCapabilities, lifetime: 'desktop' as const }] : []),
        ...configStore.get('sshProfiles').map((profile) => ({ id: `ssh:${profile.id}`, kind: 'ssh' as const, name: profile.name, available: true, experimental: true, capabilities: ['sessions', 'file-preview', 'command-console'] as ExecutionCapability[], lifetime: 'ssh-connection' as const })),
      ],
    }
  })
}
