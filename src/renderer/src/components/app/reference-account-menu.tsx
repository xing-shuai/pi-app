import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowRight, BookOpen, ChevronRight, ExternalLink, Globe, History, KeyRound, MessageCircleQuestion, Settings } from '@renderer/components/icons'
import { ipcClient } from '@renderer/lib/ipc-client'

export interface ReferenceAccountMenuProps {
  name: string
  environmentLabel?: string
  onSettings: () => void
  onUsage?: () => void
  onLanguage?: (language: 'en' | 'zh') => void
  onModels?: () => void
  onQuit?: () => void
  onClose: () => void
}

/** Portaled menus have role=menu so native browser views yield to the existing overlay observer. */
export function ReferenceAccountMenu({ name, environmentLabel = 'Local', onSettings, onUsage, onLanguage, onModels, onQuit, onClose }: ReferenceAccountMenuProps) {
  const { i18n } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const languageButton = useRef<HTMLButtonElement>(null)
  const languageMenu = useRef<HTMLDivElement>(null)
  const [languagesOpen, setLanguagesOpen] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const menu = ref.current
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || menu?.contains(event.target)) return
      // The footer trigger toggles itself; don't close and reopen on the same press.
      if (event.target instanceof Element && event.target.closest('[data-reference-account-trigger]')) return
      closeRef.current()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (languageMenu.current) {
        setLanguagesOpen(false)
        languageButton.current?.focus()
      } else closeRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      if (document.activeElement === document.body || menu?.contains(document.activeElement)) previous?.focus()
    }
  }, [])

  useEffect(() => {
    if (languagesOpen) languageMenu.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [languagesOpen])

  const activate = (action: () => void) => { onClose(); action() }
  const external = (url: string) => activate(() => { void ipcClient.invoke('shell.openExternal', { url }).catch(() => {}) })
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = (event.target as HTMLElement).closest('[role="menu"]')
    const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>(':scope > button[role^="menuitem"]:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    } else if (event.key === 'ArrowRight' && document.activeElement === languageButton.current) {
      event.preventDefault(); setLanguagesOpen(true)
    } else if (event.key === 'ArrowLeft' && languagesOpen) {
      event.preventDefault(); setLanguagesOpen(false); languageButton.current?.focus()
    } else if (event.key === 'Tab') onClose()
  }
  const language = (value: 'en' | 'zh') => activate(() => {
    if (onLanguage) onLanguage(value)
    else void i18n.changeLanguage(value)
  })

  return createPortal(<div ref={ref} className="reference-account-menu" role="menu" aria-label="Account menu" onKeyDown={navigate} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose()
  }}>
    <div className="reference-account-identity"><strong>{name || 'Local user'}</strong><span>Desktop user · {environmentLabel === 'Local' ? 'Execution on this computer' : `Execution: ${environmentLabel}`}. Provider sign-in belongs to the selected execution host.</span></div>
    <div role="separator" />
    <button role="menuitem" tabIndex={-1} onClick={() => activate(onSettings)}><Settings size={17} /><span>Settings</span><kbd>Ctrl+,</kbd></button>
    <button role="menuitem" tabIndex={-1} onClick={() => activate(onUsage ?? (() => window.dispatchEvent(new CustomEvent('pi-desktop:open-usage-settings'))))}><Activity size={17} /><span>Usage</span></button>
    <button ref={languageButton} role="menuitem" tabIndex={-1} aria-haspopup="menu" aria-expanded={languagesOpen} onClick={() => setLanguagesOpen((open) => !open)}><Globe size={17} /><span>Language</span><ChevronRight size={15} /></button>
    {languagesOpen && <div ref={languageMenu} className="reference-account-language" role="menu" aria-label="Language">
      <button role="menuitemradio" tabIndex={-1} aria-checked={i18n.language?.startsWith('en')} onClick={() => language('en')}>English</button>
      <button role="menuitemradio" tabIndex={-1} aria-checked={i18n.language?.startsWith('zh')} onClick={() => language('zh')}>简体中文</button>
    </div>}
    <button role="menuitem" tabIndex={-1} onClick={() => external('https://github.com/justhil/pi-app/blob/main/doc/guide/getting-started.md')}><MessageCircleQuestion size={17} /><span>Get help</span><ExternalLink size={15} /></button>
    <div role="separator" />
    <button role="menuitem" tabIndex={-1} onClick={() => external('https://github.com/justhil/pi-app/releases')}><History size={17} /><span>View changelog</span></button>
    <button role="menuitem" tabIndex={-1} onClick={() => external('https://github.com/justhil/pi-app')}><BookOpen size={17} /><span>Learn more</span><ExternalLink size={15} /></button>
    <div role="separator" />
    <button role="menuitem" tabIndex={-1} disabled={!onModels} title={onModels ? 'Manage provider API keys in Models' : 'Open Settings → Models to manage provider API keys'} onClick={() => onModels && activate(onModels)}><KeyRound size={17} /><span>API keys</span></button>
    <div role="separator" />
    <button role="menuitem" tabIndex={-1} disabled={!onQuit} title={onQuit ? 'Quit the application' : 'App quit is not available from this menu'} onClick={() => onQuit && activate(onQuit)}><ArrowRight size={17} /><span>Quit</span></button>
  </div>, document.body)
}
