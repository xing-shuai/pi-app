import { z } from 'zod'
import { sshPasswordSchema, sshProfileSchema } from '@shared/ssh-workspace'
import { getRemoteCodeService } from '../../remote-code'
import { registerHandler } from '../registry'

const id = z.string().uuid()
const path = z.string().min(1).max(4096).refine((p) => !/[\0\r\n]/.test(p))
const schemas = {
  'ipc:code.environment.get': z.object({}).strict(),
  'ipc:code.environment.local': z.object({}).strict(),
  'ipc:code.ssh.connect': z.object({ profileId: id.optional(), profile: sshProfileSchema.optional(), password: sshPasswordSchema.optional(), activate: z.boolean().default(true) }).strict(),
  'ipc:code.ssh.select': z.object({ profileId: id }).strict(),
  'ipc:code.ssh.browse': z.object({ profileId: id, path: path.optional() }).strict(),
  'ipc:code.ssh.prepareWorkspace': z.object({ profileId: id, path }).strict(),
  'ipc:code.ssh.openWorkspace': z.object({ profileId: id, path, trustToken: id.optional() }).strict(),
  'ipc:code.ssh.disconnect': z.object({ profileId: id, force: z.boolean().optional() }).strict(),
}
/** Exactly the root/environment APIs; ordinary Code calls use registry middleware. */
function environmentHandler(channel: keyof typeof schemas) {
  return async (raw: unknown) => {
    const parsed = schemas[channel].safeParse(raw ?? {})
    // Do not log Zod inputs or credential-bearing request objects.
    if (!parsed.success) throw new Error('Invalid remote Code environment request')
    const req = parsed.data as { profileId?: string; path?: string; trustToken?: string; force?: boolean }
    const service = getRemoteCodeService()
    switch (channel) {
      case 'ipc:code.environment.get': return service.snapshot
      case 'ipc:code.environment.local': return service.local()
      case 'ipc:code.ssh.connect': return service.connect(parsed.data)
      case 'ipc:code.ssh.select': return service.select(req.profileId!)
      case 'ipc:code.ssh.browse': return service.browse(req.profileId!, req.path)
      case 'ipc:code.ssh.prepareWorkspace': return service.prepareWorkspace(req.profileId!, req.path!)
      case 'ipc:code.ssh.openWorkspace': return service.openWorkspace(req.profileId!, req.path!, req.trustToken)
      case 'ipc:code.ssh.disconnect': return service.disconnect(req.profileId!, req.force)
      default: throw new Error('Unknown remote Code environment method')
    }
  }
}
export function registerRemoteCodeHandlers(): void {
  registerHandler('ipc:code.environment.get', environmentHandler('ipc:code.environment.get'))
  registerHandler('ipc:code.environment.local', environmentHandler('ipc:code.environment.local'))
  registerHandler('ipc:code.ssh.connect', environmentHandler('ipc:code.ssh.connect'))
  registerHandler('ipc:code.ssh.select', environmentHandler('ipc:code.ssh.select'))
  registerHandler('ipc:code.ssh.browse', environmentHandler('ipc:code.ssh.browse'))
  registerHandler('ipc:code.ssh.prepareWorkspace', environmentHandler('ipc:code.ssh.prepareWorkspace'))
  registerHandler('ipc:code.ssh.openWorkspace', environmentHandler('ipc:code.ssh.openWorkspace'))
  registerHandler('ipc:code.ssh.disconnect', environmentHandler('ipc:code.ssh.disconnect'))
}
