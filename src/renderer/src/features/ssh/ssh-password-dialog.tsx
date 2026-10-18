import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { KeyRound, ShieldCheck, X } from '@renderer/components/icons'
import type { SshProfile } from '@shared/ssh-workspace'
import './ssh-password.css'

/** Mounted only while asking: no localStorage, profile field, log or password reuse. */
export function SshPasswordDialog({ profile, zh, onSubmit, onCancel }: {
  profile: SshProfile
  zh: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    input.current?.focus()
    const escape = (event: KeyboardEvent) => { if (document.querySelector('[data-close-decision-dialog]')) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPassword(''); onCancel() } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onCancel])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!password || /[\0\r\n]/.test(password)) return
    const value = password
    setPassword('')
    onSubmit(value)
  }
  return <div className="ssh-password-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setPassword(''); onCancel() } }}>
    <form className="ssh-password-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onSubmit={submit}>
      <header><KeyRound size={19} /><h2 id={titleId}>{zh ? 'SSH 密码登录' : 'SSH password sign-in'}</h2><button type="button" aria-label={zh ? '关闭密码输入' : 'Close password prompt'} onClick={() => { setPassword(''); onCancel() }}><X size={17} /></button></header>
      <p>{profile.name}</p><code>{profile.user ? `${profile.user}@` : ''}{profile.host}{profile.port ? `:${profile.port}` : ''}</code>
      <label>{zh ? '密码' : 'Password'}<input ref={input} required type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <p className="ssh-password-privacy" id={descriptionId}><ShieldCheck size={15} />{zh ? '仅用于这次 SSH 登录，不保存到连接配置、日志或命令行。主机指纹校验仍然开启。' : 'Used only for this SSH sign-in. Never saved to the connection profile, logs or command line. Host-key verification remains enabled.'}</p>
      <div className="ssh-actions"><button type="button" onClick={() => { setPassword(''); onCancel() }}>{zh ? '取消' : 'Cancel'}</button><button className="ssh-primary" disabled={!password || /[\0\r\n]/.test(password)}>{zh ? '连接' : 'Connect'}</button></div>
    </form>
  </div>
}
