import { z } from 'zod'

const singleLine = z.string().trim().max(1024).refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'Control characters are not allowed')
export const sshProfileSchema = z.object({
  id: z.string().uuid(),
  name: singleLine.pipe(z.string().min(1).max(80)),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:\-]*$/, 'Use a hostname, IP address or SSH config alias'),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/).optional(),
  identityFile: singleLine.optional(),
  authMethod: z.enum(['agent', 'password']).optional(),
  cwd: singleLine.refine((s) => s.startsWith('/'), 'Remote workspace must be an absolute POSIX path'),
  worktreeFolder: singleLine.refine((s) => s.startsWith('/') || s.startsWith('~/'), 'Remote worktree folder must be absolute or start with ~/').optional(),
  piPath: singleLine.pipe(z.string().min(1)).default('pi'),
  nodePath: singleLine.pipe(z.string().min(1)).default('node'),
}).strict('Unknown SSH profile fields are not allowed; credentials must not be saved')
export type SshProfile = z.infer<typeof sshProfileSchema>

// Static messages only: IPC validation errors are logged by the main-process registry.
export const sshPasswordSchema = z.string({ invalid_type_error: 'SSH password must be a string' })
  .min(1, 'SSH password is required')
  .max(4096, 'SSH password must not exceed 4096 characters')
  .refine((password) => !/[\0\r\n]/.test(password), 'SSH password must not contain NUL, CR or LF')
export const sshConnectSchema = z.object({
  id: z.string().uuid(),
  resume: z.boolean().default(true),
  password: sshPasswordSchema.optional(),
}).strict('Unknown SSH connect fields are not allowed')
export type SshAuthCapabilities = { password: boolean; passwordUnavailableReason?: string }
export type SshCredentials = { password?: string }
export type SshRecord = Record<string, unknown> & { type: string }
export type SshStatus = {
  phase: 'disconnected' | 'connecting' | 'connected'
  profileId?: string
  error?: string
  outcomeUnknown?: boolean
  sessionFile?: string
  model?: string
}
export type SshWorkspaceEvent =
  | { kind: 'status'; status: SshStatus }
  | { kind: 'record'; record: SshRecord }
  | { kind: 'diagnostic'; text: string }
export type SshFileEntry = { name: string; path: string; directory: boolean }
export type SshFilesResult = { entries?: SshFileEntry[]; text?: string; path: string }
export { SSH_EVENT_CHANNEL } from './ssh-event-channel'

export const sshCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), message: z.string().min(1).max(200000) }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('abort_bash') }),
  z.object({ type: z.literal('new_session') }),
  z.object({ type: z.literal('get_state') }),
  z.object({ type: z.literal('get_messages') }),
  z.object({ type: z.literal('get_available_models') }),
  z.object({ type: z.literal('set_model'), provider: z.string().min(1).max(200), modelId: z.string().min(1).max(300) }),
  z.object({ type: z.literal('bash'), command: z.string().min(1).max(100000), excludeFromContext: z.literal(true) }),
  z.object({ type: z.literal('extension_ui_response'), id: z.string().max(200), value: z.string().max(100000).optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().optional() }),
])
export type SshCommand = z.infer<typeof sshCommandSchema>
