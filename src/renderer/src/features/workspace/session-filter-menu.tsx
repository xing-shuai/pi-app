import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from '@renderer/components/icons'

export function SessionFilterMenu({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState({ left: 8, top: 8, maxHeight: 300, width: 240 })
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return
    const rect = trigger.current.getBoundingClientRect(), zoom = Number(document.documentElement.style.zoom) || 1
    const width = Math.min(240, (window.innerWidth - 16) / zoom), height = Math.min(menu.current.scrollHeight || 260, 300)
    const below = window.innerHeight - rect.bottom - 12
    const top = below < Math.min(height * zoom, 150) && rect.top > below ? Math.max(8, rect.top - height * zoom - 4) : rect.bottom + 4
    setPlacement({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - 8 - width * zoom)) / zoom, top: top / zoom, maxHeight: Math.min(300, (window.innerHeight - top - 8) / zoom) })
    menu.current.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const dismiss = () => setOpen(false)
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', pointer, true); window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss); document.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('pointerdown', pointer, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); document.removeEventListener('scroll', scroll, true) }
  }, [open])
  return <><button ref={trigger} type="button" className="session-filter-trigger" aria-label="Filter sessions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}><span>{options.find((option) => option.value === value)?.label || 'All sessions'}</span><ChevronDown size={14} /></button>
    {open && createPortal(<div ref={menu} id={id} className="session-filter-menu" role="menu" aria-label="Session locations" style={{ position: 'fixed', ...placement }} onBlur={(event) => { if (event.relatedTarget && !menu.current?.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) close() }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'Tab') { close(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []), index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }}>{options.map((option) => <button type="button" role="menuitemradio" aria-checked={value === option.value} key={option.value} onClick={() => { onChange(option.value); close(true) }}><span>{option.label}</span>{value === option.value && <Check size={15} aria-hidden />}</button>)}</div>, document.body)}
  </>
}
