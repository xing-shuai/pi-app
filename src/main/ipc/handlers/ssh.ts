import { app } from 'electron'
import { z } from 'zod'
import { SSH_EVENT_CHANNEL, sshCommandSchema, sshConnectSchema, sshProfileSchema } from '@shared/ssh-workspace'
import { configStore } from '../../config-store'
import { getMainWindow } from '../../window'
import { setRemoteActivityProbe } from '../../window-close-guard'
import { SshWorkspace } from '../../ssh/ssh-workspace'
import { detectSshAuthCapabilities } from '../../ssh/auth'
import { registerHandler, registerHandlerWithSchema } from '../registry'

const sshWorkspace = new SshWorkspace((event) => {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(SSH_EVENT_CHANNEL, event)
}, (id, sessionFile) => {
  configStore.set('sshSessions', { ...configStore.get('sshSessions'), [id]: sessionFile })
})

/** Called by the central approved-quit path, which exits without Electron's will-quit event. */
export function shutdownSshWorkspace(): void { sshWorkspace.disconnect() }

export function registerSshHandlers(): void {
  setRemoteActivityProbe(() => sshWorkspace.hasActiveWork)
  app.once('will-quit', () => sshWorkspace.disconnect())
  registerHandler('ipc:ssh.profiles', async () => {
    const authCapabilities = await detectSshAuthCapabilities()
    return { profiles: configStore.get('sshProfiles'), status: sshWorkspace.getStatus(), authCapabilities }
  })
  registerHandlerWithSchema('ipc:ssh.saveProfile', sshProfileSchema, async (raw) => {
    const profile = sshProfileSchema.parse(raw)
    if (sshWorkspace.getStatus().profileId === profile.id && sshWorkspace.getStatus().phase !== 'disconnected') throw new Error('Disconnect before editing this profile')
    const profiles = configStore.get('sshProfiles')
    const old = profiles.find((p) => p.id === profile.id)
    if (!old && profiles.length >= 50) throw new Error('Maximum 50 SSH profiles')
    // Changing target must never pass a session path from a different server/workspace.
    const targetChanged = old && ['host', 'port', 'user', 'identityFile', 'cwd', 'piPath', 'nodePath'].some((key) => old[key as keyof typeof old] !== profile[key as keyof typeof profile])
    if (targetChanged) {
      const sessions = { ...configStore.get('sshSessions') }
      delete sessions[profile.id]
      configStore.set('sshSessions', sessions)
    }
    configStore.set('sshProfiles', [...profiles.filter((p) => p.id !== profile.id), profile])
    return { profile }
  })
  registerHandlerWithSchema('ipc:ssh.deleteProfile', z.object({ id: z.string().uuid() }), async ({ id }) => {
    if (sshWorkspace.getStatus().profileId === id && sshWorkspace.getStatus().phase !== 'disconnected') throw new Error('Disconnect before deleting this profile')
    configStore.set('sshProfiles', configStore.get('sshProfiles').filter((p) => p.id !== id))
    const sessions = { ...configStore.get('sshSessions') }
    delete sessions[id]
    configStore.set('sshSessions', sessions)
    return { ok: true }
  })
  registerHandlerWithSchema('ipc:ssh.connect', sshConnectSchema, async ({ id, resume, password }) => {
    const profile = configStore.get('sshProfiles').find((p) => p.id === id)
    if (!profile) throw new Error('SSH profile not found')
    return sshWorkspace.connect(profile, resume ? configStore.get('sshSessions')[id] : undefined, { password })
  })
  registerHandler('ipc:ssh.disconnect', async () => { sshWorkspace.disconnect(); return { ok: true } })
  registerHandlerWithSchema('ipc:ssh.command', sshCommandSchema, async (command) => sshWorkspace.command(command))
  registerHandlerWithSchema('ipc:ssh.files', z.object({ action: z.enum(['list', 'read']), path: z.string().max(4096).refine((p) => !p.includes('\0')) }), async ({ action, path }) => sshWorkspace.files(action, path))
}
