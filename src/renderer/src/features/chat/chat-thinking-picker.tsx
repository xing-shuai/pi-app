import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from '@renderer/components/icons'
import type { ChatThinkingLevel } from '@shared/chat-types'
import { placeChatModelPicker } from './chat-model-picker'
import './chat-thinking-picker.css'

const labels: Record<ChatThinkingLevel, [string, string]> = {
  off: ['关闭', 'Off'], minimal: ['最低', 'Minimal'], low: ['低', 'Low'],
  medium: ['中', 'Medium'], high: ['高', 'High'], xhigh: ['超高', 'Extra high'], max: ['最高', 'Max'],
}

/** Model capabilities come only from Chat metadata, never the Code model store. */
export function ChatThinkingPicker({ value, requested, levels, provider, disabled = false, busy = false, zh = false, onChange }: {
  value: ChatThinkingLevel
  requested?: ChatThinkingLevel
  levels?: ChatThinkingLevel[]
  provider?: string
  disabled?: boolean
  busy?: boolean
  zh?: boolean
  onChange: (level: ChatThinkingLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [placement, setPlacement] = useState<ReturnType<typeof placeChatModelPicker> | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const label = zh ? 'Chat 思考强度' : 'Chat thinking intensity'
  const text = (level: ChatThinkingLevel) => labels[level][zh ? 0 : 1]
  const unavailable = !levels?.length
  const locked = disabled || busy || unavailable
  const reason = busy ? (zh ? '回复期间不能更改思考强度。' : 'Thinking cannot change while a response is running.')
    : unavailable ? (zh ? '加载对话和模型能力后可设置思考强度。' : 'Load the conversation and model capabilities to configure thinking.')
      : disabled ? (zh ? '仅可更改空闲对话的思考强度。' : 'Thinking can change only for idle conversations.')
        : levels.length === 1 && levels[0] === 'off' ? (zh ? '此模型不支持可配置的思考，仅支持关闭。' : 'This model has no configurable reasoning; only Off is supported.')
          : (zh ? '仅列出此模型由 Pi SDK 支持的级别。更高强度可能增加延迟和费用。' : 'Only levels supported by Pi SDK for this model are listed. Higher intensity may increase latency and cost.')
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus() }
  const show = () => { if (!locked) { setActive(Math.max(0, levels!.indexOf(value))); setOpen(true) } }

  useLayoutEffect(() => {
    if (!open || locked) return
    const place = () => {
      if (!trigger.current) return
      const zoom = Number(document.documentElement.style.zoom) || 1
      setPlacement(placeChatModelPicker(trigger.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, zoom))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, locked])
  useEffect(() => { if (locked) setOpen(false) }, [locked])
  const placed = placement !== null
  useEffect(() => {
    if (!open || !placed || locked) return
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false)
    }
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onEscape, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onEscape, true) }
  }, [open, placed, locked])
  useEffect(() => {
    if (open && placed && !locked) {
      const option = popup.current?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)
      option?.focus(); option?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, placed, active, locked])

  const navigate = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || !levels?.length) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setActive((index) => event.key === 'Home' ? 0 : event.key === 'End' ? levels.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + levels.length) % levels.length)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const focusable = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !popup.current?.contains(element))
      const index = focusable.indexOf(trigger.current!)
      close(false)
      focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
    }
  }

  return <>
    <button ref={trigger} type="button" className="chat-model-trigger chat-thinking-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open && !locked} aria-controls={open && !locked ? `${id}-dialog` : undefined} aria-describedby={`${id}-reason`} disabled={locked} title={reason} onClick={() => open ? close() : show()} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() }
    }}><span>{text(value)}</span><ChevronDown size={14} /></button>
    <span className="sr-only" id={`${id}-reason`}>{reason}</span>
    {open && placement && !locked && createPortal(<div ref={popup} id={`${id}-dialog`} role="dialog" aria-label={label} aria-describedby={`${id}-support`} className="chat-model-popover chat-thinking-popover" style={placement} onKeyDown={navigate} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <div className="chat-thinking-heading">{label}{provider && <span>{provider}</span>}</div>
      <div role="listbox" aria-label={label} className="chat-model-list">
        {levels?.map((level, index) => <button key={level} type="button" role="option" aria-selected={value === level} tabIndex={active === index ? 0 : -1} data-index={index} data-active={active === index} className="chat-model-option" onFocus={() => setActive(index)} onClick={() => { onChange(level); close() }}>
          <span className="chat-model-name">{text(level)}</span>{value === level && <Check size={17} aria-hidden="true" />}
        </button>)}
      </div>
      <p className="chat-model-note" id={`${id}-support`}>{reason}
        {requested && requested !== value && <span>{zh ? `已请求 ${text(requested)}；SDK 恢复为 ${text(value)}。` : `Requested ${text(requested)}; SDK restored ${text(value)}.`}</span>}
        {levels && !levels.includes(value) && <span>{zh ? '当前级别不受此模型支持，请选择一个受支持的级别。' : 'The current level is unsupported by this model. Choose a supported level.'}</span>}
      </p>
    </div>, document.body)}
  </>
}
