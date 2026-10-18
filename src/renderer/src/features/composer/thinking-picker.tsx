// Effort uses runtime-supported levels only. Drag previews commit once, on release.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useUIStore } from '@renderer/stores/ui-store'
import { refreshComposerRunDisplay } from '@renderer/lib/composer-run-display'
import { Switch } from '@renderer/components/ui/switch'
import { ComposerPopover } from './composer-popover'
import { formatThinkingChip, normalizeThinkingLevel } from '@renderer/lib/format-run-display'
import {
  boundThinkingLevelFor,
  loadModelThinkingBindings,
  setModelThinkingBinding,
  subscribeModelThinkingBindings,
} from '@renderer/lib/model-thinking-bindings'
import { THINKING_LEVELS, applyThinkingLevel } from './thinking-level-actions'
import { nearestUsableStop, stepUsableStop } from './thinking-slider-math'
import '../../styles/reference-model-effort.css'

export { THINKING_LEVELS }

export function ThinkingPicker() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.thinkingPickerOpen)
  const setOpen = useUIStore((s) => s.setThinkingPickerOpen)
  const current = normalizeThinkingLevel(useUIStore((s) => s.runState.thinkingLevel)) ?? ''
  const available = useUIStore((s) => s.runState.availableThinkingLevels)
  const model = useUIStore((s) => s.runState.model) || ''
  const [bound, setBound] = useState(() => boundThinkingLevelFor(model))
  const [bindBusy, setBindBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const committing = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const dragging = useRef(false)
  const dragModel = useRef(model)
  const sessionFile = useUIStore((s) => s.historySessionFile)
  const dragSession = useRef(sessionFile)
  const supported = (level: string) => !!available?.includes(level)
  const usable = THINKING_LEVELS.map((level) => supported(level))
  const locked = busy || !usable.some(Boolean)
  const shown = preview ?? current
  const shownIndex = Math.max(0, THINKING_LEVELS.indexOf(shown as (typeof THINKING_LEVELS)[number]))
  const pct = (i: number) => `${i / (THINKING_LEVELS.length - 1) * 100}%`
  const close = () => { setOpen(false); document.querySelector<HTMLElement>('[data-composer-thinking-chip]')?.focus() }
  const cancel = () => { dragging.current = false; previewRef.current = null; setPreview(null) }

  useEffect(() => {
    if (!open) return
    setBound(boundThinkingLevelFor(model))
    void loadModelThinkingBindings(true).then(() => setBound(boundThinkingLevelFor(model))).catch(() => {})
    return subscribeModelThinkingBindings(() => setBound(boundThinkingLevelFor(model)))
  }, [open, model])
  useEffect(() => {
    if (!open) return
    if (!sessionFile && useUIStore.getState().currentWorkspace?.startsWith('/__pi_ssh__/')) void refreshComposerRunDisplay().catch(() => {})
    const frame = requestAnimationFrame(() => sliderRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, sessionFile])
  useEffect(() => { cancel() }, [open, model, sessionFile, available])

  const commit = (level: string) => {
    cancel()
    if (committing.current || level === current || !supported(level)) return
    committing.current = true
    setBusy(true)
    // The action commits Pi's effective accepted level with same-view/generation guards.
    void applyThinkingLevel(level).finally(() => { committing.current = false; setBusy(false) })
  }
  const levelAt = (clientX: number): string | null => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect?.width) return null
    const index = nearestUsableStop((clientX - rect.left) / rect.width, THINKING_LEVELS.length, usable)
    return index < 0 ? null : THINKING_LEVELS[index]
  }
  const updatePreview = (clientX: number) => {
    const level = levelAt(clientX)
    if (level) { previewRef.current = level; setPreview(level) }
  }
  const onSliderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    const index = THINKING_LEVELS.indexOf(current as (typeof THINKING_LEVELS)[number])
    let next = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = stepUsableStop(index, 1, usable)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = stepUsableStop(index, -1, usable)
    else if (event.key === 'Home') next = usable.indexOf(true)
    else if (event.key === 'End') next = usable.lastIndexOf(true)
    else if (event.key === 'Enter') { event.preventDefault(); close(); return }
    else return
    event.preventDefault()
    if (!locked && next >= 0) commit(THINKING_LEVELS[next])
  }
  const toggleBinding = async (next: boolean) => {
    if (!model || !current || bindBusy || busy) return
    setBindBusy(true)
    try {
      await setModelThinkingBinding(model, next ? current : null)
      setBound(next ? current : undefined)
      toast.success(next ? t('composer:thinkingPicker.boundToast', { model, level: formatThinkingChip(current) }) : t('composer:thinkingPicker.unboundToast', { model }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally { setBindBusy(false) }
  }

  if (!open) return null
  return <ComposerPopover anchorSelector="[data-composer-thinking-chip]" width={264} label="Effort" onClose={close} className="thinking-picker reference-effort-menu">
    <div className="reference-effort-body">
      <div className="reference-effort-header"><span>Effort</span><span>{shown ? formatThinkingChip(shown) : 'Unknown'}</span></div>
      <div className="reference-effort-labels"><span>Faster</span><span>Smarter</span></div>
      <div ref={sliderRef} role="slider" tabIndex={0} aria-label="Effort" aria-valuemin={0} aria-valuemax={THINKING_LEVELS.length - 1} aria-valuenow={shownIndex} aria-valuetext={shown ? formatThinkingChip(shown) : 'Unknown'} aria-disabled={locked} aria-busy={busy} onKeyDown={onSliderKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0 || locked || committing.current) return
          sliderRef.current?.focus()
          dragging.current = true
          dragModel.current = model
          dragSession.current = sessionFile
          event.currentTarget.setPointerCapture(event.pointerId)
          updatePreview(event.clientX)
        }}
        onPointerMove={(event) => { if (dragging.current && !locked) updatePreview(event.clientX) }}
        onPointerUp={(event) => {
          if (!dragging.current) return
          if (dragModel.current !== model || dragSession.current !== sessionFile || locked) { cancel(); return }
          const level = previewRef.current ?? current
          commit(level)
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={cancel} onLostPointerCapture={cancel} className="thinking-slider">
        <div ref={trackRef} className="reference-effort-track">
          {THINKING_LEVELS.map((level, index) => <span key={level} className="reference-effort-tick" data-supported={usable[index]} data-app-tooltip={`${formatThinkingChip(level)}${usable[index] ? '' : ' — unavailable'}`} style={{ left: pct(index) }} />)}
          <span className="thinking-slider-thumb" style={{ left: pct(shownIndex) }} />
        </div>
      </div>
      <p className="reference-effort-description">{!available?.length ? 'Model thinking capabilities have not loaded.' : !supported(shown) ? t('composer:thinkingPicker.unsupported') : t(`composer:thinkingPicker.desc.${shown}`)}</p>
    </div>
    <div className="reference-effort-binding" data-app-tooltip={model ? t('composer:thinkingPicker.bindHint', { model }) : t('composer:thinkingPicker.bindNoModel')}>
      <span>{t('composer:thinkingPicker.bindLabel')}</span>
      <Switch checked={!!bound} disabled={!model || !supported(current) || bindBusy || busy} aria-label={t('composer:thinkingPicker.bindLabel')} onCheckedChange={(next) => void toggleBinding(next)} className="origin-right scale-75" />
    </div>
  </ComposerPopover>
}
