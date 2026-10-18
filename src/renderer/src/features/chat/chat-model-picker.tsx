import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from '@renderer/components/icons'
import type { ChatModelInfo } from '@shared/chat-types'

export type ChatModel = ChatModelInfo
const modelKey = (model: ChatModel) => `${model.provider}/${model.id}`

/** DOM rects are visual pixels; fixed coordinates under CSS zoom are not. */
export function placeChatModelPicker(anchor: Pick<DOMRect, 'right' | 'top'>, viewport: { width: number; height: number }, zoom = 1) {
  const edge = 8
  const width = Math.min(340, Math.max(0, (viewport.width - edge * 2) / zoom))
  return {
    width,
    left: Math.max(edge, Math.min(anchor.right - width * zoom, viewport.width - edge - width * zoom)) / zoom,
    bottom: (viewport.height - anchor.top + 8) / zoom,
    maxHeight: Math.min(360, Math.max(0, anchor.top - 16) / zoom),
  }
}

export function ChatModelPicker({ models, value, onChange, zh = false }: {
  models: ChatModel[]
  value: string
  onChange: (model: string) => void
  zh?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [placement, setPlacement] = useState<ReturnType<typeof placeChatModelPicker> | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const label = zh ? '新对话模型' : 'New chat model'
  const unavailable = zh ? '没有可用模型。请先配置本机 Pi 的模型与登录。' : 'No models available. Configure host Pi models and sign-in first.'
  const selected = models.find((model) => modelKey(model) === value)
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const grouped = new Map<string, ChatModel[]>()
    for (const model of models) {
      if (!`${model.name} ${model.provider}/${model.id}`.toLowerCase().includes(needle)) continue
      grouped.set(model.provider, [...(grouped.get(model.provider) || []), model])
    }
    return [...grouped].sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, rows]) => ({ provider, rows: rows.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [models, query])
  const rows = groups.flatMap((group) => group.rows)
  const close = (restore = true) => {
    setOpen(false)
    if (restore) trigger.current?.focus()
  }
  const show = () => {
    setQuery('')
    const ordered = [...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
    setActive(Math.max(0, ordered.findIndex((model) => modelKey(model) === value)))
    setOpen(true)
  }
  const choose = (model: ChatModel) => { onChange(modelKey(model)); close() }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!trigger.current) return
      const zoom = Number(document.documentElement.style.zoom) || 1
      setPlacement(placeChatModelPicker(trigger.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, zoom))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  const placed = placement !== null
  useEffect(() => {
    if (!open || !placed) return
    search.current?.focus()
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || popup.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      setOpen(false)
    }
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      setOpen(false); trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onEscape, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onEscape, true) }
  }, [open, placed])
  useEffect(() => {
    if (open) popup.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active, query])

  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!rows.length) return
      setActive((index) => event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (rows[active]) choose(rows[active])
    } else if (event.key === 'Tab') {
      // The portal is last in DOM order. Continue from the chip, not from the portal.
      event.preventDefault()
      const focusable = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !popup.current?.contains(element))
      const index = focusable.indexOf(trigger.current!)
      const next = focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]
      close(false)
      next?.focus()
    }
  }
  let cursor = 0
  return <>
    <button ref={trigger} type="button" className="chat-model-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-dialog` : undefined} disabled={!models.length} aria-describedby={!models.length ? `${id}-unavailable` : undefined} title={!models.length ? unavailable : zh ? '仅用于新对话' : 'Used for new chats only'} onClick={() => open ? close() : show()} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show() }
    }}><span>{selected?.name || (models.length ? (zh ? '选择模型' : 'Choose model') : (zh ? '没有可用模型' : 'No models available'))}</span><ChevronDown size={14} /></button>
    {!models.length && <span className="sr-only" id={`${id}-unavailable`}>{unavailable}</span>}
    {open && placement && createPortal(<div ref={popup} id={`${id}-dialog`} role="dialog" aria-label={label} className="chat-model-popover" style={placement} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <label className="chat-model-search"><Search size={17} /><input ref={search} role="combobox" aria-label={zh ? '搜索模型' : 'Search models'} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={rows[active] ? `${id}-option-${active}` : undefined} placeholder={zh ? '搜索模型…' : 'Search models…'} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={navigate} /></label>
      <div id={`${id}-list`} role="listbox" aria-label={zh ? '可用模型' : 'Available models'} className="chat-model-list">
        {groups.map(({ provider, rows: providerModels }, groupIndex) => <div role="group" aria-labelledby={`${id}-provider-${groupIndex}`} key={provider}>
          <div className="chat-model-provider" id={`${id}-provider-${groupIndex}`}>{provider}</div>
          {providerModels.map((model) => {
            const index = cursor++
            const key = modelKey(model)
            return <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} key={key} aria-selected={value === key} data-active={active === index} title={key} className="chat-model-option" onPointerMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(model)}>
              <span><span className="chat-model-name">{model.name}</span>{model.name !== model.id && <span className="chat-model-id">{model.id}</span>}</span>{value === key && <Check size={17} aria-hidden="true" />}
            </button>
          })}
        </div>)}
      </div>
      {!rows.length && <p className="chat-model-empty" role="status">{zh ? '没有匹配的模型' : 'No matching models'}</p>}
      <p className="chat-model-note">{zh ? '模型选择仅应用于新对话。' : 'Model selection applies to new chats only.'}</p>
    </div>, document.body)}
  </>
}
