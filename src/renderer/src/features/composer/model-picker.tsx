import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { toast } from 'sonner'
import { userActionToast } from '@renderer/lib/startup-toast-guard'
import { readRecentModels, rememberRecentModel } from '@renderer/lib/recent-models'
import {
  isAvailableModelsPending,
  peekAvailableModels,
  peekAvailableModelsError,
  refreshAvailableModels,
  subscribeAvailableModels,
} from '@renderer/lib/available-models-cache'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { normalizeThinkingLevel } from '@renderer/lib/format-run-display'
import { commitSessionDisplayMeta } from '@renderer/lib/session-display-meta'
import { boundThinkingLevelFor, loadModelThinkingBindings } from '@renderer/lib/model-thinking-bindings'
import { ReferenceModelMenu, type ReferenceModel } from './reference-model-menu'

// Cross-unmount request token: stale selections must never overwrite a newer pick/session.
type PendingModelSwitch = {
  token: number
  sessionFile: string
  requestedModel: string
}
let modelSwitchToken = 0
let pendingModelSwitch: PendingModelSwitch | null = null

export function ModelPicker() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.modelPickerOpen)
  const setOpen = useUIStore((s) => s.setModelPickerOpen)
  const currentModel = useUIStore((s) => s.runState.model)
  const sessionFile = useUIStore((s) => s.historySessionFile)
  const [models, setModels] = useState<ReferenceModel[]>(() => peekAvailableModels())
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>(() => readRecentModels())
  const [loading, setLoading] = useState(() => isAvailableModelsPending())
  const [loadError, setLoadError] = useState(() => peekAvailableModelsError())

  const close = () => {
    setOpen(false)
    document.querySelector<HTMLElement>('[data-composer-model-chip]')?.focus()
  }
  const reload = () => {
    const request = refreshAvailableModels().catch(() => peekAvailableModels())
    setLoading(isAvailableModelsPending())
    return request
  }

  useEffect(
    () => subscribeAvailableModels((next) => {
      setModels(next)
      setLoadError(peekAvailableModelsError())
      setLoading(isAvailableModelsPending())
    }),
    [],
  )

  useEffect(() => {
    if (!open) return
    setModels(peekAvailableModels())
    setLoadError(peekAvailableModelsError())
    setRecents(readRecentModels())
    void loadModelThinkingBindings()
    void reload()
    const unsub = onAppEvent((event) => {
      // Worker binding may replace an earlier empty SDK fallback.
      if (event?.type !== 'run') return
      if (event.phase !== 'state' && event.phase !== 'started') return
      void reload()
    })
    return unsub
  }, [open])

  const pick = async (m: ReferenceModel) => {
    const requestedModel = `${m.provider}/${m.id}`
    const workspaceId = useUIStore.getState().currentWorkspace
    if (!sessionFile && workspaceId?.startsWith('/__pi_ssh__/')) {
      // A remote draft needs its selected model's REAL capabilities, not levels left
      // over from another model/session. Mutate only the hidden workspace probe.
      const token = ++modelSwitchToken
      pendingModelSwitch = null
      let leftView = false
      const unsubscribe = useUIStore.subscribe((state) => { if (state.currentWorkspace !== workspaceId || state.historySessionFile) leftView = true })
      const current = () => !leftView && token === modelSwitchToken && useUIStore.getState().currentWorkspace === workspaceId && !useUIStore.getState().historySessionFile
      setPendingModel(requestedModel)
      try {
        const response = await ipcClient.invoke('model.set', { sessionId: '', workspaceId, draft: true, provider: m.provider, modelId: m.id })
        if (!current()) return
        const actualModel = response.modelId
        if (typeof actualModel !== 'string' || !actualModel) throw new Error('Remote model confirmation unavailable')
        const levels = Array.isArray(response.availableThinkingLevels) ? response.availableThinkingLevels.filter((level: unknown): level is string => typeof level === 'string' && !!normalizeThinkingLevel(level)) : undefined
        let thinkingLevel = normalizeThinkingLevel(response.thinkingLevel)
        const bound = boundThinkingLevelFor(actualModel)
        if (bound && levels?.includes(bound) && bound !== thinkingLevel) {
          const accepted = await ipcClient.invoke('thinkingLevel.set', { sessionId: '', workspaceId, draft: true, level: bound })
          if (!current()) return
          thinkingLevel = normalizeThinkingLevel(accepted.level)
        }
        useUIStore.getState().setRunState({ model: actualModel, thinkingLevel, availableThinkingLevels: levels })
        commitSessionDisplayMeta(null, { model: actualModel, thinkingLevel })
        setRecents(rememberRecentModel(actualModel)); close()
      } catch (error) { if (current()) toast.error(error instanceof Error ? error.message : t('composer:switchFailed')) }
      finally { unsubscribe(); if (token === modelSwitchToken) setPendingModel(null) }
      return
    }
    if (!sessionFile) {
      // Native draft: preview the real model binding; apply on session creation.
      const bound = boundThinkingLevelFor(requestedModel)
      useUIStore.getState().setRunState({ model: requestedModel, ...(bound ? { thinkingLevel: bound } : {}) })
      setRecents(rememberRecentModel(requestedModel))
      close()
      return
    }
    const targetFile = sessionFile
    // Keep the confirmed model until runtime confirms. Tokens survive picker unmounts.
    const token = ++modelSwitchToken
    pendingModelSwitch = { token, sessionFile: targetFile, requestedModel }
    setPendingModel(requestedModel)
    try {
      const response = await ipcClient.invoke('model.set', {
        sessionId: '',
        sessionFile: targetFile,
        provider: m.provider,
        modelId: m.id,
      })
      if (token !== modelSwitchToken) return
      const now = useUIStore.getState()
      if (!sessionFilesEqual(now.historySessionFile, targetFile)) return
      const actualModel = response.modelId || requestedModel
      now.setRunState({ model: actualModel })
      commitSessionDisplayMeta(targetFile, { model: actualModel })
      setRecents(rememberRecentModel(actualModel))
      if (pendingModelSwitch?.token === token) pendingModelSwitch = null
      close()
      userActionToast.success(t('composer:switchedModel', { key: actualModel }))
    } catch (e) {
      if (token !== modelSwitchToken) return
      const now = useUIStore.getState()
      if (!sessionFilesEqual(now.historySessionFile, targetFile)) return
      if (pendingModelSwitch?.token === token) pendingModelSwitch = null
      console.error('model.set failed:', e)
      toast.error(e instanceof Error ? e.message : t('composer:switchFailed'))
    } finally {
      if (token === modelSwitchToken) setPendingModel(null)
    }
  }

  if (!open) return null
  return <ReferenceModelMenu models={models} current={currentModel || ''} recents={recents} pending={pendingModel} loading={loading} error={loadError} onRetry={() => void reload()} anchorSelector="[data-composer-model-chip]" label={t('composer:selectModelTitle')} onPick={(model) => void pick(model)} onClose={close} />
}
