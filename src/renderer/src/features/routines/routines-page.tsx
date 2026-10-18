import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock as CalendarClock, ChevronLeft, Clock as Clock3, FolderOpen, Plus, Check as Save, AlertTriangle as ShieldAlert, X } from '@renderer/components/icons'
import type { Routine, RoutineEvent, RoutineRun, RoutineSchedule } from '@shared/routine-types'
import type { ProductSurface } from '@shared/execution-target'
import { ReferenceSidebarNavigation } from '@renderer/components/app/reference-sidebar'
import { isRunActive as active, RoutineDetail, RoutineList } from './routine-views'
import './routines.css'

type Snapshot = { routines: Routine[]; runs: RoutineRun[]; runtime: { kind: 'desktop-local'; requiresAppOpen: true } }
async function invoke<T>(name: string, request?: unknown): Promise<T> {
  if (!window.piDesktop) throw new Error('Routines require the desktop app')
  return window.piDesktop.invoke(`ipc:routines.${name}`, request ?? {}) as Promise<T>
}
function newRoutine(surface: ProductSurface): Routine {
  return { id: crypto.randomUUID(), name: '', description: '', prompt: '', surface, permissionMode: 'read-only', enabled: true, schedule: { type: 'manual' }, createdAt: Date.now(), updatedAt: Date.now() }
}
function localDateValue(value: number): string { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

export function RoutinesPage({ surface, sidebarFooter, onNewWorkspace = () => {}, onCustomize = () => {}, onSelectLocalFolder }: { surface: ProductSurface; sidebarFooter?: ReactNode; onNewWorkspace?: () => void; onCustomize?: () => void; onSelectLocalFolder?: (initialPath?: string) => Promise<string | undefined> }) {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const tr = (cn: string, en: string) => zh ? cn : en
  const [snapshot, setSnapshot] = useState<Snapshot>({ routines: [], runs: [], runtime: { kind: 'desktop-local', requiresAppOpen: true } })
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Routine | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [onceInput, setOnceInput] = useState('')
  const [error, setError] = useState('')
  const [busyCount, setBusyCount] = useState(0)
  const [models, setModels] = useState<Array<{ id: string; provider: string; name: string }>>([])
  const [focusedRun, setFocusedRun] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const loadToken = useRef(0)
  const runVersion = useRef(0)
  const runVersions = useRef(new Map<string, number>())
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const selectionEpoch = useRef(0)
  const followNewRuns = useRef(true)
  const pendingManual = useRef<{ routineId: string; epoch: number } | null>(null)
  const focusRun = (id: string | null) => setFocusedRun(id)
  const selectRun = (id: string | null) => { ++selectionEpoch.current; followNewRuns.current = false; focusRun(id) }
  const noteRun = (id: string) => {
    const versions = runVersions.current
    versions.delete(id)
    versions.set(id, ++runVersion.current)
    if (versions.size > 1000) versions.delete(versions.keys().next().value!)
  }
  const busy = busyCount > 0
  const routine = snapshot.routines.find((r) => r.id === selected)
  const runs = snapshot.runs.filter((r) => r.routineId === selected).sort((a, b) => b.scheduledAt - a.scheduledAt)
  const load = async () => {
    const token = ++loadToken.current
    const version = runVersion.current
    let data: Snapshot
    try { data = await invoke<Snapshot>('list') } catch (e) { if (token === loadToken.current) setLoadFailed(true); throw e }
    if (token !== loadToken.current) return
    setSnapshot((old) => {
      // Only events newer than this request win; unrelated historical rows may refresh.
      const newer = old.runs.filter((r) => (runVersions.current.get(r.id) ?? 0) > version)
      return { ...data, runs: [...newer, ...data.runs.filter((r) => !newer.some((v) => v.id === r.id))].slice(0, 1000) }
    })
    setLoaded(true); setLoadFailed(false)
  }
  const action = async (fn: () => Promise<void>) => {
    setBusyCount((n) => n + 1); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusyCount((n) => n - 1) }
  }
  useEffect(() => {
    let live = true
    const off = window.piDesktop?.onRoutineEvent?.((event: RoutineEvent) => {
      if (event.kind === 'run') {
        noteRun(event.run.id)
        setSnapshot((s) => ({ ...s, runs: [event.run, ...s.runs.filter((r) => r.id !== event.run.id)].slice(0, 1000) }))
        const pending = pendingManual.current
        if (selectedRef.current === event.run.routineId && (
          (pending?.routineId === event.run.routineId && pending.epoch === selectionEpoch.current && event.run.trigger === 'manual') ||
          (followNewRuns.current && active(event.run))
        )) focusRun(event.run.id)
      }
      if (event.kind === 'changed') void load().catch((e) => { if (live) setError(String(e)) })
    })
    void load().catch((e) => { if (live) setError(String(e)) })
    void window.piDesktop?.invoke('ipc:chat.models', {}).then((r) => { if (live) setModels(r.models || []) }).catch(() => {})
    return () => { live = false; ++loadToken.current; off?.() }
    // The service owns the schedule; this screen only subscribes to events.
  }, [])
  const beginEdit = (r: Routine) => { setEditing(structuredClone(r)); setOnceInput(r.schedule.type === 'once' ? localDateValue(r.schedule.at) : ''); setConfirmed(false); setError('') }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!editing || busy) return
    let definition = editing
    if (editing.schedule.type === 'once') {
      const at = new Date(onceInput).getTime()
      if (!onceInput || !Number.isFinite(at)) { setError(tr('请输入有效的一次性运行时间。', 'Enter a valid one-time schedule.')); return }
      definition = { ...editing, schedule: { type: 'once', at } }
    }
    void action(async () => {
      const result = await invoke<{ routine: Routine }>('save', { routine: definition, confirmedExecution: confirmed })
      ++selectionEpoch.current; selectedRef.current = result.routine.id; setSelected(result.routine.id); focusRun(null); followNewRuns.current = true; setEditing(null); await load()
    })
  }
  const toggle = (r: Routine) => action(async () => {
    const grant = r.permissionMode !== 'trusted-code' || window.confirm(tr('此任务拥有本机命令执行和文件修改权限。确认保存此授权？', 'This task can execute commands and modify files with your local user permissions. Confirm this authorization?'))
    if (!grant) return
    await invoke('save', { routine: { ...r, enabled: !r.enabled }, confirmedExecution: r.permissionMode === 'trusted-code' }); await load()
  })
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const templates: Routine[] = [
    { ...newRoutine('chat'), id: 'example-online-weather', name: tr('杭州天气', 'Hangzhou weather'), description: tr('明确授权：只读在线天气查询，无 shell 或文件访问', 'Explicit opt-in: read-only online weather, no shell or file access'), onlineWeather: true, prompt: tr('使用 weather 工具查询杭州（中国）的当前天气。报告温度、体感、风速、降水、天气代码以及数据源的观测时间和时区。查询失败时说明原因，不要编造。', 'Use the weather tool to look up current weather for Hangzhou, CN. Report temperature, apparent temperature, wind, precipitation, weather code, source observation time and timezone. If unavailable, explain without inventing conditions.') },
    { ...newRoutine('code'), id: 'example-code-review', name: tr('每日代码审阅', 'Daily code review'), description: tr('只读检查潜在问题', 'Read-only inspection'), prompt: tr('阅读工作目录中的代码，列出值得关注的错误风险与改进建议。不要修改文件。', 'Read the workspace code and report potential defects and improvements. Do not modify files.'), schedule: { type: 'daily', time: '09:00', timezone } },
    { ...newRoutine('chat'), id: 'example-weekly-reflection', name: tr('每周复盘提纲', 'Weekly reflection'), description: tr('每周复盘问题清单', 'A weekly reflection checklist'), prompt: tr('请生成一份简洁的周复盘问题清单，帮助我梳理成果、问题和下周优先事项。不要声称已读取我的日历或邮件。', 'Generate a concise weekly reflection checklist. Do not claim access to my calendar or email.'), schedule: { type: 'weekly', time: '17:00', timezone, dayOfWeek: 5 } },
  ]
  const openRoutine = (id: string) => {
    ++selectionEpoch.current
    selectedRef.current = id
    setSelected(id); setEditing(null); followNewRuns.current = true
    focusRun(snapshot.runs.filter((r) => r.routineId === id && active(r)).sort((a, b) => b.scheduledAt - a.scheduledAt)[0]?.id ?? null)
  }
  const runNow = (id: string) => action(async () => {
    const pending = { routineId: id, epoch: selectionEpoch.current }
    pendingManual.current = pending
    try {
      // The service returns the dispatch immediately; never await executor completion.
      const result = await invoke<{ run: RoutineRun }>('run', { id })
      setSnapshot((s) => s.runs.some((r) => r.id === result.run.id) ? s : { ...s, runs: [result.run, ...s.runs].slice(0, 1000) })
      noteRun(result.run.id)
      if (selectedRef.current === id && selectionEpoch.current === pending.epoch) focusRun(result.run.id)
    } finally { if (pendingManual.current === pending) pendingManual.current = null }
  })

  return <div className="routines-product" data-testid="routines-product">
    <aside className="product-sidebar reference-routines-sidebar"><ReferenceSidebarNavigation surface={surface} onNew={onNewWorkspace} onRoutines={() => { if (!busy) { ++selectionEpoch.current; selectedRef.current = null; setEditing(null); setSelected(null); focusRun(null) } }} onCustomize={onCustomize} /><div className="reference-list-heading"><span>{tr('计划任务', 'Scheduled')}</span><button aria-label={tr('创建任务', 'New routine')} data-app-tooltip={tr('创建任务', 'New routine')} disabled={busy} onClick={() => beginEdit(newRoutine(surface))}><Plus size={17} /></button></div>
      <nav className="routine-sidebar-list" aria-label="Routines">{snapshot.routines.map((r) => <button key={r.id} disabled={busy} className={selected === r.id ? 'selected' : ''} onClick={() => openRoutine(r.id)}><CalendarClock size={15} /><span>{r.name}<small>{r.surface === 'chat' ? 'Chat' : 'Code'} · {r.enabled ? tr('已启用', 'Active') : tr('已暂停', 'Paused')}</small></span>{snapshot.runs.some((run) => run.routineId === r.id && active(run)) && <i className="routine-live-dot" />}</button>)}</nav>
      <div className="product-safety-note sr-only"><Clock3 size={17} /><p>{tr('当前版本在本机运行；桌面必须保持开启且电脑处于唤醒状态。关闭程序后不会调度。', 'Runs locally while the desktop app is open and the computer is awake. No scheduling after the app quits.')}</p></div>
      {sidebarFooter}
    </aside>
    <main className="routine-main rt-main">
      {error && <div className="product-error" role="alert">{error}<button onClick={() => setError('')} aria-label={tr('关闭错误', 'Dismiss')} data-app-tooltip={tr('关闭错误', 'Dismiss')}><X size={14} /></button></div>}
      {editing ? <form className="routine-editor" onSubmit={save}><fieldset disabled={busy}><button type="button" className="routine-back" onClick={() => setEditing(null)}><ChevronLeft size={15} />{tr('取消编辑', 'Cancel editing')}</button><h1>{tr('一次说明，按时完成。', 'Describe it once. Run it on time.')}</h1>
        <div className="routine-form-grid"><label>{tr('名称', 'Name')}<input autoFocus required maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label><label>{tr('任务类型', 'Surface')}<select value={editing.surface} onChange={(e) => setEditing({ ...editing, surface: e.target.value as ProductSurface, onlineWeather: undefined, ...(e.target.value === 'chat' ? { permissionMode: 'read-only', cwd: undefined } : {}) })}><option value="chat">Chat · {tr('文字/分析', 'Conversation')}</option><option value="code">Code · {tr('代码工作区', 'Workspace')}</option></select></label></div>
        <label>{tr('描述', 'Description')}<input maxLength={500} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
        <label>{tr('任务指令', 'Instructions')}<textarea required rows={6} maxLength={50000} placeholder={tr('描述任务目标、成功条件和需要避免的操作…', 'Describe the outcome, how to check it, and what not to do…')} value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} /></label>
        {editing.surface === 'code' && <label>{tr('本机工作目录（绝对路径）', 'Local working folder (absolute path)')}<div className="routine-folder-field"><input required value={editing.cwd || ''} onChange={(e) => setEditing({ ...editing, cwd: e.target.value })} placeholder="/home/dev/project" /><button type="button" aria-label={tr('选择本机文件夹', 'Choose local folder')} data-app-tooltip={onSelectLocalFolder ? tr('选择本机文件夹', 'Choose local folder') : tr('文件夹选择器不可用，可输入绝对路径', 'Folder picker unavailable; enter an absolute path')} disabled={!onSelectLocalFolder} onClick={() => void action(async () => { const path = await onSelectLocalFolder?.(editing.cwd); if (path) setEditing((v) => v?.id === editing.id && v.surface === 'code' ? { ...v, cwd: path } : v) })}><FolderOpen size={17} /></button></div></label>}
        <div className="routine-form-grid"><label>{tr('模型', 'Model')}<select value={editing.model || ''} onChange={(e) => setEditing({ ...editing, model: e.target.value || undefined })}><option value="">{tr('Pi 默认模型', 'Pi default model')}</option>{editing.model && !models.some((m) => `${m.provider}/${m.id}` === editing.model) && <option value={editing.model}>{editing.model}</option>}{models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.provider}</option>)}</select></label>
          <label>{tr('工具权限', 'Tool permission')}<select disabled={editing.surface === 'chat'} value={editing.permissionMode} onChange={(e) => { setEditing({ ...editing, permissionMode: e.target.value as Routine['permissionMode'] }); setConfirmed(false) }}><option value="read-only">{editing.surface === 'chat' ? editing.onlineWeather === true ? tr('只读天气查询', 'Read-only weather') : tr('无工具执行', 'No tools') : tr('只读代码分析', 'Read-only code analysis')}</option>{editing.surface === 'code' && <option value="trusted-code">{tr('信任环境：允许执行命令和修改文件', 'Trusted environment: commands and file changes')}</option>}</select></label></div>
        {editing.surface === 'chat' && <><label className="routine-checkbox"><input data-testid="routine-online-weather" type="checkbox" aria-describedby="routine-weather-explanation" checked={editing.onlineWeather === true} onChange={(e) => setEditing({ ...editing, onlineWeather: e.target.checked })} />{tr('在线天气查询（只读）', 'Online weather lookup (read-only)')}</label><p id="routine-weather-explanation" className="routine-form-hint">{tr('将城市名称发送至 Open-Meteo 公共天气服务。仅查询天气，不授予 shell、文件、通用网页、扩展或 MCP 权限。旧任务默认关闭；只有明确勾选并保存才会启用。', 'Sends the city to Open-Meteo to read public weather. No shell, filesystem, general web, extensions or MCP access. Existing tasks remain off unless you explicitly enable and save this permission.')}</p>{editing.onlineWeather !== true && <p className="routine-form-hint" role="note">{tr('Chat 当前无工具，无法查询实时天气或其他在线信息。', 'Chat currently has no tools and cannot retrieve current weather or other live information.')}</p>}</>}
        {editing.surface === 'code' && editing.permissionMode === 'read-only' && <p className="routine-form-hint" role="note">{tr('只读是工具策略，不是沙箱：read/grep/find/ls 仍可读取当前用户有权访问的项目外文件。禁止 shell、写入、扩展和 MCP。', 'Read-only is a tool policy, not a sandbox: read/grep/find/ls can read user-accessible files outside the project. Shell, writes, extensions and MCP are disabled.')}</p>}
        {editing.permissionMode === 'trusted-code' && <label className="routine-permission-warning"><ShieldAlert size={21} /><span>{tr('这不是 OS 沙箱。任务拥有当前本机用户的文件与命令权限，可能读取敏感信息或修改项目外文件。请只用于你信任的目录和指令。', 'This is not an OS sandbox. Commands and files use your local account permissions and may affect paths outside the project. Use only trusted folders and instructions.')}<span className="routine-checkbox"><input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{tr('我确认授予此任务上述权限', 'I authorize these permissions for this routine')}</span></span></label>}
        <div className="routine-form-grid"><label>{tr('运行频率', 'Schedule')}<select value={editing.schedule.type} onChange={(e) => { const type = e.target.value; const at = Date.now() + 3600000; if (type === 'once') setOnceInput(localDateValue(at)); setEditing({ ...editing, schedule: type === 'manual' ? { type } : type === 'once' ? { type, at } : { type: type as 'daily' | 'weekdays' | 'weekly', time: '09:00', timezone, ...(type === 'weekly' ? { dayOfWeek: 1 } : {}) } }) }}><option value="manual">{tr('仅手动', 'Manual')}</option><option value="once">{tr('一次性', 'Once')}</option><option value="daily">{tr('每天', 'Daily')}</option><option value="weekdays">{tr('工作日', 'Weekdays')}</option><option value="weekly">{tr('每周', 'Weekly')}</option></select></label>
          {editing.schedule.type === 'once' && <label>{tr('本地时间', 'Local date and time')}<input type="datetime-local" required value={onceInput} onChange={(e) => setOnceInput(e.target.value)} /></label>}
          {['daily', 'weekdays', 'weekly'].includes(editing.schedule.type) && <label>{tr('时间', 'Time')}<input type="time" required value={(editing.schedule as { time: string }).time} onChange={(e) => setEditing({ ...editing, schedule: { ...editing.schedule, time: e.target.value } as RoutineSchedule })} /></label>}
        </div>
        {['daily', 'weekdays', 'weekly'].includes(editing.schedule.type) && <div className="routine-form-grid"><label>{tr('IANA 时区', 'IANA timezone')}<input required value={(editing.schedule as { timezone: string }).timezone} placeholder="Asia/Shanghai" onChange={(e) => setEditing({ ...editing, schedule: { ...editing.schedule, timezone: e.target.value } as RoutineSchedule })} /></label>{editing.schedule.type === 'weekly' && <label>{tr('星期', 'Day of week')}<select value={editing.schedule.dayOfWeek ?? 1} onChange={(e) => setEditing({ ...editing, schedule: { ...editing.schedule, dayOfWeek: Number(e.target.value) } as RoutineSchedule })}>{(zh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']).map((day, i) => <option key={i} value={i}>{day}</option>)}</select></label>}</div>}
        <label className="routine-checkbox"><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />{tr('启用此任务', 'Enable this routine')}</label>
        <p className="routine-form-hint">{tr('错过运行时，最多补跑最近 7 天内的一次。每个任务不重叠，最多同时执行 2 个任务；退出前未结束的运行会记为中断，不自动重放。', 'At most one catch-up from the last 7 days. Runs do not overlap per routine; global concurrency is 2. Interrupted work is recorded, never automatically replayed.')}</p>
        <div className="product-modal-actions"><button type="button" onClick={() => setEditing(null)}>{tr('取消', 'Cancel')}</button><button className="product-primary" disabled={busy || (editing.permissionMode === 'trusted-code' && !confirmed)}><Save size={16} />{tr('保存任务', 'Save routine')}</button></div></fieldset>
      </form> : routine ? <RoutineDetail key={routine.id} routine={routine} runs={runs} focusedRun={focusedRun} busy={busy} tr={tr}
        onBack={() => { ++selectionEpoch.current; selectedRef.current = null; setSelected(null); focusRun(null) }} onEdit={() => beginEdit(routine)} onToggle={() => void toggle(routine)} onSelectRun={selectRun}
        onRun={() => void runNow(routine.id)}
        onCancel={(runId) => void action(async () => { await invoke('cancel', { runId }); await load() })}
        onDelete={() => { if (window.confirm(tr('删除此任务？运行审计记录会保留，不会删除项目文件。', 'Delete this routine? Audit history is retained; project files are not removed.'))) void action(async () => { await invoke('delete', { id: routine.id }); ++selectionEpoch.current; selectedRef.current = null; setSelected(null); focusRun(null); await load() }) }}
      /> : <RoutineList routines={snapshot.routines} runs={snapshot.runs} templates={templates} loaded={loaded} loadFailed={loadFailed} onRetry={() => void action(load)} busy={busy} tr={tr} onOpen={openRoutine} onNew={(kind) => beginEdit(newRoutine(kind))} onTemplate={(template) => beginEdit({ ...template, id: crypto.randomUUID() })} />}
    </main>
  </div>
}
