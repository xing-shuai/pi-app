# IPC 契约（Backend-API 边界）

与 `packages/shared/ipc-channels.ts` 同步。Main 实现见 `src/main/ipc/handlers/`。

## 类型边界

- `registerHandler(channel, fn)` — `IpcInvokeBody` 为文档类型；**settings 等 handler 在实现内用 `keyof StoreSchema` 窄化**（见 `handlers/settings.ts`）。
- Renderer 仅通过 preload allowlist `invoke(channel, body)`。

## 高频 channel

| Channel | Request | Response |
|---------|---------|----------|
| `ipc:settings.get` | `{ key?: keyof StoreSchema }` | `{ settings: Partial<StoreSchema> }` |
| `ipc:settings.set` | `{ key: keyof StoreSchema; value: StoreSchema[key] }` | `{ key, value }` |
| `ipc:runtime.getState` | `{}` | Worker/runtime 快照 |
| `ipc:session.list` | workspace 相关字段 | 会话列表 |

## 内置浏览器（`ipc:browser.*`，实验）

Main 在第一次 `tabs.open` 时才创建 `BrowserHost`；没有打开过标签时，其余 channel 都是空操作。类型见 `packages/shared/browser-types.ts`。

| Channel | Request | Response |
|---------|---------|----------|
| `ipc:browser.tabs.list` | `{}` | `{ tabs: BrowserTabInfo[]; activeTabId: string \| null }` |
| `ipc:browser.tabs.open` | `{ url?: string; profileId?: string }` | `{ tab: BrowserTabInfo }` |
| `ipc:browser.tabs.close` / `ipc:browser.tabs.focus` | `{ tabId }` | `{ ok: true }` |
| `ipc:browser.navigate` | `{ tabId; url }` 或 `{ tabId; history: 'back' \| 'forward' \| 'reload' \| 'stop' }` | `{ ok: true }`；非 http(s) 地址会被拒绝 |
| `ipc:browser.viewBounds` | `BrowserViewBounds`（占位元素的 client rect + `visible`） | `{ ok: true }` |
| `ipc:browser.capture` | `{ tabId }` | `{ dataUrl: string \| null }`（被弹层遮挡时用作占位图） |
| `ipc:browser.find` | `{ tabId, text, forward?, findNext? }` | `{ ok }`；结果以 `find-result` 事件返回（`findNext=true` 表示在当前查找中移动） |
| `ipc:browser.find.stop` | `{ tabId }` | `{ ok }` |
| `ipc:browser.downloads.list` | — | `{ downloads: BrowserDownloadInfo[] }` |
| `ipc:browser.downloads.cancel` | `{ id }` | `{ ok }`（aria2 下载会删除未完成文件和 .aria2 控制文件） |
| `ipc:browser.downloads.reveal` | `{ id }` | `{ ok }` |
| `ipc:browser.downloads.clear` | — | `{ downloads }`（清除已结束的条目） |
| `ipc:browser.downloader.status` | `{ aria2Path? }` | `{ path: string \| null, version: string \| null }` |
| `ipc:browser.inspectPoint` | `{ tabId; x; y; deep?: boolean }` | `{ element: ElementDescriptor \| null }`；在隔离 world 中执行，`deep` 且为开发地址时额外在主 world 读取框架源码位置 |
| `ipc:browser.pageContext` | `{ tabId; saveText?: boolean }` | `PageContextResult`（不含 `text`）+ `path`（`saveText` 时正文写成 `.md` 临时文件） |
| `ipc:browser.logs` | `{ tabId; max?: number }` | `{ entries: BrowserLogEntry[] }`（console 错误/警告、失败请求或状态码 ≥ 400 的请求） |
| `ipc:browser.scroll` | `{ tabId; x; y; deltaY }` | `{ ok: true }`（真实滚轮输入） |
| `ipc:browser.hideAll` / `ipc:browser.shutdown` | `{}` | `{ ok: true }` |
| `ipc:browser.profile.clear` | `{ profileId?: string }` | `{ ok: true }` |

Main → Renderer 的事件走 `ipc:browser-event`（`BrowserEvent`：`tab-updated` / `tab-closed` / `tab-focused` / `download` / `shortcut`）。

Renderer 内部事件 `pi-desktop:composer-attach-files` 的 `detail` 为 `{ files?: {path,name,kind}[]; text?: string }`：`text` 插在附件之前，可以只带 `text`。浏览器的截图、页面正文、批注、日志都通过这个事件放进输入框，**不会自动发送**。

## Chat / Code 分区与 Local Routines

新增方法的类型在 `packages/shared/{chat-types,routine-types,execution-target,remote-code,ssh-host-types,ipc-contract}.ts`。

| Channel | Request | Response |
|---|---|---|
| `ipc:chat.list` / `ipc:chat.models` | `{}`（可省略） | `{sessions}` / `{models}` |
| `ipc:chat.create` | `{title?,model?}` | `{session}`；不接受 cwd/sessionFile |
| `ipc:chat.open` | `{id}` | `{session,messages,revision}` |
| `ipc:chat.send` | `{id,text,images?}` | `{accepted:true}`，持久标记 busy 后立即确认，不等待模型整轮结束 |
| `ipc:chat.abort` / `ipc:chat.delete` | `{id}` | `{ok:true}` |
| `ipc:chat.rename` | `{id,title}` | `{session}` |
| `ipc:routines.list` | `{}`（可省略） | `{routines,runs,runtime:{kind:'desktop-local',requiresAppOpen:true}}` |
| `ipc:routines.save` | `{routine,confirmedExecution?}` | `{routine}`；新建 ID/时间戳由服务端生成 |
| `ipc:routines.run` | `{id}` | `{run}`，不是已完成结果 |
| `ipc:routines.cancel` | `{runId}` | `{ok:true}`，仅表示取消请求已接收；确认停止以 run 状态/`executionSettledAt` 为准 |
| `ipc:routines.delete` | `{id}` | `{ok:true}`，拒绝删除活跃任务 |
| `ipc:environment.list` | `{}` | 旧执行目标能力描述；共享 Code 当前选择以 `code.environment.get` 为准 |
| `ipc:code.sessions.list` | `{filter?,search?}` | 已知 Local/SSH 位置的只读元数据；最多 500 个匹配项、`limited?`；不认证、连接或创建会话 worker |
| `ipc:code.sessions.prepareOpen` | `{workspaceId}` | `{workspace}`；明确点击后对既有连接/受信根进行规范路径复验，不在等待期间改变前台位置 |
| `ipc:code.environment.get` / `.local` | `{}` | 当前 snapshot / `{snapshot,recentProjects,currentProject}`；Local 恢复原生本机列表 |
| `ipc:code.ssh.connect` | `{profileId? ,profile?,password?,activate?}` | `{connection,snapshot}`；密码仅本次使用，测试连接用 `activate:false` |
| `ipc:code.ssh.select` / `.disconnect` | `{profileId,force?}` | `{snapshot}`；断开不自动回到 Local |
| `ipc:code.ssh.browse` | `{profileId,path?}` | 远端目录列表；不启动 Pi |
| `ipc:code.ssh.prepareWorkspace` | `{profileId,path}` | 规范目录、实际主机、短期一次性 trustToken 与既有信任状态 |
| `ipc:code.ssh.openWorkspace` | `{profileId,path,trustToken?}` | `{workspace,snapshot}`；验证批准、连接身份与 symlink 绑定 |
| `ipc:app.quit` | `{}` | `{ok:true}`；请求真实退出，仍经过统一审批/清理 |
| `ipc:app.codeReady` | `{}` | `{ok:true}`；访问 Code 后才允许其 SDK/扩展预热 |

Chat 事件独立走 `ipc:chat-event`，Routines 走 `ipc:routine-event`，不投递给 Code 的 `ipc:events`。Chat transcript snapshot/delta 带单会话递增 revision，open 返回对应 revision，以便重放晚于快照的事件而不丢历史或重复 delta。revision 仅在当前主进程生命周期内使用。

未知/取消中的 routine 即使 UI 超时也不能释放实际执行锁；`unknown` 且无 `executionSettledAt` 仍为活跃执行。关闭确认统一在主进程处理，Chat 不另设抢先中止用户任务的 before-quit listener。

## 共享 Code 的远端分流

`ipc:code-environment-event` 只投递 snapshot。会话目录两个 root 端点由自身校验服务器已知身份，其虚拟字符串是元数据，不送入普通执行路由。其他远端文件/会话/模型/终端调用仍先执行严格身份路由，未知身份不回退本机。原有 `ipc:events`、终端 data/exit、扩展交互通道继续复用。远端 helper 的 JSONL 类型与有界操作在 `ssh-host-types.ts`，不允许 renderer 上传任意 Node 代码或凭据。

所有注册 invoke（包括 in-process gateway）在本地验证/IO 前经过 `routeRemoteCodeInvoke`。服务端签发的 `/__pi_ssh__/…` 工作区/会话键与 `ssh-term-*` 终端 ID 必须固定到所属连接；混合身份、嵌套未知身份和已失效远端键拒绝，不调用本机 handler。明确的原生本地工作区调用仍保持本地，不能因前台换成 SSH 就把后台本地调用发往远端。

Raw `ipc:terminal-write` 另行拦截：远端/未知保留前缀 ID 被远端服务消费，不能流入本机 PTY。renderer 还按工作区与活动 pane 校验输入；Markdown/工具文件操作把批准根内路径映射到 Files，远端 OS reveal/open 禁用。Git diff、终端 profiles/create 等带显式工作区提示，防止异步响应跨位置。

## 回归

`scripts/tests/ipc-channel-sync.test.mjs` — allowlist ↔ `registerHandler` 双向一致。