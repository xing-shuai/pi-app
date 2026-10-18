import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { AppEvent } from '@shared/app-events'
import { extractTextFromPiMessage, extractThinkingFromPiMessage, piUsageTotals } from '@shared/worker-message'

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
/** Map structured path-bearing fields, including outside-root paths, to remote-only namespaces. */
export function isolatePaths(value: unknown, nativeRoot: string, virtualRoot: string, key = ''): unknown {
  if (typeof value === 'string') {
    if (/(?:path|paths|directory|directories)$/i.test(key) || /^(file|files|sessionFile|cwd|root|workspaceRoot|projectRoot|repoRoot)$/i.test(key)) {
      const abs = posix.resolve(nativeRoot, value)
      const rel = posix.relative(nativeRoot, abs)
      return rel !== '..' && !rel.startsWith('../') ? `${virtualRoot}/${rel}` : `${virtualRoot}/.outside/${encodeURIComponent(abs)}`
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => isolatePaths(v, nativeRoot, virtualRoot, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isolatePaths(v, nativeRoot, virtualRoot, k)]))
  return value
}

export class RemoteProjection {
  private seq = 0
  private runId?: string
  private turnId?: string
  private started = 0
  private outcome: 'success' | 'error' | 'aborted' = 'success'
  private lastText = ''
  private thinkingText = ''
  private requestedAbort = false
  private toolInputs = new Map<string, Record<string, unknown>>()
  active = false
  constructor(private identity: () => { workspaceId: string; sessionId: string; sessionFile: string }, private emit: (event: AppEvent) => void) {}
  private send(event: Record<string, unknown>): void {
    this.emit({ ...this.identity(), seq: ++this.seq, runId: this.runId, turnId: this.turnId, timestamp: Date.now(), ...event } as AppEvent)
  }
  cancelRequested(): void { this.requestedAbort = true; this.outcome = 'aborted' }
  state(model?: string, thinkingLevel?: string, details: Record<string, unknown> = {}): void { this.send({ type: 'run', phase: 'state', model, thinkingLevel, ...details }) }
  accept(e: Record<string, unknown>): void {
    const type = e.type
    if (type === 'agent_start') {
      if (!this.active) { this.runId = randomUUID(); this.started = Date.now(); this.outcome = 'success'; this.requestedAbort = false; this.lastText = '' }
      this.active = true
      this.send({ type: 'run', phase: 'started' })
    } else if (type === 'turn_start') { this.turnId = randomUUID() }
    else if (type === 'turn_end') {
      const totals = piUsageTotals(record(e.message).usage as Parameters<typeof piUsageTotals>[0])
      if (totals) this.send({ type: 'run', phase: 'running', usage: totals })
    } else if (type === 'agent_settled') {
      const wasActive = this.active
      this.active = false
      this.toolInputs.clear()
      this.send({ type: 'run', phase: this.outcome === 'error' ? 'failed' : this.outcome === 'aborted' ? 'cancelled' : 'idle', settled: true })
      if (wasActive) this.send({ type: 'completion', outcome: this.outcome === 'error' ? 'failed' : this.outcome === 'aborted' ? 'cancelled' : 'success', settled: true, responsePreview: this.lastText.slice(0, 300), durationMs: Date.now() - this.started })
    } else if (type === 'message_start' || type === 'message_end') {
      const m = record(e.message)
      if (!['assistant', 'user', 'system'].includes(String(m.role))) return
      const text = extractTextFromPiMessage(m)
      const thinking = extractThinkingFromPiMessage(m)
      if (type === 'message_end' && m.role === 'assistant') {
        this.lastText = text
        if (!this.requestedAbort && m.stopReason !== 'error' && m.stopReason !== 'aborted') this.outcome = 'success'
        if (m.stopReason === 'error' || m.stopReason === 'aborted') {
          this.outcome = m.stopReason === 'aborted' ? 'aborted' : 'error'
          this.send({ type: 'agent_error', text: String(m.errorMessage || m.stopReason), kind: this.outcome === 'aborted' ? 'aborted' : 'error', stopReason: m.stopReason })
        }
      }
      if (type === 'message_start') this.thinkingText = ''
      if (type === 'message_end' && m.role === 'assistant' && thinking.startsWith(this.thinkingText)) {
        const suffix = thinking.slice(this.thinkingText.length)
        if (suffix) this.send({ type: 'message', role: 'assistant', phase: 'delta', contentKind: 'thinking', text: suffix })
      }
      this.send({ type: 'message', role: m.role, phase: type === 'message_start' ? 'start' : 'end', contentKind: 'text', text: m.role === 'user' && type === 'message_end' ? undefined : text })
    } else if (type === 'message_update') {
      const update = record(e.assistantMessageEvent)
      const totals = piUsageTotals(e.usage as Parameters<typeof piUsageTotals>[0])
      if (totals) this.send({ type: 'run', phase: 'running', usage: totals })
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        if (update.type === 'thinking_delta') this.thinkingText += String(update.delta || '')
        this.send({ type: 'message', role: 'assistant', phase: 'delta', contentKind: update.type === 'text_delta' ? 'text' : 'thinking', text: String(update.delta || '') })
      }
    } else if (String(type).startsWith('tool_execution_')) {
      const phase = type === 'tool_execution_start' ? 'start' : type === 'tool_execution_update' ? 'update' : 'end'
      const result = record(e.result ?? e.partialResult)
      const id = String(e.toolCallId || '')
      if (phase === 'start' && this.toolInputs.size < 1024) this.toolInputs.set(id, record(e.args))
      this.send({ type: 'tool', phase, toolCallId: id, toolName: String(e.toolName || 'tool'), input: e.args, output: phase === 'start' ? undefined : result, details: result.details, isError: e.isError })
      if (phase === 'end') {
        const args = this.toolInputs.get(id); this.toolInputs.delete(id)
        if (!e.isError && (e.toolName === 'write' || e.toolName === 'edit') && typeof args?.path === 'string') this.send({ type: 'file', source: e.toolName, path: args.path, changeType: e.toolName === 'write' ? 'added' : 'modified' })
      }
    } else if (type === 'thinking_level_changed') this.send({ type: 'run', phase: 'state', thinkingLevel: e.level })
    else if (type === 'queue_update') this.send({ type: 'queue', steering: e.steering || [], followUp: e.followUp || [] })
    else if (type === 'compaction_start' || type === 'compaction_end') {
      const result = record(e.result)
      this.send({ type: 'compaction', phase: type === 'compaction_start' ? 'start' : 'end', tokensBefore: result.tokensBefore, tokensSaved: typeof result.tokensBefore === 'number' && typeof result.estimatedTokensAfter === 'number' ? Math.max(0, result.tokensBefore - result.estimatedTokensAfter) : undefined, summary: result.summary })
      if (e.errorMessage) { this.outcome = 'error'; this.send({ type: 'agent_error', text: String(e.errorMessage), kind: 'error' }) }
    } else if (type === 'extension_error' || (type === 'auto_retry_end' && e.success === false)) {
      this.outcome = 'error'
      this.send({ type: 'agent_error', text: String(e.error || e.finalError || 'Remote agent failed'), kind: 'error' })
    }
    // agent_end deliberately does not mark idle/completed: retries and queues can follow.
  }
  exited(pendingWork = false): void {
    this.toolInputs.clear()
    if (this.active || pendingWork) { this.active = false; this.send({ type: 'run', phase: 'failed' }); this.send({ type: 'agent_error', text: 'Remote runtime disconnected before settling', kind: 'error' }) }
  }
}
