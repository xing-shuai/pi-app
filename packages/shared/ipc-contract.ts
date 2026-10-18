// IPC Contract - Complete typed method signatures for Renderer/Main/Worker

import type { AppEvent } from './app-events'
import type { CompatibilityLevel } from './extension-types'
import type { ModelAuthProjection } from './model-auth-projection'
import type { AdapterCatalog } from '../../src/extension-compat/adapter-schema'
import type { SessionContextPreview } from './session-context-preview'
import type { SshCommand, SshFilesResult, SshProfile, SshRecord, SshStatus } from './ssh-workspace'
import type { ChatMessage, ChatSessionInfo, ChatThinkingLevel, ChatModelInfo } from './chat-types'
import type { Routine, RoutineRun } from './routine-types'
import type { EnvironmentList } from './execution-target'
import type { RemoteCodeConnection, RemoteCodeSnapshot, RemoteCodeWorkspace } from './remote-code'
import type { HostDirectory } from './ssh-host-types'
import type { SessionCatalogRequest, SessionCatalogResult } from './session-catalog-types'
import type { ProviderUsageRequest, ProviderUsageSnapshot } from './provider-usage-types'
import type { LocalFolderBrowseRequest, LocalFolderBrowseResult, LocalFolderResolveRequest, LocalFolderResolveResult } from './local-folder-types'

// ── Workspace ──
export interface WorkspaceOpenRequest { path?: string; awaitWorker?: boolean }
export interface WorkspaceEnsureWorkerRequest { path: string }
export interface WorkspaceEnsureWorkerResponse { ok: boolean; workspaceId: string; sessionId?: string; model?: string; error?: string }
export interface WorkspaceOpenResponse { workspaceId: string; path: string; name: string }
export interface WorkspaceSwitchRequest { workspaceId: string }
export interface WorkspaceSwitchResponse { workspaceId: string; path: string; name: string }
export interface WorkspaceFsSearchRequest {
  workspaceRoot: string
  query: string
  maxResults?: number
}
export interface WorkspaceFsSearchEntry {
  path: string
  name: string
  isDirectory: boolean
}
export interface WorkspaceFsSearchResponse {
  ok: boolean
  entries: WorkspaceFsSearchEntry[]
  error?: 'missing_root' | 'outside_workspace' | 'fd_unavailable' | 'search_failed'
}

// ── Session ──
export interface SessionInfo {
  sessionId: string
  parentSessionFile?: string
  workspaceId: string
  title: string
  createdAt: number
  updatedAt: number
  modelId: string
  status: 'idle' | 'busy' | 'error'
}
export interface SessionListRequest { workspaceId?: string }
export interface SessionListResponse { sessions: SessionInfo[] }
export interface SessionOpenRequest { sessionId: string; sessionFile?: string }
export interface SessionOpenResponse { session: SessionInfo }
export interface SessionNewRequest { workspaceId: string; title?: string; modelId?: string }
export interface SessionNewResponse { session: SessionInfo }
export interface SessionForkRequest {
  sessionId?: string
  sessionFile: string
  entryId?: string
  /** @deprecated use entryId */
  fromMessageId?: string
  title?: string
  position?: 'before' | 'at'
  workspaceId?: string
}
export interface SessionForkResponse {
  cancelled?: boolean
  error?: string
  editorText?: string
  sessionId?: string
  sessionFile?: string
  workspaceId?: string
  session: SessionInfo & { sessionFile?: string; error?: string }
}
export interface SessionCloneRequest {
  sessionId?: string
  sessionFile: string
  title?: string
  workspaceId?: string
}
export interface SessionCloneResponse {
  cancelled?: boolean
  error?: string
  sessionId?: string
  sessionFile?: string
  workspaceId?: string
  session: SessionInfo & { sessionFile?: string; error?: string }
}
export interface SessionForkCandidatesRequest { sessionFile: string }
export interface SessionForkCandidatesResponse {
  messages: Array<{ entryId: string; text: string }>
  error?: string
}
export interface SessionRenameRequest { sessionId: string; title: string }
export interface SessionRenameResponse { session: SessionInfo }
export interface SessionCompactRequest {
  sessionId: string
  sessionFile: string
  workspaceId?: string
  customInstructions?: string
}
export interface SessionCompactResponse { sessionId: string; compacted: boolean; tokensSaved: number; error?: string }
export interface SessionExportRequest { sessionId: string; format: 'json' | 'markdown' | 'html' }
export interface SessionExportResponse { content: string; format: string; filename: string }
export interface ContextPreviewRequest { sessionFile: string; workspaceId: string }
export interface ContextPreviewResponse { preview: SessionContextPreview | null }

// ── Prompt ──
export interface PromptSendRequest { sessionId: string; text: string }
export interface PromptSendResponse { messageId: string }
export interface PromptSteerRequest { sessionId: string; text: string }
export interface PromptSteerResponse { steered: boolean }
export interface PromptFollowUpRequest { sessionId: string; text: string }
export interface PromptFollowUpResponse { messageId: string }
export interface PromptAbortRequest { sessionId: string; sessionFile: string }
export interface PromptAbortResponse { aborted: boolean; ignored?: boolean; reason?: string; noWorker?: boolean }

// ── Model ──
export interface ModelInfo {
  id: string
  name: string
  provider: string
  contextWindow: number
  maxOutput: number
  available: boolean
  managedBy?: 'active-sdk'
  auth?: ModelAuthProjection
}
export interface ModelListRequest {
  workspaceId?: string
  /** catalog=active Pi SDK 完整目录（默认模型等）；available=已配置鉴权（Composer）；settings=无网络完整目录及脱敏鉴权状态 */
  scope?: 'catalog' | 'available' | 'settings'
}
export interface ModelListResponse { models: ModelInfo[] }
export interface ModelSetRequest {
  sessionId: string
  sessionFile?: string
  /** Remote draft metadata only; never a history-session binding. */
  workspaceId?: string
  draft?: boolean
  provider?: string
  modelId: string
}
export interface ModelSetResponse { modelId: string; thinkingLevel?: string; availableThinkingLevels?: string[] }
export interface ModelCycleRequest { sessionId: string; direction?: 'next' | 'prev' }
export interface ModelCycleResponse { modelId: string; thinkingLevel: string }

export type PiModelsApiType = string

export interface PiModelsModelConfig {
  id: string
  name?: string
  api?: string
  reasoning?: boolean
  input?: ('text' | 'image')[]
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  baseUrl?: string
  headers?: Record<string, unknown>
  cost?: Record<string, unknown>
  compat?: Record<string, unknown>
  [key: string]: unknown
}

export interface PiModelsProviderConfig {
  name?: string
  baseUrl?: string
  api?: PiModelsApiType
  apiKey?: string
  authHeader?: boolean
  headers?: Record<string, unknown>
  compat?: Record<string, unknown>
  oauth?: string
  models?: PiModelsModelConfig[]
  modelOverrides?: Record<string, unknown>
  [key: string]: unknown
}

export interface PiModelsConfigPayload {
  providers: Record<string, PiModelsProviderConfig>
  [key: string]: unknown
}

export interface PiModelsGetRequest {}
export interface PiModelsGetResponse {
  path: string
  config: PiModelsConfigPayload
  parseError?: string
  schemaError?: string
  warnings?: string[]
}

export interface PiModelsSetRequest { config: PiModelsConfigPayload }
export interface PiModelsSetResponse { ok: boolean; path: string; error?: string }

export interface PiModelsFetchRequest {
  baseUrl: string
  apiKey?: string
  authHeader?: boolean
}
export interface PiModelsFetchResponse {
  ok: boolean
  ids?: string[]
  error?: string
}

// ── ThinkingLevel ──
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface ThinkingLevelSetRequest {
  sessionId: string
  sessionFile?: string
  workspaceId?: string
  /** Exact remote workspace probe, not the last selected history. */
  draft?: boolean
  level: ThinkingLevel
}
export interface ThinkingLevelSetResponse { level: string }

// ── Commands ──
export interface CommandInfo {
  id: string
  name: string
  description: string
  category: 'skill' | 'prompt' | 'extension' | 'builtin'
}
export interface CommandsListRequest { sessionId?: string }
export interface CommandsListResponse { commands: CommandInfo[] }

// ── Review ──
export interface ReviewGetDiffRequest {
  workspaceId?: string
  cwd?: string
  sessionId: string
  scope: 'turn' | 'session' | 'git'
  turnId?: string
}
export interface ReviewGitDiffPayload {
  raw: string
  stagedRaw?: string
  status: string
  scope: string
  branch?: string
  log?: string
  isRepo?: boolean
  message?: string
}
export interface ReviewGetDiffResponse { diff: ReviewGitDiffPayload }

export interface ReviewStageHunksRequest {
  cwd: string
  files: { path: string; hunkPatches: string[] }[]
}
export interface ReviewStageHunksResponse { ok: boolean; error?: string }


// ── Extensions ──
export interface ExtensionInfo {
  id: string
  name: string
  version?: string
  description?: string
  enabled: boolean
  compatibility: CompatibilityLevel
  source: 'global' | 'project' | 'package'
  registeredTools: string[]
  registeredCommands: string[]
  loadError?: string
  capabilitySource?: 'static' | 'runtime'
  runtimeLoaded?: boolean
  piSync?: boolean
  piEnabled?: boolean
  inSettingsPackages?: boolean
  workerLoadHint?: string
}
export interface ExtensionsListRequest { workspaceId?: string }
export interface ExtensionsListResponse { extensions: ExtensionInfo[] }
export interface ExtensionsSetEnabledRequest { extensionId: string; enabled: boolean }
export interface ExtensionsSetEnabledResponse { ok: boolean; extensionId: string; enabled: boolean; error?: string; needsWorkerReload?: boolean }

// ── Registry ──
export interface RegistryRefreshRequest { force?: boolean }
export interface RegistryRefreshResponse { refreshed: boolean; count: number; version?: string }

// ── Settings ──
export interface SettingsGetRequest { key?: string }
export interface SettingsGetResponse { settings: Record<string, unknown> }
export interface SettingsSetRequest { key: string; value: unknown }
export interface SettingsSetResponse { key: string; value: unknown }

// ── App update (GitHub Releases) ──
export interface AppCheckUpdateRequest {}
export type AppCheckUpdateResponse = import('./app-update').AppUpdateCheckResult
export interface AppOpenReleaseRequest { url?: string }
export interface AppOpenReleaseResponse { ok: boolean }
export interface AppGetPendingUpdateRequest {}
export interface AppGetPendingUpdateResponse {
  update: import('./app-update').AppUpdateAvailableInfo | null
}
export interface AppDismissUpdatePromptRequest {}
export interface AppDismissUpdatePromptResponse { ok: boolean }
export interface AppIgnoreUpdateVersionRequest { version: string }
export interface AppIgnoreUpdateVersionResponse { ok: boolean }
export interface AppDownloadUpdateRequest {
  url: string
  fileName?: string
}
export interface AppDownloadUpdateResponse {
  ok: boolean
  path?: string
  error?: string
}

// ── Events ──
export interface EventsSubscribeRequest { channels?: string[] }
export interface EventsSubscribeResponse { subscriptionId: string }

// ── IPC Method Map ──
export interface IpcMethodMap {
  'environment.list': { request: Record<string, never>; response: EnvironmentList }
  'app.quit': { request: Record<string, never>; response: { ok: true } }
  'code.sessions.list': { request: SessionCatalogRequest; response: SessionCatalogResult }
  'code.sessions.prepareOpen': { request: { workspaceId: string }; response: { workspace: RemoteCodeWorkspace } }
  'code.environment.get': { request: Record<string, never>; response: RemoteCodeSnapshot }
  'code.environment.local': { request: Record<string, never>; response: { snapshot: RemoteCodeSnapshot; recentProjects: string[]; currentProject: string | null } }
  'code.ssh.connect': { request: { profileId?: string; profile?: SshProfile; password?: string; activate?: boolean }; response: { connection: RemoteCodeConnection; snapshot: RemoteCodeSnapshot } }
  'code.ssh.select': { request: { profileId: string }; response: { snapshot: RemoteCodeSnapshot } }
  'code.ssh.browse': { request: { profileId: string; path?: string }; response: HostDirectory }
  'code.ssh.prepareWorkspace': { request: { profileId: string; path: string }; response: { path: string; name: string; hostLabel: string; trustToken: string; alreadyTrusted: boolean } }
  'code.ssh.openWorkspace': { request: { profileId: string; path: string; trustToken?: string }; response: { workspace: RemoteCodeWorkspace; snapshot: RemoteCodeSnapshot } }
  'code.ssh.disconnect': { request: { profileId: string; force?: boolean }; response: { snapshot: RemoteCodeSnapshot } }
  'desktop.identity': { request: Record<string, never>; response: { userName: string } }
  'chat.list': { request: Record<string, never>; response: { sessions: ChatSessionInfo[] } }
  'chat.create': { request: { title?: string; model?: string; thinkingLevel?: ChatThinkingLevel }; response: { session: ChatSessionInfo } }
  'chat.open': { request: { id: string }; response: { session: ChatSessionInfo; messages: ChatMessage[]; revision?: number } }
  'chat.send': { request: { id: string; text: string; images?: ChatMessage['images'] }; response: { accepted: true } }
  'providerUsage.get': { request: ProviderUsageRequest; response: ProviderUsageSnapshot }
  'chat.setThinking': { request: { id: string; level: ChatThinkingLevel }; response: { session: ChatSessionInfo } }
  'local.folders.browse': { request: LocalFolderBrowseRequest; response: LocalFolderBrowseResult }
  'local.folders.resolve': { request: LocalFolderResolveRequest; response: LocalFolderResolveResult }
  'chat.abort': { request: { id: string }; response: { ok: true } }
  'chat.rename': { request: { id: string; title: string }; response: { session: ChatSessionInfo } }
  'chat.delete': { request: { id: string }; response: { ok: true } }
  'chat.models': { request: Record<string, never>; response: { models: ChatModelInfo[] } }
  'routines.list': { request: Record<string, never>; response: { routines: Routine[]; runs: RoutineRun[]; runtime: { kind: 'desktop-local'; requiresAppOpen: true } } }
  'routines.save': { request: { routine: Routine; confirmedExecution?: boolean }; response: { routine: Routine } }
  'routines.delete': { request: { id: string }; response: { ok: true } }
  'routines.run': { request: { id: string }; response: { run: RoutineRun } }
  'routines.cancel': { request: { runId: string }; response: { ok: true } }
  'ssh.profiles': { request: Record<string, never>; response: { profiles: SshProfile[]; status: SshStatus; authCapabilities?: { password: boolean; passwordUnavailableReason?: string } } }
  'ssh.saveProfile': { request: SshProfile; response: { profile: SshProfile } }
  'ssh.deleteProfile': { request: { id: string }; response: { ok: boolean } }
  'ssh.connect': { request: { id: string; resume?: boolean; password?: string }; response: SshStatus }
  'ssh.disconnect': { request: Record<string, never>; response: { ok: boolean } }
  'ssh.command': { request: SshCommand; response: SshRecord }
  'ssh.files': { request: { action: 'list' | 'read'; path: string }; response: SshFilesResult }
  'adapters.json.catalog': { request: { workspaceId?: string; refresh?: boolean }; response: AdapterCatalog }
  'adapters.catalog': { request: { workspaceId?: string; refresh?: boolean }; response: { adapters: Array<{ id: string; pluginId: string; displayName: string; adapterJson?: AdapterCatalog['adapters'][number] }>; errors?: AdapterCatalog['errors'] } }
  'adapter.config.get': { request: { adapterId: string; workspaceId?: string }; response: { view: Record<string, unknown> } }
  'adapter.config.set': { request: { adapterId: string; workspaceId?: string; patch: Record<string, unknown> }; response: { view: Record<string, unknown> } }
  'adapter.action.run': { request: { adapterId: string; actionId: string; workspaceId?: string }; response: { ok: boolean; lines?: string[]; error?: string } }
  'adapter.field.options': { request: { adapterId: string; fieldKey: string; workspaceId?: string }; response: { options: string[]; error?: string } }
  'adapter.sidePanel.getState': { request: { adapterId: string; workspaceId: string }; response: { ok: boolean; state?: unknown; error?: string } }
  'workspace.open': { request: WorkspaceOpenRequest; response: WorkspaceOpenResponse }
  'workspace.ensureWorker': { request: WorkspaceEnsureWorkerRequest; response: WorkspaceEnsureWorkerResponse }
  'workspace.switch': { request: WorkspaceSwitchRequest; response: WorkspaceSwitchResponse }
  'workspace.fs.search': { request: WorkspaceFsSearchRequest; response: WorkspaceFsSearchResponse }
  'session.list': { request: SessionListRequest; response: SessionListResponse }
  'session.open': { request: SessionOpenRequest; response: SessionOpenResponse }
  'session.new': { request: SessionNewRequest; response: SessionNewResponse }
  'session.fork': { request: SessionForkRequest; response: SessionForkResponse }
  'session.forkCandidates': { request: SessionForkCandidatesRequest; response: SessionForkCandidatesResponse }
  'session.clone': { request: SessionCloneRequest; response: SessionCloneResponse }
  'session.rename': { request: SessionRenameRequest; response: SessionRenameResponse }
  'session.compact': { request: SessionCompactRequest; response: SessionCompactResponse }
  'session.export': { request: SessionExportRequest; response: SessionExportResponse }
  'context.preview': { request: ContextPreviewRequest; response: ContextPreviewResponse }
  'prompt.send': { request: PromptSendRequest; response: PromptSendResponse }
  'prompt.steer': { request: PromptSteerRequest; response: PromptSteerResponse }
  'prompt.followUp': { request: PromptFollowUpRequest; response: PromptFollowUpResponse }
  'prompt.abort': { request: PromptAbortRequest; response: PromptAbortResponse }
  'model.list': { request: ModelListRequest; response: ModelListResponse }
  'model.set': { request: ModelSetRequest; response: ModelSetResponse }
  'model.cycle': { request: ModelCycleRequest; response: ModelCycleResponse }
  'pi.models.get': { request: PiModelsGetRequest; response: PiModelsGetResponse }
  'pi.models.set': { request: PiModelsSetRequest; response: PiModelsSetResponse }
  'pi.models.fetch': { request: PiModelsFetchRequest; response: PiModelsFetchResponse }
  'thinkingLevel.set': { request: ThinkingLevelSetRequest; response: ThinkingLevelSetResponse }
  'commands.list': { request: CommandsListRequest; response: CommandsListResponse }
  'review.getDiff': { request: ReviewGetDiffRequest; response: ReviewGetDiffResponse }
  'review.stageHunks': { request: ReviewStageHunksRequest; response: ReviewStageHunksResponse }
  'review.unstageHunks': { request: ReviewStageHunksRequest; response: ReviewStageHunksResponse }
  'extensions.list': { request: ExtensionsListRequest; response: ExtensionsListResponse }
  'extensions.setEnabled': { request: ExtensionsSetEnabledRequest; response: ExtensionsSetEnabledResponse }
  'registry.refresh': { request: RegistryRefreshRequest; response: RegistryRefreshResponse }
  'settings.get': { request: SettingsGetRequest; response: SettingsGetResponse }
  'settings.set': { request: SettingsSetRequest; response: SettingsSetResponse }
  'app.checkUpdate': { request: AppCheckUpdateRequest; response: AppCheckUpdateResponse }
  'app.getPendingUpdate': {
    request: AppGetPendingUpdateRequest
    response: AppGetPendingUpdateResponse
  }
  'app.dismissUpdatePrompt': {
    request: AppDismissUpdatePromptRequest
    response: AppDismissUpdatePromptResponse
  }
  'app.openRelease': { request: AppOpenReleaseRequest; response: AppOpenReleaseResponse }
  'app.ignoreUpdateVersion': {
    request: AppIgnoreUpdateVersionRequest
    response: AppIgnoreUpdateVersionResponse
  }
  'app.downloadUpdate': {
    request: AppDownloadUpdateRequest
    response: AppDownloadUpdateResponse
  }
  'events.subscribe': { request: EventsSubscribeRequest; response: EventsSubscribeResponse; stream: AppEvent }
}

// ── Type helpers ──
export type IpcMethodName = keyof IpcMethodMap
export type IpcRequest<M extends IpcMethodName> = IpcMethodMap[M]['request']
export type IpcResponse<M extends IpcMethodName> = IpcMethodMap[M]['response']

export function ipcChannel<M extends IpcMethodName>(method: M): string {
  return `ipc:${method}`
}

export interface IpcInvoker {
  invoke<M extends IpcMethodName>(method: M, request: IpcRequest<M>): Promise<IpcResponse<M>>
}

export interface IpcHandler<M extends IpcMethodName> {
  (request: IpcRequest<M>): Promise<IpcResponse<M>>
}

export const EVENTS_CHANNEL = 'ipc:events'
