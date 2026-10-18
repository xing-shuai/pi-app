import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from '@renderer/components/icons'

export function CodeLocationModal({ title, children, footer, onClose, className = '', initialFocus = 'input' }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; className?: string; initialFocus?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    const selector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'
    ;(root.current?.querySelector(initialFocus) as HTMLElement | null)?.focus()
    const key = (event: KeyboardEvent) => {
      const modals = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter((node) => node.getClientRects().length > 0)
      if (modals.at(-1) !== root.current) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = [...(root.current?.querySelectorAll<HTMLElement>(selector) || [])].filter((node) => node.getClientRects().length > 0)
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); prior?.focus() }
  }, [initialFocus])
  return <div className="code-location-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div ref={root} className={`code-location-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><button type="button" aria-label={`Close ${title}`} onClick={onClose}><X size={20} /></button></header><div className="code-location-dialog-body">{children}</div>{footer && <footer>{footer}</footer>}</div></div>
}
