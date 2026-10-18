import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onSshEvent } from '@renderer/lib/ipc-client'
import { ArrowUp, Folder, FileText, Plus, Pencil, Trash2, Network as Server, ShieldCheck, Square, Terminal, X, ChevronLeft } from '@renderer/components/icons'
import type { SshCommand, SshFilesResult, SshProfile, SshRecord, SshStatus } from '@shared/ssh-workspace'
import { SshProfileForm } from './ssh-profile-form'
import { SshPasswordDialog } from './ssh-password-dialog'
import { RemoteMarkdown } from './remote-markdown'
import { emptyRemoteChat, historyMessages, reduceRemoteChat } from './ssh-state'
import { needsRemotePathReview, sshErrorMessage } from './ssh-error'
import './ssh-workspace.css'

async function invoke<T>(channel: string, request?: unknown): Promise<T> {
  if (!window.piDesktop) throw new Error('SSH workspaces require the desktop app')
  return await window.piDesktop.invoke(`ipc:ssh.${channel}`, request) as T
}
type Model = { provider: string; id: string; name?: string }
type Dialog = { id: string; method: string; title?: string; message?: string; options?: string[]; prefill?: string; placeholder?: string }

/** Kept mounted when hidden so streaming, pending dialogs and draft input survive local/remote switching. */
export function SshWorkspacePage({ onBack, active = true, requestedProfileId }: { onBack: () => void; active?: boolean; requestedProfileId?: string }) {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const tr = (cn: string, en: string) => zh ? cn : en
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [status, setStatus] = useState<SshStatus>({ phase: 'disconnected' })
  const [selectedId, setSelectedId] = useState('')
  const [editing, setEditing] = useState<SshProfile | 'new' | null>(null)
  const [passwordProfile, setPasswordProfile] = useState<SshProfile | null>(null)
  const [authCapabilities, setAuthCapabilities] = useState<{ password: boolean; passwordUnavailableReason?: string }>({ password: false })
  const [chat, setChat] = useState(emptyRemoteChat)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [operationCount, setOperationCount] = useState(0)
  const working = operationCount > 0
  const [files, setFiles] = useState<SshFilesResult>({ path: '', entries: [] })
  const [preview, setPreview] = useState<SshFilesResult | null>(null)
  const [panel, setPanel] = useState<'files' | 'console'>('files')
  const [command, setCommand] = useState('')
  const [output, setOutput] = useState('')
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [dialogText, setDialogText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const connected = status.phase === 'connected'
  const locked = working || chat.busy || !!status.outcomeUnknown
  const profile = profiles.find((p) => p.id === selectedId)
  const activeProfile = profiles.find((p) => p.id === status.profileId)
  const dialog = dialogs[0]

  const run = async (fn: () => Promise<void>) => {
    setError('')
    setOperationCount((n) => n + 1)
    try { await fn() } catch (e) { setError(sshErrorMessage(e)) } finally { setOperationCount((n) => n - 1) }
  }
  const rpc = (cmd: SshCommand) => invoke<SshRecord>('command', cmd)
  const refreshRemote = async () => {
    const [history, available, state] = await Promise.all([rpc({ type: 'get_messages' }), rpc({ type: 'get_available_models' }), rpc({ type: 'get_state' })])
    setChat({ messages: historyMessages((history.data as { messages?: unknown[] })?.messages || []), busy: !!(state.data as { isStreaming?: boolean })?.isStreaming })
    setModels((available.data as { models?: Model[] })?.models || [])
  }
  useEffect(() => {
    const off = onSshEvent((event) => {
      if (event.kind === 'status') {
        setStatus(event.status)
        if (event.status.phase === 'disconnected') {
          setChat((s) => ({ ...s, busy: false, streamingId: undefined, messages: s.messages.map((m) => ({ ...m, pending: false })) }))
          setDialogs([])
        }
      }
      if (event.kind === 'diagnostic') setDiagnostics((s) => (s + event.text).slice(-8000))
      if (event.kind === 'record') {
        const r = event.record
        setChat((s) => reduceRemoteChat(s, r))
        if (r.type === 'bash_execution_update') setOutput((s) => (s + String(r.delta || '')).slice(-200000))
        if (r.type === 'extension_error') setError(String(r.error || 'Remote extension error'))
        if (r.type === 'extension_ui_request') {
          if (['select', 'confirm', 'input', 'editor'].includes(String(r.method))) setDialogs((ds) => [...ds, r as unknown as Dialog].slice(-20))
          if (r.method === 'notify') setDiagnostics((s) => `${s}\n${r.message}`.slice(-8000))
          if (r.method === 'set_editor_text') setDraft(String(r.text || ''))
        }
      }
    })
    void invoke<{ profiles: SshProfile[]; status: SshStatus; authCapabilities?: { password: boolean; passwordUnavailableReason?: string } }>('profiles').then(async (result) => {
      setProfiles(result.profiles)
      setAuthCapabilities(result.authCapabilities || { password: false })
      setStatus(result.status)
      setSelectedId(result.status.profileId || (result.profiles.some((p) => p.id === requestedProfileId) ? requestedProfileId : undefined) || result.profiles[0]?.id || '')
      if (result.status.phase === 'connected') await refreshRemote()
    }).catch((e) => setError(String(e)))
    return off
    // Only subscribe once: remote state persists while the page is hidden.
  }, [])
  useEffect(() => { if (!active) setPasswordProfile(null) }, [active])
  useEffect(() => {
    if (!requestedProfileId || !profiles.some((p) => p.id === requestedProfileId)) return
    if (status.phase === 'disconnected') setSelectedId(requestedProfileId)
    else if (status.profileId !== requestedProfileId) setError(tr('请先断开当前 SSH 连接，再切换主机。', 'Disconnect the current SSH workspace before changing hosts.'))
  }, [requestedProfileId, profiles, status.phase, status.profileId])
  useEffect(() => { setDialogText(dialog?.prefill || '') }, [dialog?.id, dialog?.prefill])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [chat.messages])

  const browse = (path = '') => run(async () => { setFiles(await invoke<SshFilesResult>('files', { action: 'list', path })); setPreview(null) })
  const connect = (target: SshProfile, password?: string) => run(async () => {
    setChat(emptyRemoteChat); setDialogs([]); setDiagnostics(''); setOutput(''); setPreview(null); setFiles({ path: '', entries: [] })
    await invoke('connect', { id: target.id, ...(password !== undefined ? { password } : {}) })
    await refreshRemote()
  })
  const beginConnect = () => {
    if (!profile || working || status.phase !== 'disconnected') return
    if (profile.authMethod === 'password') {
      if (!authCapabilities.password) { setError(authCapabilities.passwordUnavailableReason || tr('密码认证不可用，请先安装 sshpass。', 'Password authentication is unavailable; install sshpass first.')); return }
      setPasswordProfile(profile)
    } else void connect(profile)
  }
  const send = () => {
    if (!draft.trim() || locked || !connected) return
    const message = draft
    setDraft('')
    void run(async () => {
      try {
        const result = await rpc({ type: 'prompt', message })
        if ((result.data as { disposition?: string })?.disposition === 'handled') setChat((s) => ({ ...s, busy: false }))
      } catch (e) { setDraft(message); throw e }
    })
  }
  const respond = (answer: { cancelled?: boolean; confirmed?: boolean; value?: string }) => run(async () => {
    if (!dialog) return
    await rpc({ type: 'extension_ui_response', id: dialog.id, ...answer })
    setDialogs((ds) => ds.filter((d) => d.id !== dialog.id))
  })

  return <div className="ssh-workspace">
    <aside className="ssh-connections">
      <button className="ssh-back" onClick={onBack}><ChevronLeft size={16} />{tr('返回本地工作区', 'Local workspace')}</button>
      <div className="ssh-brand"><Server size={23} /><div>pi <span>Remote</span><small>{tr('你的代码，在任何地方', 'Your code. Anywhere.')}</small></div></div>
      <div className="ssh-section-title">{tr('SSH 工作区', 'SSH WORKSPACES')}<button disabled={working} title={tr('添加连接', 'Add connection')} onClick={() => setEditing('new')}><Plus size={16} /></button></div>
      <nav aria-label="SSH workspaces">{profiles.map((p) => <button key={p.id} className={`ssh-connection ${selectedId === p.id ? 'selected' : ''}`} onClick={() => { if (status.phase === 'disconnected' || status.profileId === p.id) { setSelectedId(p.id); setEditing(null) } }} disabled={working || (status.phase !== 'disconnected' && status.profileId !== p.id)}>
        <Server size={16} /><span>{p.name}<small>{p.host}</small></span>{status.profileId === p.id && status.phase !== 'disconnected' && <i className={connected ? 'online' : ''} />}
      </button>)}</nav>
      <div className="ssh-security"><ShieldCheck size={18} /><p>{tr('使用系统 OpenSSH。密钥留在本地；主机指纹必须先在终端验证。', 'System OpenSSH. Keys stay local; verify the host fingerprint in your terminal first.')}</p></div>
    </aside>
    <section className="ssh-main">
      <header className="ssh-header"><div><strong>{activeProfile && status.phase !== 'disconnected' ? activeProfile.name : profile?.name || tr('远程开发', 'Remote development')}</strong><small>{connected ? `${activeProfile?.host} · ${activeProfile?.cwd}` : tr('远程连接原型 · 尚未接入完整 Code 面板或离线 Runner', 'Remote connection prototype · full Code panels and offline runner not connected')}</small></div>
        <span className="ssh-prototype-badge" title="No remote PTY, Git workbench or detached execution guarantee">Prototype</span><span className={`ssh-status ${connected ? 'online' : ''}`}>{tr(status.phase === 'connected' ? '已连接' : status.phase === 'connecting' ? '连接中…' : '未连接', status.phase)}</span>
        {status.phase !== 'disconnected' && <button onClick={() => void run(async () => { await invoke('disconnect') })}>{tr('断开', 'Disconnect')}</button>}
      </header>
      {(error || status.error) && <div role="alert" className="ssh-error">{error || status.error}{profile && status.phase === 'disconnected' && needsRemotePathReview(error || status.error || '') && <button className="ssh-fix-paths" onClick={() => setEditing(profile)}>{tr('检查远端 Pi / Node / 目录路径', 'Edit remote Pi / Node / folder paths')}</button>}<button aria-label="Dismiss" onClick={() => { setError(''); setStatus((s) => ({ ...s, error: undefined })) }}><X size={14} /></button></div>}
      {status.outcomeUnknown && <div className="ssh-error" role="alert">{tr('远端操作结果未知，已暂停新操作。请停止或断开连接，不要直接重试可能修改文件的命令。', 'Remote outcome unknown. New operations are paused. Abort or disconnect; do not blindly retry commands that may change files.')}</div>}
      {editing ? <div className="ssh-setup"><SshProfileForm initial={editing === 'new' ? undefined : editing} zh={zh} passwordSupported={authCapabilities.password} passwordUnavailableReason={authCapabilities.passwordUnavailableReason} onCancel={() => setEditing(null)} onSave={async (p) => {
        await invoke('saveProfile', p)
        setProfiles((ps) => [...ps.filter((v) => v.id !== p.id), p]); setSelectedId(p.id); setEditing(null)
      }} /></div> : !connected ? <div className="ssh-setup">
        <div className="ssh-welcome-mark">✳</div><h1>{tr('让灵感，连接远方。', 'A little closer to your next idea.')}</h1>
        <p>{tr('连接远程工作区，让 Pi 在服务器上阅读代码、修改文件、运行测试。', 'Connect a remote workspace. Let Pi read code, edit files and run tests on your server.')}</p>
        {profile ? <div className="ssh-connect-card"><Server size={24} /><h2>{profile.name}</h2><code>{profile.user ? `${profile.user}@` : ''}{profile.host}{profile.port ? `:${profile.port}` : ''}</code><code>{profile.cwd}</code>
          <div className="ssh-actions"><button className="ssh-primary" disabled={working || status.phase !== 'disconnected'} onClick={beginConnect}>{tr('连接工作区', 'Connect workspace')}</button><button disabled={working || status.phase !== 'disconnected'} title={tr('编辑', 'Edit')} onClick={() => setEditing(profile)}><Pencil size={16} /></button><button disabled={working || status.phase !== 'disconnected'} title={tr('删除', 'Delete')} onClick={() => {
            if (window.confirm(tr('删除这个连接配置？不会删除远端文件。', 'Delete this connection? Remote files will not be removed.'))) void run(async () => { await invoke('deleteProfile', { id: profile.id }); setProfiles((ps) => ps.filter((p) => p.id !== profile.id)); setSelectedId('') })
          }}><Trash2 size={16} /></button></div>
          <small className="ssh-auth-summary">{profile.authMethod === 'password' ? tr('密码认证 · 每次连接输入，不保存', 'Password authentication · ask every time, never saved') : tr('密钥 / SSH Agent 认证', 'Key / SSH Agent authentication')}</small>
          {authCapabilities.password && profile.authMethod !== 'password' && <button disabled={working || status.phase !== 'disconnected'} className="ssh-password-switch" onClick={() => void run(async () => {
            const result = await invoke<{ profile: SshProfile }>('saveProfile', { ...profile, authMethod: 'password' })
            setProfiles((all) => all.map((p) => p.id === result.profile.id ? result.profile : p))
            setPasswordProfile(result.profile)
          })}>{tr('改用密码登录…', 'Use password instead…')}</button>}
        </div> : <button className="ssh-primary" onClick={() => setEditing('new')}><Plus size={16} />{tr('添加 SSH 连接', 'Add SSH connection')}</button>}
        <details className="ssh-help"><summary>{tr('首次连接需要准备什么？', 'First connection checklist')}</summary><ol><li>{tr('本地安装 OpenSSH。可用密钥/SSH Agent，或在 Linux/macOS 安装 sshpass 后使用密码。', 'Install OpenSSH locally. Use key/agent authentication, or install sshpass on Linux/macOS for password sign-in.')}</li><li>{tr('先在终端 ssh 到主机，核对指纹后加入 known_hosts。遇到主机密钥变化，不要绕过检查。', 'Connect using ssh in a terminal, verify the fingerprint and enroll it in known_hosts. Never bypass a changed host key.')}</li><li>{tr('远端安装 Node.js ≥22.19 和 Pi，完成模型登录。可填写 Pi / Node 的绝对路径。', 'Install Node.js ≥22.19 and Pi remotely; sign in to a model provider. Absolute executable paths are supported.')}</li><li>{tr('只打开信任的仓库；远端 Pi 可以执行命令并修改远端文件。', 'Only open trusted repositories. Remote Pi can execute commands and modify remote files.')}</li></ol></details>
      </div> : <div className="ssh-connected-layout">
        <div className="ssh-chat"><div className="ssh-messages" aria-live="polite">
          {!chat.messages.length && <div className="ssh-chat-empty"><span>✳</span><h1>{tr('从这里，开始构建。', 'What shall we build?')}</h1><p>{tr('所有开发操作都在远程工作区执行。', 'All development operations run in the remote workspace.')}</p><div className="ssh-suggestions">{[tr('梳理项目架构', 'Explain the project architecture'), tr('运行测试并分析失败原因', 'Run tests and investigate failures'), tr('检查当前 Git 变更', 'Review current Git changes')].map((s) => <button key={s} onClick={() => setDraft(s)}>{s}</button>)}</div></div>}
          {chat.messages.map((m) => m.role === 'tool' ? <details key={m.id} className="ssh-tool"><summary>{m.pending ? '◌ ' : '✓ '}{m.text.split('\n')[0]}</summary><pre>{m.text}</pre></details> : <article key={m.id} className={`ssh-message ${m.role}`}><small>{m.role === 'assistant' ? 'Pi' : tr('你', 'You')}</small><div>{m.role === 'assistant' ? <RemoteMarkdown text={m.text || (m.pending ? '…' : '')} /> : m.text}</div></article>)}<div ref={endRef} />
        </div>
        {dialog && <div className="ssh-dialog" role="dialog" aria-label={dialog.title}><strong>{dialog.title}</strong><p>{dialog.message}</p>{dialog.method === 'select' ? dialog.options?.map((value) => <button key={value} onClick={() => void respond({ value })}>{value}</button>) : dialog.method === 'confirm' ? <button className="ssh-primary" onClick={() => void respond({ confirmed: true })}>{tr('确认', 'Confirm')}</button> : <><textarea value={dialogText} placeholder={dialog.placeholder} onChange={(e) => setDialogText(e.target.value)} /><button onClick={() => void respond({ value: dialogText })}>{tr('提交', 'Submit')}</button></>}<button onClick={() => void respond({ cancelled: true })}>{tr('取消', 'Cancel')}</button></div>}
        <div className="ssh-composer"><textarea aria-label={tr('远程消息', 'Remote message')} placeholder={tr('让 Pi 在远端帮你做点什么…', 'Ask Pi to work in your remote workspace…')} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
          <div className="ssh-composer-footer"><select aria-label="Remote model" disabled={locked} value={status.model || ''} onChange={(e) => { const m = models.find((v) => `${v.provider}/${v.id}` === e.target.value); if (m) void run(async () => { await rpc({ type: 'set_model', provider: m.provider, modelId: m.id }) }) }}><option value="" disabled>{tr('远程模型', 'Remote model')}</option>{models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name || m.id} · {m.provider}</option>)}</select>
            <button disabled={locked} onClick={() => void run(async () => { const r = await rpc({ type: 'new_session' }); if (!(r.data as { cancelled?: boolean })?.cancelled) { setChat(emptyRemoteChat); setDialogs([]) } })}>{tr('新会话', 'New chat')}</button>
            {chat.busy ? <button title={tr('停止生成', 'Stop')} onClick={() => void run(async () => { await rpc({ type: 'abort' }) })}><Square size={16} /></button> : <button className="ssh-primary" disabled={locked || !draft.trim()} title={tr('发送', 'Send')} onClick={send}><ArrowUp size={18} /></button>}
          </div><small>{tr('SSH · 远程执行 · 会话保存在远端', 'SSH · Remote execution · Sessions stored remotely')}</small>
        </div></div>
        <aside className="ssh-inspector"><div className="ssh-inspector-tabs"><button className={panel === 'files' ? 'selected' : ''} onClick={() => setPanel('files')}><Folder size={14} />{tr('文件', 'Files')}</button><button className={panel === 'console' ? 'selected' : ''} onClick={() => setPanel('console')}><Terminal size={14} />{tr('命令', 'Commands')}</button></div>
          {panel === 'files' ? <><div className="ssh-file-toolbar"><code>{files.path || '/'}</code><button disabled={locked} onClick={() => void browse(files.path)}>{tr('刷新', 'Refresh')}</button></div><button disabled={locked} onClick={() => void browse(files.path.split('/').slice(0, -1).join('/'))}>..</button><div className="ssh-file-list">{files.entries?.map((f) => <button disabled={locked} key={f.path} onClick={() => void (f.directory ? browse(f.path) : run(async () => { setPreview(await invoke<SshFilesResult>('files', { action: 'read', path: f.path })) }))}>{f.directory ? <Folder size={15} /> : <FileText size={15} />}<span>{f.name}</span></button>)}</div>{preview && <div className="ssh-file-preview"><strong>{preview.path}</strong><pre>{preview.text}</pre><button onClick={() => setDraft((s) => `${s}${s ? '\n' : ''}${tr('请查看并修改这个文件：', 'Please inspect and edit this file: ')}${preview.path}`)}>{tr('让 Pi 编辑', 'Ask Pi to edit')}</button></div>}<small className="ssh-hint">{tr('点击刷新浏览远端文件；原型文本预览 ≤4 KiB。', 'Refresh to browse remote files; prototype text previews ≤4 KiB.')}</small></> : <><p className="ssh-hint">{tr('远程命令控制台（非交互式终端），使用远端 Pi 的 bash。', 'Remote command console (not an interactive terminal), powered by remote Pi bash.')}</p><textarea aria-label="Remote command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="git status --short" /><div className="ssh-actions"><button disabled={locked || !command.trim()} onClick={() => void run(async () => { setOutput(''); const r = await rpc({ type: 'bash', command, excludeFromContext: true }); const d = r.data as { output?: string; exitCode?: number }; setOutput(`${d.output || ''}\n[exit ${d.exitCode}]`) })}>{tr('运行', 'Run')}</button><button onClick={() => void rpc({ type: 'abort_bash' }).catch((e) => setError(String(e)))}>{tr('停止命令', 'Stop command')}</button></div><pre className="ssh-console-output">{output}</pre></>}
        </aside>
      </div>}
      {passwordProfile && active && <SshPasswordDialog profile={passwordProfile} zh={zh} onCancel={() => setPasswordProfile(null)} onSubmit={(password) => { const target = passwordProfile; setPasswordProfile(null); void connect(target, password) }} />}
      {diagnostics && <details className="ssh-diagnostics"><summary>{tr('连接诊断', 'Connection diagnostics')}</summary><pre>{diagnostics}</pre></details>}
    </section>
  </div>
}
