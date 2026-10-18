import { registerDialogHandlers } from './ipc/handlers/dialog'
import { registerWorkspaceFsHandlers } from './ipc/handlers/workspace-fs'
import { registerWorkspaceHandlers } from './ipc/handlers/workspace'
import { registerSessionHandlers } from './ipc/handlers/session'
import { registerPromptHandlers } from './ipc/handlers/prompt'
import { registerSettingsHandlers } from './ipc/handlers/settings'
import { registerWindowControlHandlers } from './ipc/handlers/window-controls'
import { registerTerminalHandlers } from './ipc/handlers/terminal'
import { registerUsageHandlers } from './ipc/handlers/usage'
import { registerGitBranchHandlers } from './ipc/handlers/git-branches'
import { registerBackgroundHandlers } from './ipc/handlers/background'
import { registerModelRuntimeHandlers } from './ipc/handlers/model-runtime'
import { registerExtensionHandlers } from './ipc/handlers/extensions'
import { registerExtensionUiHandlers } from './ipc/handlers/extension-ui'
import { registerAdapterPanelHandlers } from './ipc/handlers/adapter-panels'
import { registerSkillsResourceHandlers } from './ipc/handlers/skills-resources'
import { registerReviewHandlers } from './ipc/handlers/review'
import { registerCommandsSlashHandlers } from './ipc/handlers/commands-slash'
import { registerAsrHandlers } from './ipc/handlers/asr'
import { registerPiSdkHandlers } from './ipc/handlers/pi-sdk'
import { registerWslHandlers } from './ipc/handlers/wsl'
import { registerDesktopChromeHandlers } from './ipc/handlers/desktop-chrome'
import { registerBrowserHandlers } from './ipc/handlers/browser'
import { registerMcpHandlers } from './ipc/handlers/mcp'
import { registerModelRouterHandlers } from './ipc/handlers/model-routers'
import { registerRemoteHandlers } from './ipc/handlers/remote'
import { registerLinkHandlers } from './ipc/handlers/links'
import { registerSshHandlers } from './ipc/handlers/ssh'
import { registerChatHandlers, chatRuntime } from './ipc/handlers/chat'
import { registerRoutineHandlers, hasActiveRoutineRuns } from './ipc/handlers/routines'
import { setAdditionalActivityProbe } from './window-close-guard'
import { registerEnvironmentHandlers } from './ipc/handlers/environments'
import { registerSessionCatalogHandlers } from './ipc/handlers/session-catalog'
import { registerProviderUsageHandlers } from './ipc/handlers/provider-usage'
import { registerLocalFolderHandlers } from './ipc/handlers/local-folders'
import { registerRemoteCodeHandlers } from './ipc/handlers/remote-code'
import { routeRemoteCodeInvoke, hasActiveRemoteCodeWork } from './remote-code'
import { setIpcInvokeRouter } from './ipc/registry'

export { registerHandler, sendEvent } from './ipc/registry'

export function registerAllHandlers(): void {
  setIpcInvokeRouter((channel, request) => {
    // Catalog endpoints validate/filter server-known locations themselves; virtual IDs here
    // are metadata, not a request to execute a local Code handler.
    if (channel === 'ipc:code.sessions.list' || channel === 'ipc:code.sessions.prepareOpen') return Promise.resolve({ handled: false })
    return routeRemoteCodeInvoke(channel, request)
  })
  registerRemoteCodeHandlers()
  registerLocalFolderHandlers()
  registerProviderUsageHandlers()
  registerSessionCatalogHandlers()
  registerDialogHandlers()
  registerWorkspaceFsHandlers()
  registerWorkspaceHandlers()
  registerSessionHandlers()
  registerPromptHandlers()
  registerSettingsHandlers()
  registerWindowControlHandlers()
  registerTerminalHandlers()
  registerUsageHandlers()
  registerGitBranchHandlers()
  registerBackgroundHandlers()
  registerExtensionUiHandlers()
  registerModelRuntimeHandlers()
  registerExtensionHandlers()
  registerAdapterPanelHandlers()
  registerSkillsResourceHandlers()
  registerReviewHandlers()
  registerCommandsSlashHandlers()
  registerAsrHandlers()
  registerPiSdkHandlers()
  registerMcpHandlers()
  registerModelRouterHandlers()
  registerWslHandlers()
  registerDesktopChromeHandlers()
  registerBrowserHandlers()
  registerRemoteHandlers()
  registerLinkHandlers()
  registerSshHandlers()
  registerChatHandlers()
  registerRoutineHandlers()
  registerEnvironmentHandlers()
  setAdditionalActivityProbe('routines', hasActiveRoutineRuns)
  setAdditionalActivityProbe('chat', () => chatRuntime.hasActiveWork)
  setAdditionalActivityProbe('remote-code', hasActiveRemoteCodeWork)
}