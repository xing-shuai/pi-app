/** Node-only remote host protocol. No credentials are part of this protocol. */
export type HostEntry = { name: string; path: string; directory: boolean; symlink?: boolean }
export type HostDirectory = { path: string; home: string; entries: HostEntry[] }
export type HostWorkspace = { id: string; root: string; name: string }
export type HostSession = { runtimeId: string; sessionId: string; sessionFile: string; cwd: string; model?: string; thinkingLevel?: string; isStreaming: boolean }
export type HostState = { home: string; platform: string; nodeVersion: string; capabilities: { files: boolean; git: boolean; pty: boolean; sessions: boolean }; workspaces: HostWorkspace[] }
export type HostOperation =
  | 'browse' | 'workspace.register'
  | 'fs.list' | 'fs.read' | 'fs.write' | 'fs.rename' | 'fs.create' | 'fs.search' | 'fs.image'
  | 'git.status' | 'git.diff' | 'git.branches' | 'git.switch' | 'git.stage' | 'git.unstage' | 'git.worktrees'
  | 'session.list' | 'session.start' | 'session.close' | 'session.rpc' | 'session.delete' | 'session.adopt'
  | 'terminal.profiles' | 'terminal.create' | 'terminal.write' | 'terminal.resize' | 'terminal.kill'
export type HostRequest = { id: string; type: 'host'; op: HostOperation; args: Record<string, unknown> }
export type HostReply = { id: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string; errorCode?: string }
export type HostEvent =
  | { type: 'host_event'; kind: 'pi'; workspaceId: string; runtimeId: string; event: Record<string, unknown> }
  | { type: 'host_event'; kind: 'session-exit'; workspaceId: string; runtimeId: string; code: number | null }
  | { type: 'host_event'; kind: 'terminal-data'; workspaceId: string; terminalId: string; data: string }
  | { type: 'host_event'; kind: 'terminal-exit'; workspaceId: string; terminalId: string; code: number | null }
