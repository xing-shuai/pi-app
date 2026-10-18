import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSwapFade } from '@renderer/hooks/use-ui-motion'
import { ArrowUp, Check, ChevronDown, FileText, FileImage as ImagePlus, Mic, Pencil, Plus, Search, Square, Trash2, X } from '@renderer/components/icons'
import type { ChatEvent, ChatMessage, ChatSessionInfo, ChatThinkingLevel } from '@shared/chat-types'
import { RemoteMarkdown } from '@renderer/features/ssh/remote-markdown'
import { ReferenceAsterisk, ReferenceSidebarNavigation, ReferenceSearchTools } from '@renderer/components/app/reference-sidebar'

import { ChatModelPicker, type ChatModel } from './chat-model-picker'
import { ChatThinkingPicker } from './chat-thinking-picker'
import './chat-refinements.css'
type Attachment = { id: string; name: string; text?: string; data?: string; mimeType?: string }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
async function invoke<T>(method: string, request?: unknown): Promise<T> {
  if (!window.piDesktop) throw new Error('Chat requires the desktop app')
  return window.piDesktop.invoke(`ipc:chat.${method}`, request ?? {}) as Promise<T>
}
function applyChatEvent(current: ChatMessage[], event: ChatEvent): ChatMessage[] {
  if (event.kind === 'messages') return event.messages
  if (event.kind !== 'delta') return current
  if (!current.some((m) => m.id === event.messageId)) return [...current, { id: event.messageId, role: 'assistant', text: event.delta, pending: true }]
  return current.map((m) => m.id === event.messageId ? { ...m, text: m.text + event.delta, pending: true } : m)
}

export function ChatPage({ onSettings, onRoutines = onSettings, onCustomize = onSettings, sidebarFooter }: { onSettings: () => void; onRoutines?: () => void; onCustomize?: () => void; sidebarFooter?: ReactNode }) {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const tr = (cn: string, en: string) => zh ? cn : en
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [models, setModels] = useState<ChatModel[]>([])
  const [model, setModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<ChatThinkingLevel>('off')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [alphabetical, setAlphabetical] = useState(false)
  const [selectionHistory, setSelectionHistory] = useState<{ entries: Array<string | null>; index: number }>({ entries: [null], index: 0 })
  const navigation = useRef({ newChat: () => {}, back: () => {}, forward: () => {} })
  const [error, setError] = useState('')
  const [actionCount, setActionCount] = useState(0)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const opening = useRef(new Map<string, { token: number; events: ChatEvent[] }>())
  const selectionToken = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const attaching = useRef(false)
  const bottom = useRef<HTMLDivElement>(null)
  const current = sessions.find((s) => s.id === selected)
  const key = selected || 'new'
  const sessionMotion = useSwapFade<HTMLElement>(key)
  const draft = drafts[key] || ''
  const attached = attachments[key] || []
  const running = current?.status === 'running'
  const pending = actionCount > 0
  const currentMessages = selected ? messages[selected] || [] : []

  const upsert = (session: ChatSessionInfo) => setSessions((ss) => {
    const existing = ss.find((s) => s.id === session.id)
    if (existing && existing.updatedAt > session.updatedAt) return ss
    return [...ss.filter((s) => s.id !== session.id), session].sort((a, b) => b.updatedAt - a.updatedAt)
  })
  const run = async (fn: () => Promise<void>) => {
    setActionCount((n) => n + 1); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setActionCount((n) => n - 1) }
  }
  useEffect(() => {
    const off = window.piDesktop?.onChatEvent?.((event: ChatEvent) => {
      if (event.kind === 'session') upsert(event.session)
      if (event.kind === 'error') {
        setError(event.error)
        if (['CHAT_PERSIST_FAILED', 'CHAT_TURN_FAILED'].includes(event.error)) {
          setSessions((ss) => ss.map((s) => s.id === event.id ? { ...s, status: 'failed', error: event.error } : s))
          setMessages((all) => ({ ...all, [event.id]: (all[event.id] || []).map((m) => ({ ...m, pending: false })) }))
        }
      }
      if (event.kind === 'deleted') {
        setSessions((ss) => ss.filter((s) => s.id !== event.id))
        setMessages((all) => { const next = { ...all }; delete next[event.id]; return next })
        ++selectionToken.current
        opening.current.delete(event.id)
        setSelected((id) => id === event.id ? null : id)
        setSelectionHistory((old) => ({ ...old, entries: old.entries.map((id) => id === event.id ? null : id) }))
      }
      if (event.kind === 'delta' || event.kind === 'messages') {
        opening.current.get(event.id)?.events.push(event)
        setMessages((all) => ({ ...all, [event.id]: applyChatEvent(all[event.id] || [], event) }))
      }
    })
    let live = true
    void invoke<{ sessions: ChatSessionInfo[] }>('list').then((r) => { if (live) setSessions((old) => {
      const merged = new Map(r.sessions.map((s) => [s.id, s]))
      for (const s of old) if (!merged.has(s.id) || merged.get(s.id)!.updatedAt <= s.updatedAt) merged.set(s.id, s)
      return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    }) }).catch((e) => { if (live) setError(String(e)) })
    void invoke<{ models: ChatModel[] }>('models').then((r) => { if (live) { setModels(r.models); setModel(r.models[0] ? `${r.models[0].provider}/${r.models[0].id}` : ''); if (!r.models.length) setError(zh ? '未检测到可用模型，请先配置本机 Pi 的模型与登录。' : 'No available model. Configure host Pi models and sign-in first.') } }).catch((e) => { if (live) setError(String(e)) })
    return () => { live = false; off?.() }
  }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [selected, currentMessages.length, currentMessages.at(-1)?.text])

  const rememberSelection = (id: string | null) => setSelectionHistory((old) => {
    if (old.entries[old.index] === id) return old
    const entries = [...old.entries.slice(0, old.index + 1), id].slice(-100)
    return { entries, index: entries.length - 1 }
  })
  const newChat = (remember = true) => { ++selectionToken.current; setSelected(null); setError(''); if (remember) rememberSelection(null) }
  const open = (id: string, remember = true) => {
    if (remember) rememberSelection(id)
    const token = ++selectionToken.current
    const buffer = { token, events: [] as ChatEvent[] }
    opening.current.set(id, buffer)
    setSelected(id)
    void run(async () => {
      try {
        const result = await invoke<{ session: ChatSessionInfo; messages: ChatMessage[]; revision?: number }>('open', { id })
        if (token !== selectionToken.current) return
        upsert(result.session)
        setMessages((all) => {
          if (result.revision !== undefined) {
            const later = buffer.events.filter((event) => (event.kind === 'messages' || event.kind === 'delta') && (event.revision ?? 0) > result.revision!)
            return { ...all, [id]: later.reduce(applyChatEvent, result.messages) }
          }
          // Compatibility with older snapshots: retain prior history and prefer live IDs.
          const live = all[id] || []
          if (!buffer.events.length) return { ...all, [id]: result.messages }
          const byId = new Map(live.map((m) => [m.id, m]))
          const merged = result.messages.filter((m) => !m.pending || byId.has(m.id)).map((m) => byId.get(m.id) || m)
          const seen = new Set(merged.map((m) => m.id))
          return { ...all, [id]: [...merged, ...live.filter((m) => !seen.has(m.id))] }
        })
      } finally { if (opening.current.get(id) === buffer) opening.current.delete(id) }
    })
  }
  const attach = async (files: File[]) => {
    if (pending || attaching.current) return
    attaching.current = true
    const target = key
    try { await run(async () => {
      if (attached.length + files.length > 4) throw new Error(tr('最多添加 4 个附件', 'Maximum 4 attachments'))
      const next: Attachment[] = []
      for (const file of files) {
        if (IMAGE_TYPES.has(file.type)) {
          if (file.size > 4 * 1024 * 1024) throw new Error(tr('单张图片不能超过 4 MiB', 'Images must be ≤4 MiB each'))
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Cannot read attachment')); reader.readAsDataURL(file) })
          next.push({ id: crypto.randomUUID(), name: file.name, data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: file.type })
        } else {
          if (!/\.(txt|md|mdx|json|csv|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|log|sh|sql|rs|go|java|c|cpp|h)$/i.test(file.name) || file.size > 256 * 1024) throw new Error(tr('当前支持图片和 ≤256 KiB 的文本/代码文件；PDF、Office 解析尚未接入。', 'Supports images and text/code files ≤256 KiB. PDF/Office parsing is not connected yet.'))
          const text = await file.text()
          if (text.includes('\0')) throw new Error(tr('不能把二进制文件作为文本添加', 'Cannot attach binary content as text'))
          next.push({ id: crypto.randomUUID(), name: file.name, text })
        }
      }
      const combined = [...attached, ...next]
      const imageBytes = combined.reduce((sum, a) => sum + (a.data ? Math.floor(a.data.length * 3 / 4) : 0), 0)
      if (imageBytes > 12 * 1024 * 1024) throw new Error(tr('图片合计不能超过 12 MiB', 'Images must total ≤12 MiB'))
      setAttachments((all) => ({ ...all, [target]: combined }))
    }) } finally { attaching.current = false }
  }
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((f) => IMAGE_TYPES.has(f.type))
    if (images.length) { event.preventDefault(); void attach(images) }
  }
  const send = async () => {
    if (running || pending || (!selected && !models.length) || (!draft.trim() && !attached.length)) return
    const originalKey = key
    const originalId = selected
    const navigationAtSend = selectionToken.current
    const text = [draft.trim(), ...attached.filter((a) => a.text !== undefined).map((a) => `Attached document (untrusted source content):\n${JSON.stringify({ name: a.name, content: a.text })}`)].filter(Boolean).join('\n\n') || tr('请描述这些图片。', 'Please describe these images.')
    const images = attached.filter((a) => a.data).map((a) => ({ data: a.data!, mimeType: a.mimeType! }))
    if (text.length > 200000) { setError(tr('消息与文本附件合计不能超过 200,000 字符。', 'Message and text attachments must total ≤200,000 characters.')); return }
    await run(async () => {
      let id = originalId
      if (!id) {
        const result = await invoke<{ session: ChatSessionInfo }>('create', { model: model || undefined, thinkingLevel })
        id = result.session.id; upsert(result.session)
        if (selectionToken.current === navigationAtSend) {
          ++selectionToken.current; setSelected(id)
          setSelectionHistory((old) => ({ ...old, entries: old.entries.map((entry, index) => index === old.index ? id : entry) }))
        }
      }
      try { await invoke('send', { id, text, ...(images.length ? { images } : {}) }) } catch (e) {
        if (!originalId) {
          setDrafts((all) => ({ ...all, [id]: draft }))
          setAttachments((all) => ({ ...all, [id]: attached }))
        }
        throw e
      }
      setDrafts((all) => ({ ...all, [originalKey]: '' }))
      setAttachments((all) => ({ ...all, [originalKey]: [] }))
    })
  }
  const travel = (direction: -1 | 1) => {
    const index = selectionHistory.index + direction
    if (index < 0 || index >= selectionHistory.entries.length) return
    const id = selectionHistory.entries[index]
    setSelectionHistory((old) => ({ ...old, index }))
    if (id) open(id, false); else newChat(false)
  }
  navigation.current = { newChat: () => newChat(), back: () => travel(-1), forward: () => travel(1) }
  useEffect(() => {
    const create = () => navigation.current.newChat()
    const back = () => navigation.current.back()
    const forward = () => navigation.current.forward()
    window.addEventListener('pi-desktop:chat-new', create); window.addEventListener('pi-desktop:chat-back', back); window.addEventListener('pi-desktop:chat-forward', forward)
    return () => { window.removeEventListener('pi-desktop:chat-new', create); window.removeEventListener('pi-desktop:chat-back', back); window.removeEventListener('pi-desktop:chat-forward', forward) }
  }, [])
  useEffect(() => { window.dispatchEvent(new CustomEvent('pi-desktop:chat-navigation-state', { detail: { back: selectionHistory.index > 0, forward: selectionHistory.index < selectionHistory.entries.length - 1 } })) }, [selectionHistory])
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Morning, how are things?' : hour < 18 ? 'Afternoon, how are things?' : 'Evening, how are things?'
  const visibleSessions = sessions.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => alphabetical ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt)
  const selectedModel = models.find((m) => `${m.provider}/${m.id}` === (selected ? current?.model : model))
  const thinkingLevels = selected ? current?.thinkingLevels ?? selectedModel?.thinkingLevels : selectedModel?.thinkingLevels ?? ['off']
  const effectiveThinking = selected ? current?.effectiveThinkingLevel ?? 'off' : thinkingLevel
  const changeModel = (next: string) => {
    setModel(next)
    const levels = models.find((m) => `${m.provider}/${m.id}` === next)?.thinkingLevels ?? ['off']
    if (!levels.includes(thinkingLevel)) setThinkingLevel('off')
  }
  const changeThinking = (level: ChatThinkingLevel) => {
    if (running || pending) return
    if (!selected) { setThinkingLevel(level); return }
    const id = selected
    void run(async () => {
      const result = await invoke<{ session: ChatSessionInfo }>('setThinking', { id, level })
      upsert(result.session)
    })
  }
  return <div className="chat-product reference-chat" data-testid="chat-product">
    <aside className="product-sidebar reference-chat-sidebar">
      <ReferenceSidebarNavigation surface="chat" onNew={() => newChat()} onRoutines={onRoutines} onCustomize={onCustomize} newSelected={!selected} />
      <ReferenceSearchTools onSearch={() => setSearchOpen((value) => !value)} onFilter={() => setAlphabetical((value) => !value)} />
      {searchOpen && <label className="product-search reference-chat-search"><Search size={14} /><input autoFocus aria-label={tr('搜索 Chat 会话', 'Search Chat conversations')} placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} /></label>}
      <nav className="chat-session-list" aria-label="Chat conversations">{visibleSessions.map((s) => <div key={s.id} className={`chat-session-row ${selected === s.id ? 'selected' : ''}`}>
        <button className="chat-session-open" onClick={() => open(s.id)}><span>{s.title || 'New chat'}</span>{s.status === 'running' && <i aria-label="Running" />}</button>
        <button aria-label={tr('重命名', 'Rename')} data-app-tooltip={tr('重命名', 'Rename')} onClick={() => { setRenameId(s.id); setRenameTitle(s.title) }}><Pencil size={12} /></button>
        <button disabled={s.status === 'running'} aria-label={tr('删除对话', 'Delete chat')} data-app-tooltip={tr('删除对话', 'Delete chat')} onClick={() => { if (window.confirm(tr('删除这个 Chat 会话？', 'Delete this Chat conversation?'))) void run(async () => { await invoke('delete', { id: s.id }); setSessions((ss) => ss.filter((v) => v.id !== s.id)); setSelected((id) => id === s.id ? null : id) }) }}><Trash2 size={12} /></button>
      </div>)}</nav>
      {sidebarFooter || <button className="product-settings-link" onClick={onSettings}>Settings</button>}
    </aside>
    <main ref={sessionMotion} className={`chat-main reference-chat-main ${currentMessages.length ? 'has-messages' : 'is-empty'}`}>
      <span className="sr-only">Chat has no filesystem, shell, extension or MCP tools.</span>
      {!!currentMessages.length && <header className="reference-chat-session-header"><button onClick={() => { if (current) { setRenameId(current.id); setRenameTitle(current.title) } }}>{current?.title || 'Chat'}</button>{running && <span role="status">Responding…</span>}</header>}
      {error && <div className="product-error" role="alert">{error.includes('CHAT_') ? `${error} · ${tr('请检查本机 Pi 模型配置、登录状态或图片格式；修改自定义模型配置后需重启应用。', 'Check host Pi model configuration, sign-in and image format. Restart after changing custom model configuration.')}` : error}<button aria-label="Dismiss" data-app-tooltip="Dismiss" onClick={() => setError('')}><X size={14} /></button></div>}
      {current?.status === 'failed' && current.error && <div className="product-error" role="alert">{current.error}</div>}
      <div className="chat-message-scroll">
        {!currentMessages.length && <div className="chat-welcome reference-chat-greeting"><ReferenceAsterisk /><h1>{greeting}</h1></div>}
        {currentMessages.map((m) => <article className={`chat-message ${m.role}`} key={m.id} aria-label={m.role === 'assistant' ? tr('助手回复', 'Assistant response') : tr('你的消息', 'Your message')} aria-busy={m.pending || undefined} data-streaming={m.pending || undefined}>{m.images?.map((image, index) => <img className="chat-message-image" key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={tr('用户提供的图片', 'User supplied image')} />)}<div className="chat-message-prose">{m.role === 'assistant' ? <RemoteMarkdown text={m.text || (m.pending ? '…' : '')} /> : m.text}</div></article>)}<div ref={bottom} />
      </div>
      <div className="chat-composer-dock"><div className="chat-composer">
        {!!attached.length && <div className="chat-attachments">{attached.map((a) => <span key={a.id}>{a.data ? <ImagePlus size={14} /> : <FileText size={14} />}{a.name}<button disabled={pending} aria-label={`Remove ${a.name}`} onClick={() => setAttachments((all) => ({ ...all, [key]: (all[key] || []).filter((v) => v.id !== a.id) }))}><X size={12} /></button></span>)}</div>}
        <textarea disabled={pending} aria-label={tr('Chat 消息', 'Chat message')} placeholder="How can I help you today?" value={draft} onChange={(e) => setDrafts((all) => ({ ...all, [key]: e.target.value }))} onPaste={paste} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <div className="chat-composer-actions"><button disabled={pending || running} aria-label={tr('添加图片或文本文件', 'Attach image or text file')} data-app-tooltip={tr('添加图片或文本文件', 'Attach image or text file')} onClick={() => inputRef.current?.click()}><Plus size={19} /></button><input ref={inputRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.csv,.ts,.tsx,.js,.py,.html,.css,.yaml,.yml,.log,.sql,.sh" onChange={(e) => { void attach(Array.from(e.target.files || [])); e.target.value = '' }} />
          <div className="reference-chat-input-right"><button disabled data-app-tooltip="Voice dictation is not connected for Chat yet" aria-label="Chat voice dictation unavailable"><Mic size={20} /><ChevronDown size={12} /></button>
          {running ? <button className="product-send" aria-label={tr('停止回复', 'Stop response')} data-app-tooltip={tr('停止回复', 'Stop response')} onClick={() => void run(async () => { await invoke('abort', { id: selected }) })}><Square size={16} /></button> : draft.trim() || attached.length ? <button className="product-send" aria-label={tr('发送 Chat 消息', 'Send Chat message')} data-app-tooltip={tr('发送 Chat 消息', 'Send Chat message')} disabled={pending || (!selected && !models.length)} onClick={() => void send()}><ArrowUp size={19} /></button> : <button disabled data-app-tooltip="Voice conversation is not implemented" aria-label="Voice conversation unavailable"><svg width="21" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 9v6m4-10v14m5-17v20m5-16v12m4-9v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>}</div>
        </div>
      </div><div className="reference-chat-composer-meta"><button disabled data-app-tooltip="Chat knowledge projects are not implemented yet">Project or folder<ChevronDown size={12} /></button><div className="reference-chat-model-controls">{!selected ? <ChatModelPicker models={models} value={model} onChange={changeModel} zh={zh} /> : <span className="chat-locked-model" aria-label={tr('此对话的固定模型', 'Locked conversation model')} data-app-tooltip={`${current?.model || ''} · ${tr('已有对话的模型不可更改。新建对话以选择其他模型。', 'Existing conversations keep their model. Start a new chat to choose another.')}`}>{selectedModel?.name || current?.model || tr('正在加载模型…', 'Loading model…')}</span>}<ChatThinkingPicker key={selected || 'new'} value={effectiveThinking} requested={selected ? current?.thinkingLevel : undefined} levels={thinkingLevels} provider={selectedModel?.provider || current?.model?.split('/')[0]} disabled={pending || (!!selected && current?.status !== 'idle') || (!selected && !models.length)} busy={running} zh={zh} onChange={changeThinking} /><span className="reference-chat-policy" data-app-tooltip="Chat has no external tools">Chat</span></div></div></div>
    </main>
    {renameId && <div className="product-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setRenameId(null) }}><form className="product-modal" role="dialog" aria-label={tr('重命名对话', 'Rename conversation')} onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await invoke<{ session: ChatSessionInfo }>('rename', { id: renameId, title: renameTitle }); upsert(r.session); setRenameId(null) }) }}><h2>{tr('重命名对话', 'Rename conversation')}</h2><input aria-label="Chat title" autoFocus value={renameTitle} maxLength={120} onChange={(e) => setRenameTitle(e.target.value)} /><div className="product-modal-actions"><button type="button" onClick={() => setRenameId(null)}>{tr('取消', 'Cancel')}</button><button className="product-primary" disabled={pending || !renameTitle.trim()}><Check size={15} />{tr('保存', 'Save')}</button></div></form></div>}
  </div>
}
