import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSwapFade } from '@renderer/hooks/use-ui-motion'
import { CheckCircle2, ChevronDown, ChevronLeft, Clock, FolderOpen, History, PanelRightOpen, Pencil, Play, Plus, Search, SlidersHorizontal, Square, Trash2, X } from '@renderer/components/icons'
import type { Routine, RoutineRun, RoutineSchedule } from '@shared/routine-types'
import type { ProductSurface } from '@shared/execution-target'
import { RemoteMarkdown } from '@renderer/features/ssh/remote-markdown'

type Tr = (cn: string, en: string) => string
export const isRunActive = (run: RoutineRun) => run.status === 'unknown' ? run.executionSettledAt === undefined : ['queued', 'running'].includes(run.status)
export function displayDate(value?: number): string { return value === undefined ? '—' : new Date(value).toLocaleString() }
export function scheduleText(schedule: RoutineSchedule, tr: Tr): string {
  if (schedule.type === 'manual') return tr('仅手动运行', 'Manual only')
  if (schedule.type === 'once') return `${tr('一次性', 'Once')} · ${displayDate(schedule.at)}`
  const frequency = { daily: tr('每天', 'Daily'), weekdays: tr('工作日', 'Weekdays'), weekly: tr('每周', 'Weekly') }[schedule.type]
  const days = tr('周日,周一,周二,周三,周四,周五,周六', 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday').split(',')
  return `${frequency}${schedule.type === 'weekly' ? ` · ${days[schedule.dayOfWeek ?? 1]}` : ''} · ${schedule.time} · ${schedule.timezone}`
}
export function statusText(status: RoutineRun['status'], tr: Tr): string {
  return { queued: tr('排队中', 'Queued'), running: tr('运行中', 'Running'), succeeded: tr('执行完成', 'Completed'), failed: tr('失败', 'Failed'), cancelled: tr('已取消', 'Cancelled'), skipped: tr('已跳过', 'Skipped'), interrupted: tr('已中断', 'Interrupted'), unknown: tr('结果未知', 'Outcome unknown') }[status]
}

function NewTask({ tr, busy, onNew }: { tr: Tr; busy: boolean; onNew: (surface: ProductSurface) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  return <div className="rt-new-task" ref={root} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }} onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} className="rt-primary" disabled={busy} aria-expanded={open} aria-controls="routine-new-options" onClick={() => setOpen(!open)}>{tr('新建任务', 'New task')}<ChevronDown size={16} /></button>
    {open && <div id="routine-new-options" className="rt-popover" role="group" aria-label={tr('任务类型', 'Task type')}>{(['chat', 'code'] as const).map((surface) => <button key={surface} disabled={busy} onClick={() => { setOpen(false); onNew(surface) }}><Plus size={16} />{surface === 'chat' ? 'Chat' : 'Code'}<small>{surface === 'chat' ? tr('无工具', 'No tools') : tr('本机工作目录', 'Local workspace')}</small></button>)}</div>}
  </div>
}

export function RoutineList({ routines, runs, templates, loaded, loadFailed, busy, tr, onOpen, onNew, onTemplate, onRetry }: { routines: Routine[]; runs: RoutineRun[]; templates: Routine[]; loaded: boolean; loadFailed: boolean; busy: boolean; tr: Tr; onOpen: (id: string) => void; onNew: (surface: ProductSurface) => void; onTemplate: (routine: Routine) => void; onRetry: () => void }) {
  const [tab, setTab] = useState<'yours' | 'templates'>('yours')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [status, setStatus] = useState('all')
  const [surface, setSurface] = useState('all')
  const [sort, setSort] = useState('updated')
  const items = (tab === 'yours' ? routines : templates).filter((r) =>
    `${r.name}\n${r.description}\n${r.prompt}\n${r.cwd || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (surface === 'all' || r.surface === surface) && (status === 'all' || (status === 'active' ? r.enabled : !r.enabled))
  ).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'next' ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  return <section className="rt-list" aria-label={tr('计划任务', 'Scheduled tasks')}>
    <h1>{tr('计划任务', 'Scheduled tasks')}</h1>
    <div className="rt-toolbar"><div className="rt-tabs" role="tablist" aria-label={tr('任务列表', 'Task lists')} onKeyDown={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'yours' : e.key === 'End' ? 'templates' : tab === 'yours' ? 'templates' : 'yours'; setTab(next); document.getElementById(`routine-${next}-tab`)?.focus() } }}>
      <button role="tab" id="routine-yours-tab" tabIndex={tab === 'yours' ? 0 : -1} aria-controls="routine-list-panel" aria-selected={tab === 'yours'} onClick={() => setTab('yours')}>{tr('我的', 'Yours')}</button>
      <button role="tab" id="routine-templates-tab" tabIndex={tab === 'templates' ? 0 : -1} aria-controls="routine-list-panel" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>{tr('模板', 'Templates')}</button>
    </div><div className="rt-toolbar-actions">
      <button className="rt-icon" aria-label={tr('搜索任务', 'Search tasks')} data-app-tooltip={tr('搜索任务', 'Search tasks')} aria-expanded={searchOpen} aria-controls="routine-search" onClick={() => setSearchOpen(!searchOpen)}><Search size={19} /></button>
      <button className={`rt-icon ${status !== 'all' || surface !== 'all' ? 'rt-filter-active' : ''}`} aria-label={tr('筛选任务', 'Filter tasks')} data-app-tooltip={tr('筛选任务', 'Filter tasks')} aria-expanded={filtersOpen} aria-controls="routine-filters" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={19} /></button>
      <button className="rt-icon" aria-label={tr('排序任务', 'Sort tasks')} data-app-tooltip={tr('排序任务', 'Sort tasks')} aria-expanded={sortOpen} aria-controls="routine-sort" onClick={() => setSortOpen(!sortOpen)}><span aria-hidden="true">↕</span></button>
      <NewTask tr={tr} busy={busy} onNew={onNew} />
    </div></div>
    {searchOpen && <label className="rt-search" id="routine-search"><Search size={17} /><input autoFocus aria-label={tr('搜索任务', 'Search tasks')} placeholder={tr('搜索名称、描述和指令', 'Search names, descriptions and instructions')} value={query} onChange={(e) => setQuery(e.target.value)} /><button className="rt-icon" aria-label={tr('清除搜索', 'Clear search')} data-app-tooltip={tr('清除搜索', 'Clear search')} onClick={() => setQuery('')}><X size={16} /></button></label>}
    {!searchOpen && query && <button className="rt-search-summary" onClick={() => setSearchOpen(true)}>{tr('搜索', 'Search')}: {query}</button>}
    {(filtersOpen || sortOpen) && <div className="rt-filter-panel">
      {filtersOpen && <div id="routine-filters"><label>{tr('状态', 'Status filter')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">{tr('全部状态', 'All statuses')}</option><option value="active">{tr('已启用', 'Active')}</option><option value="paused">{tr('已暂停', 'Paused')}</option></select></label><label>{tr('类型', 'Surface filter')}<select value={surface} onChange={(e) => setSurface(e.target.value)}><option value="all">{tr('全部类型', 'All surfaces')}</option><option value="chat">Chat</option><option value="code">Code</option></select></label><button onClick={() => { setSurface('all'); setStatus('all'); setQuery('') }}>{tr('重置', 'Reset filters')}</button></div>}
      {sortOpen && <label id="routine-sort">{tr('排序方式', 'Sort order')}<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="updated">{tr('最近更新', 'Recently updated')}</option><option value="name">{tr('名称 A–Z', 'Name A–Z')}</option><option value="next">{tr('下次运行', 'Next run')}</option></select></label>}
    </div>}
    <p className="rt-lifecycle"><Clock size={18} /><span>{tr('本机计划任务仅在桌面应用开启且电脑处于唤醒状态时运行。退出应用后不会调度。', 'Local scheduled tasks only run while the desktop app is open and your computer is awake. No scheduling after the app quits.')}</span></p>
    <div id="routine-list-panel" role="tabpanel" aria-labelledby={tab === 'yours' ? 'routine-yours-tab' : 'routine-templates-tab'}>
      {tab === 'templates' && <p className="rt-help">{tr('示例会创建可编辑的草稿，不会立即安装或运行。', 'Examples create editable drafts. Nothing is installed or run automatically.')}</p>}
      {!loaded && tab === 'yours' ? loadFailed ? <div className="rt-empty"><p className="rt-help">{tr('无法加载任务。', 'Tasks could not be loaded.')}</p><button disabled={busy} onClick={onRetry}>{tr('重试', 'Retry')}</button></div> : <p role="status" className="rt-help">{tr('正在加载任务…', 'Loading tasks…')}</p> : items.length ? <div className="rt-card-grid">{items.map((r) => <button className="rt-card" data-testid={tab === 'yours' ? 'routine-card' : 'routine-template'} key={r.id} disabled={busy} onClick={() => tab === 'yours' ? onOpen(r.id) : onTemplate(r)}>
        <span className="rt-card-heading"><strong>{r.name}</strong><span className="rt-badge">{r.surface === 'chat' ? r.onlineWeather === true ? 'Chat+Weather' : 'Chat' : 'Code'}</span></span>
        <span className="rt-card-preview">{r.description || r.prompt}</span>
        <span className="rt-card-meta">{tab === 'templates' ? tr('示例草稿', 'Example draft') : runs.some((run) => run.routineId === r.id && isRunActive(run)) ? tr('执行中', 'Execution active') : r.enabled ? tr('已启用', 'Active') : tr('已暂停', 'Paused')}<span>·</span>{scheduleText(r.schedule, tr)}<span>·</span>{tr('仅此电脑', 'Only on this computer')}</span>
      </button>)}</div> : <div className="rt-empty"><h2>{query || surface !== 'all' || status !== 'all' ? tr('没有匹配的任务', 'No matching tasks') : tr('还没有计划任务', 'No scheduled tasks yet')}</h2><p className="rt-help">{tr('新建 Chat 或 Code 任务，或从模板开始。', 'Create a Chat or Code task, or start from a template.')}</p></div>}
    </div>
  </section>
}

function RunRows({ runs, selected, tr, onSelect }: { runs: RoutineRun[]; selected?: string; tr: Tr; onSelect: (id: string) => void }) {
  return <div className="rt-run-rows">{runs.map((run) => <button key={run.id} data-testid="routine-run-row" aria-current={selected === run.id ? 'true' : undefined} className={`rt-run-row ${selected === run.id ? 'selected' : ''}`} onClick={() => onSelect(run.id)}>
    {run.status === 'succeeded' ? <CheckCircle2 size={16} /> : <Clock size={16} />}<span><time dateTime={new Date(run.scheduledAt).toISOString()}>{displayDate(run.scheduledAt)}</time><small className={`rt-status-${run.status}`}>{statusText(run.status, tr)}</small></span>
    {run.output && <span className="rt-output-dot" aria-label={tr('有输出', 'Output available')} data-app-tooltip={tr('有输出', 'Output available')} />}
  </button>)}</div>
}

type DetailProps = { routine: Routine; runs: RoutineRun[]; focusedRun: string | null; busy: boolean; tr: Tr; onBack: () => void; onEdit: () => void; onDelete: () => void; onRun: () => void; onToggle: () => void; onSelectRun: (id: string | null) => void; onCancel: (id: string) => void }
export function RoutineDetail({ routine, runs, focusedRun, busy, tr, onBack, onEdit, onDelete, onRun, onToggle, onSelectRun, onCancel }: DetailProps) {
  const [expanded, setExpanded] = useState(false)
  const [runsOpen, setRunsOpen] = useState(true)
  const run = runs.find((r) => r.id === focusedRun)
  const outputRef = useSwapFade<HTMLElement>(run?.id)
  const previousRun = useRef<string | undefined>(undefined)
  const followOutput = useRef(true)
  useLayoutEffect(() => {
    const output = outputRef.current
    if (!output || !run) { previousRun.current = undefined; return }
    if (previousRun.current !== run.id) {
      previousRun.current = run.id
      followOutput.current = true
      output.scrollTop = isRunActive(run) ? output.scrollHeight : 0
    } else if (followOutput.current) output.scrollTop = output.scrollHeight
  }, [run?.id, run?.output, run?.status])
  const locked = busy || runs.some(isRunActive)
  const longInstructions = routine.prompt.length > 240
  const weatherEnabled = routine.surface === 'chat' && routine.onlineWeather === true
  const permission = routine.surface === 'chat' ? weatherEnabled ? tr('天气（只读）', 'Weather (read-only)') : tr('无工具', 'No tools') : routine.permissionMode === 'trusted-code' ? tr('信任执行', 'Trusted execution') : tr('只读', 'Read-only')
  const goToRun = (id: string) => { onSelectRun(id); setRunsOpen(true) }
  return <section className={`rt-task ${run ? 'rt-task-output' : ''}`}>
    <header className="rt-task-header"><nav className="rt-breadcrumb" aria-label={tr('面包屑', 'Breadcrumb')}><button disabled={busy} onClick={onBack}>{tr('计划任务', 'Scheduled tasks')}</button><span>/</span><span>{routine.name}</span></nav><div className="rt-task-actions">
      {run ? <><button onClick={() => onSelectRun(null)}><ChevronLeft size={16} />{tr('任务详情', 'Task details')}</button>{!runsOpen && <button onClick={() => setRunsOpen(true)}><PanelRightOpen size={17} />{tr('运行记录', 'Runs')}</button>}</> : <><button className="rt-icon" aria-label={tr('编辑', 'Edit')} data-app-tooltip={tr('编辑', 'Edit')} disabled={locked} onClick={onEdit}><Pencil size={18} /></button><button className="rt-icon" aria-label={tr('删除任务', 'Delete routine')} data-app-tooltip={tr('删除任务', 'Delete routine')} disabled={locked} onClick={onDelete}><Trash2 size={18} /></button><button className="rt-primary" disabled={locked} onClick={onRun}><Play size={16} />{tr('立即运行', 'Run now')}</button></>}
    </div></header>
    {run ? <div className={`rt-output-layout ${runsOpen ? '' : 'rt-runs-hidden'}`}><article ref={outputRef} className="rt-output" aria-label={tr('运行输出', 'Run output')} onScroll={(e) => {
      const output = e.currentTarget
      followOutput.current = output.scrollHeight - output.scrollTop - output.clientHeight < 96
    }}>
      <header><div><h1>{statusText(run.status, tr)}</h1><time dateTime={new Date(run.scheduledAt).toISOString()}>{displayDate(run.scheduledAt)}</time></div>{isRunActive(run) && <button disabled={busy} onClick={() => onCancel(run.id)}><Square size={15} />{tr('取消运行', 'Cancel run')}</button>}</header>
      {run.status === 'succeeded' && <p className="rt-help" data-testid="routine-completion-note">{tr('执行已完成，并不代表任务目标已验证。请查看实际输出和数据源时间。', 'Execution completed; the task goal was not independently verified. Check the output and source timestamps.')}</p>}
      <dl className="rt-run-metadata">{run.startedAt !== undefined && <><dt>{tr('开始', 'Started')}</dt><dd>{displayDate(run.startedAt)}</dd></>}{run.finishedAt !== undefined && <><dt>{tr('结束', 'Finished')}</dt><dd>{displayDate(run.finishedAt)}</dd></>}</dl>
      {isRunActive(run) && run.status === 'unknown' && <p className="rt-help" role="status">{tr('结果未知。执行器尚未确认停止，任务仍锁定。', 'Outcome unknown. Execution has not confirmed it stopped; this task remains locked.')}</p>}
      {run.error && <p className="rt-run-error" role="alert">{run.error}</p>}{run.skipReason && <p className="rt-help">{run.skipReason}</p>}
      {isRunActive(run) && <p className="rt-help rt-live-status" role="status" data-testid="routine-live-status"><span className="routine-live-dot" aria-hidden="true" />{run.status === 'unknown' ? tr('等待执行器停止…', 'Waiting for execution to stop…') : run.output ? tr('运行中 · 正在接收输出…', 'Running · receiving output…') : tr('运行中 · 等待输出…', 'Running · waiting for output…')}</p>}
      <div className="rt-output-markdown">{run.output ? <RemoteMarkdown text={run.output} /> : !isRunActive(run) && <p className="rt-help">{tr('暂无输出', 'No output yet')}</p>}</div>
      {run.outputTruncated && <p className="rt-help">{tr('存储的输出已截断。', 'Stored output was truncated.')}</p>}
      {run.sessionFile && <details className="rt-session-location"><summary>{tr('会话存储位置', 'Session location')}</summary><code>{run.sessionFile}</code></details>}
    </article>{runsOpen && <aside className="rt-runs-sidebar" aria-label={tr('运行记录', 'Runs')}><header><h2>{tr('运行记录', 'Runs')}</h2><button className="rt-icon" aria-label={tr('关闭运行面板', 'Close runs panel')} data-app-tooltip={tr('关闭运行面板', 'Close runs panel')} onClick={() => setRunsOpen(false)}><X size={17} /></button></header><div className="rt-runs-task"><strong>{routine.name}</strong><span className="rt-badge">Local</span><button onClick={() => onSelectRun(null)}>{tr('详情', 'Details')}</button><p>{scheduleText(routine.schedule, tr)}</p></div><RunRows runs={runs} selected={run.id} tr={tr} onSelect={goToRun} /></aside>}</div> : <div className="rt-detail-grid"><div className="rt-properties">
      <section><h2>{tr('描述', 'Description')}</h2><p className="rt-description">{routine.description || tr('未提供描述。', 'No description provided.')}</p></section>
      <section><h2>{tr('状态', 'Status')}</h2><div className="rt-status-line"><button className="rt-switch" role="switch" aria-checked={routine.enabled} aria-label={routine.enabled ? tr('暂停', 'Pause') : tr('启用', 'Enable')} disabled={locked} onClick={onToggle}><span /></button><span>{routine.enabled ? tr('已启用', 'Active') : tr('已暂停', 'Paused')}</span><span className="rt-help">{tr('下次运行', 'Next run')}: {routine.enabled ? displayDate(routine.nextRunAt) : tr('已暂停', 'Paused')}</span></div></section>
      <section><h2>{tr('文件夹', 'Folder')}</h2>{routine.cwd ? <span className="rt-folder"><FolderOpen size={17} />{routine.cwd}</span> : <p className="rt-help">{tr('无工作目录', 'No working folder')}</p>}</section>
      <section><h2>{tr('重复', 'Repeats')}</h2><p>{scheduleText(routine.schedule, tr)}</p></section>
      <section><h2>{tr('工具权限', 'Permission')}</h2><div className="rt-permission"><span className="rt-badge" data-testid="routine-permission-badge">{routine.surface === 'chat' ? weatherEnabled ? 'Chat+Weather' : 'Chat' : 'Code'}</span><strong>{permission}</strong></div><p className="rt-help">{routine.surface === 'chat' ? weatherEnabled ? tr('仅 weather 工具：将城市发送至 Open-Meteo 公共服务读取天气。无 shell、文件、通用网页、扩展或 MCP 权限。', 'Only the weather tool: sends the city to Open-Meteo for public weather. No shell, filesystem, general web, extensions or MCP access.') : tr('Chat 无工具，无法查询当前天气或其他在线信息。请编辑并明确授权只读在线天气，或选择天气模板创建草稿；不会自动授予权限。', 'Chat has no tools and cannot retrieve current weather or other live information. Edit to explicitly enable read-only online weather, or choose the weather template to create a draft. No permission is granted automatically.') : routine.permissionMode === 'trusted-code' ? tr('以本机用户权限执行命令和修改文件。这不是 OS 沙箱。', 'Commands and file changes use your local account permissions. This is not an OS sandbox.') : tr('只读工具策略，不是沙箱。可读取项目外有权限的文件；禁止 shell 和写入。', 'Read-only tool policy, not a sandbox. Can read accessible files outside the project; shell and writes are disabled.')}</p></section>
      <section><h2>{tr('模型', 'Model')}</h2><p className="rt-model">{routine.model || tr('Pi 默认模型', 'Pi default model')}</p></section>
    </div><div className="rt-instructions-history"><section><h2>{tr('指令', 'Instructions')}</h2><p id="routine-instruction-text" className="rt-instruction-text">{expanded || !longInstructions ? routine.prompt : `${routine.prompt.slice(0, 240)}…`}</p>{longInstructions && <button className="rt-show-all" aria-expanded={expanded} aria-controls="routine-instruction-text" onClick={() => setExpanded(!expanded)}>{expanded ? tr('收起', 'Show less') : tr('显示全部', 'Show all')}<ChevronDown size={16} /></button>}</section>
      <section className="rt-history"><h2><History size={17} />{tr('历史记录', 'History')}</h2>{runs.length ? <RunRows runs={runs} tr={tr} onSelect={goToRun} /> : <p className="rt-help">{tr('还没有运行记录。可先点击「立即运行」验证配置。', 'No runs yet. Try Run now to verify the configuration.')}</p>}</section>
    </div></div>}
  </section>
}
