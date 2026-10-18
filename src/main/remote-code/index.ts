import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configStore } from '../config-store'
import { getMainWindow } from '../window'
import { asrConfigForSettingsResponse, loadAsrConfig } from '../asr-config-store'
import { resolveUtilityEntry } from '../utility-entry-path'
import { SshWorkspace } from '../ssh/ssh-workspace'
import { RemoteCodeService, reservedRemotePaths } from './service'
import { hostBootstrap } from './bootstrap'

let service: RemoteCodeService | undefined
export function getRemoteCodeService(): RemoteCodeService {
  return service ||= new RemoteCodeService({
    metadataDirectory: join(app.getPath('userData'), 'remote-code'),
    transport: (emit) => new SshWorkspace(emit, () => {}),
    bootstrap: async (profile) => hostBootstrap(profile, await readFile(resolveUtilityEntry('ssh-host.mjs'), 'utf8')),
    profiles: () => configStore.get('sshProfiles'),
    saveRightPanelLayout: (prefs, order) => configStore.setRightPanelLayout(prefs, order),
    localSettings: () => ({ ...configStore.getAll(), asrConfig: asrConfigForSettingsResponse(loadAsrConfig()), recentProjects: configStore.get('recentProjects'), currentProject: configStore.get('currentProject') || null }),
    emit: (channel, payload) => { const win = getMainWindow(); if (win && !win.isDestroyed()) win.webContents.send(channel, payload) },
  })
}
export function routeRemoteCodeInvoke(channel: string, request: unknown): Promise<{ handled: false } | { handled: true; value: unknown }> {
  // Local startup stays independent of remote metadata (including corrupt remote metadata).
  // Environment handlers allocate the service when the user first chooses SSH.
  if (!service) {
    const req = request && typeof request === 'object' ? request as Record<string, unknown> : {}
    const virtual = reservedRemotePaths(req).length > 0
    const reservedId = typeof req.id === 'string' && /^(ssh-term-|ssh-ui-)/.test(req.id)
    if (!virtual && !reservedId) return Promise.resolve({ handled: false })
  }
  return getRemoteCodeService().route(channel, request)
}
export function hasActiveRemoteCodeWork(): boolean { return service?.hasActiveWork ?? false }
export function hasRemoteTerminal(id: string): boolean { return id.startsWith('ssh-term-') || (service?.hasTerminal(id) ?? false) }
export function writeRemoteTerminal(id: string, data: string): boolean { return service ? service.writeTerminal(id, data) : id.startsWith('ssh-term-') }
export function remoteTerminalCount(): number { return service?.terminalCount ?? 0 }
export const remoteCodeRuntime = { shutdown: async (): Promise<void> => { await service?.shutdown() } }
