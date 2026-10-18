import { toast } from 'sonner'
import i18n from '@renderer/lib/i18n'
import { ipcClient } from '@renderer/lib/ipc-client'
import { commitSessionDisplayMeta } from '@renderer/lib/session-display-meta'
import { formatThinkingChip, normalizeThinkingLevel } from '@renderer/lib/format-run-display'
import { boundThinkingLevelFor, setModelThinkingBinding } from '@renderer/lib/model-thinking-bindings'
import { useUIStore } from '@renderer/stores/ui-store'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Next level the current model supports, wrapping around (pi TUI Shift+Tab). */
export function nextThinkingLevel(current: string | undefined, available: readonly string[] | undefined): string {
  const usable = THINKING_LEVELS.filter((l) => available?.includes(l))
  if (usable.length === 0) return normalizeThinkingLevel(current) ?? 'off'
  const at = usable.indexOf((normalizeThinkingLevel(current) ?? 'off') as (typeof THINKING_LEVELS)[number])
  return usable[(at + 1) % usable.length]
}

let thinkingRequestGeneration = 0
/** Pi may clamp the request. Commit only its effective result, and only to the same view. */
export async function applyThinkingLevel(level: string): Promise<void> {
  const store = useUIStore.getState()
  const model = store.runState.model || ''
  const sessionFile = store.historySessionFile
  const workspaceId = store.currentWorkspace
  const generation = ++thinkingRequestGeneration
  let scopeChanged = false
  const unsubscribe = useUIStore.subscribe((next) => {
    if (next.historySessionFile !== sessionFile || next.currentWorkspace !== workspaceId || (next.runState.model || '') !== model) scopeChanged = true
  })
  const current = () => {
    const latest = useUIStore.getState()
    return !scopeChanged && generation === thinkingRequestGeneration && latest.historySessionFile === sessionFile && latest.currentWorkspace === workspaceId && (latest.runState.model || '') === model
  }
  try {
    const remoteDraft = !sessionFile && workspaceId?.startsWith('/__pi_ssh__/')
    const result = await ipcClient.invoke('thinkingLevel.set', { sessionId: '', sessionFile: sessionFile ?? undefined, ...(remoteDraft ? { workspaceId, draft: true } : {}), level })
    if (!current()) return
    const effective = normalizeThinkingLevel(result.level)
    if (!effective) throw new Error('Effective thinking level unavailable')
    useUIStore.getState().setRunState({ thinkingLevel: effective })
    commitSessionDisplayMeta(sessionFile, { thinkingLevel: effective })
    const bound = boundThinkingLevelFor(model)
    if (bound && model && bound !== effective) void setModelThinkingBinding(model, effective).catch(() => {})
    toast.success(i18n.t('composer:thinkingPicker.switched', { level: formatThinkingChip(effective) }))
  } catch (e) {
    // A draft session has no worker yet; the level is applied when the session starts.
    if (e instanceof Error && e.message.toLowerCase().includes('worker not started')) return
    if (!current()) return
    console.error('thinkingLevel.set failed:', e)
    toast.error(i18n.t('composer:switchThinkingFailed'))
  } finally { unsubscribe() }
}
