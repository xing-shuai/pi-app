import { useState, type FormEvent } from 'react'
import { sshProfileSchema, type SshProfile } from '@shared/ssh-workspace'

export function SshProfileForm({ initial, zh, passwordSupported = false, passwordUnavailableReason, onSave, onCancel }: {
  initial?: SshProfile
  zh: boolean
  passwordSupported?: boolean
  passwordUnavailableReason?: string
  onSave: (profile: SshProfile) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<SshProfile>(initial || { id: crypto.randomUUID(), name: '', host: '', cwd: '', piPath: 'pi', nodePath: 'node' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const fields = [
    ['name', zh ? '连接名称' : 'Connection name', 'Development server'],
    ['host', zh ? '主机或 SSH config 别名' : 'Host or SSH config alias', 'dev-server'],
    ['user', zh ? '用户名（可留空使用 SSH 配置）' : 'User (optional; uses SSH config)', ''],
    ['port', zh ? '端口（可留空使用 SSH 配置）' : 'Port (optional; uses SSH config)', '22'],
    ['cwd', zh ? '远程工作区绝对路径' : 'Absolute remote workspace path', '/home/dev/project'],
    ['identityFile', zh ? '本地私钥路径（可留空使用 Agent）' : 'Local identity file (optional; uses agent)', '~/.ssh/id_ed25519'],
    ['piPath', zh ? '远程 Pi 可执行文件' : 'Remote Pi executable', 'pi'],
    ['nodePath', zh ? '远程 Node 可执行文件（运行时 / 预览）' : 'Remote Node executable (runtime / preview)', 'node'],
  ] as const
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const result = sshProfileSchema.safeParse(draft)
    if (!result.success) { setError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')); return }
    setSaving(true)
    try { await onSave(result.data) } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }
  return <form className="ssh-profile-form" onSubmit={(e) => void submit(e)}>
    <h2>{initial ? (zh ? '编辑连接' : 'Edit connection') : (zh ? '添加 SSH 工作区' : 'Add SSH workspace')}</h2>
    <label className="ssh-auth-method">{zh ? '认证方式' : 'Authentication'}<select aria-label={zh ? '认证方式' : 'Authentication'} value={draft.authMethod || 'agent'} onChange={(e) => setDraft({ ...draft, authMethod: e.target.value as 'agent' | 'password' })}>
      <option value="agent">{zh ? '密钥 / SSH Agent' : 'Key / SSH Agent'}</option><option value="password" disabled={!passwordSupported}>{zh ? '密码（每次连接询问，不保存）' : 'Password (ask on connect, never saved)'}</option>
    </select></label>
    {!passwordSupported && <p className="ssh-hint">{passwordUnavailableReason || (zh ? '当前系统尚未检测到密码认证支持。Linux/macOS 需要 sshpass。' : 'Password support not detected. Linux/macOS requires sshpass.')}</p>}
    <div className="ssh-form-grid">{fields.filter(([key]) => key !== 'identityFile' || draft.authMethod !== 'password').map(([key, label, placeholder]) => <label key={key}>
      {label}<input required={['name', 'host', 'cwd', 'piPath', 'nodePath'].includes(key)} type={key === 'port' ? 'number' : 'text'} min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined}
        placeholder={placeholder} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: key === 'port' ? (e.target.value ? Number(e.target.value) : undefined) : (e.target.value || (key === 'user' || key === 'identityFile' ? undefined : '')) })} />
    </label>)}</div>
    <p className="ssh-hint">{zh ? '仅保存连接信息、认证方式和私钥路径，不保存密码或私钥内容。密码在连接时单独输入。默认 pi 会检查常见用户安装目录；不在 PATH 时可填写远端 Pi/Node 的绝对路径。支持 ~/.ssh/config、ProxyJump 和 SSH Agent。远端需预先安装 Pi 并配置模型登录。' : 'Only connection details, authentication method and identity path are saved. Passwords and private key contents are never saved. Passwords are requested separately on connect. Default pi checks common user install folders; use absolute remote Pi/Node paths when needed. Supports ~/.ssh/config, ProxyJump and SSH Agent. Install Pi and sign in to a model provider on the remote first.'}</p>
    {error && <pre role="alert" className="ssh-error">{error}</pre>}
    <div className="ssh-actions"><button type="button" onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button><button className="ssh-primary" disabled={saving || (draft.authMethod === 'password' && !passwordSupported)}>{zh ? '保存连接' : 'Save connection'}</button></div>
  </form>
}
