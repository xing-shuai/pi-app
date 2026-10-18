# Pi Desktop 对齐 Claude Desktop：功能调研与架构方案

调研日期：2026-10-17。本报告对比的是克隆基线，后续第一阶段实现与限制见 [Chat / Code / Routines 使用说明](./guide/product-areas.zh-CN.md)，不能把下表的原始缺口状态当作分支当前功能状态。

基线：`justhil/pi-app`，package version `0.7.5`，commit `c16900f99b3a4493584adaa4c43e0b0bdb70639e`。

## 0. 目标纠正与证据边界

目标是基于 Pi 构建 **Chat / Code 两大区**的完整客户端，覆盖日常对话/知识工作、开发工作台、Routines 自动化及 SSH 工作空间；不是只换 Claude 主题，也不是单独放一个 SSH 聊天窗口。

调研依据是当日公开的 Anthropic 官方帮助中心、Code 文档及发布说明，没有登录用户账户检查灰度界面，也没有声称某个安装包版本号就是所有平台最新版本。

官方资料有版本交叠：

- 2026-09-16 发布说明及「Claude Cowork and chat are one Claude」说明 Chat 与 Cowork 正在合并，Pro/Max 分阶段推出，同一套餐账户可能看到不同界面。
- Code Desktop 概览仍以 Chat / Cowork / Code 三标签介绍产品。
- 因此本项目采用用户明确要求的 **Chat / Code**：把通用 agentic/知识工作能力并入 Chat，不再额外复制 Cowork 一级入口。Code 保持专门开发区。
- 云端、企业管理、平台特定能力分别标记，不把「官方产品支持」等同于「Pi 核心已经具备」或「可以调用官方内部服务」。

前一轮未提交的 SSH/样式代码只是一份原型：不计入上游已有能力，不代表已经完成本方案。

## 1. Claude Desktop 的当前功能轮廓

### 1.1 Chat：统一对话与知识工作

| 功能 | 官方能力及边界 | 本项目对齐目标 |
|---|---|---|
| 对话与上下文 | 历史、搜索、附件、模型选择、任务进度、停止/重定向 | 独立 Chat 会话，不要求用户先选代码目录 |
| Chat + Cowork | 快问快答与多步任务在一个对话中，根据任务使用搜索、文件和代码工具 | 统一 Chat UI；后台按权限选择工具，不通过改提示词假装实现能力 |
| Projects | 项目知识、项目指令、对话归组、归档；团队共享另有套餐限制 | 领域项目，不等同于文件系统目录；共享知识、指令和记忆策略 |
| Memory | 账户/项目记忆、主题查看/编辑/删除、单次禁用、历史检索引用 | 显式记忆存储与控制；不能把恢复会话或压缩摘要当作长期记忆 |
| Web Search / Research | 引用来源、多步调查，可结合已连接的数据源；受模型/套餐限制 | 搜索提供商接口、引用模型、研究任务进度与结果，允许更换模型 |
| Artifacts | 对话旁的可编辑产物，设计、文档、幻灯片、图表、小应用；有产物库、版本/分享/导出 | 先实现安全的 HTML/React/Markdown/SVG 产物面板和版本，再扩展文档导出与分享 |
| 文件生成 | 报告、文档、表格、演示文件等可继续修改和下载 | 文档生成工具链与文件结果协议，不只展示代码块 |
| Customize | Skills、Connectors、Plugins 统一目录及管理，部分配置跨界面复用 | 复用 Pi 资源体系，增加统一目录、权限、来源与运行环境标记 |
| Computer use | 需显式开启、系统授权、应用级许可；不是一般浏览器自动化 | 后期单独实现 OS 适配、安全策略与审计；不把 Electron BrowserView 称为电脑控制 |
| Scheduled / 手机继续 | 通用任务可云端运行、周期触发，手机可看进度/回答问题 | 与 Code 共用任务基础设施；平台同步需要自建服务或可信远端 |
| 桌面特性 | 快速输入、截图、语音、系统通知；具体能力受 OS 限制 | 复用语音/通知基础，按 Linux/macOS/Windows 分别验收 |

依据：S1、S2、S6–S11。

### 1.2 Code：开发工作台

| 功能组 | Claude Desktop 当前能力 | 对齐重点 |
|---|---|---|
| 会话入口 | 环境、项目/仓库、模型、权限模式；独立会话并行运行 | 同一工作台选择 Local / SSH / WSL / 后续自托管 Runner |
| 工作区面板 | Chat、Diff、Browser、Terminal、Files、Plan、Tasks、Subagent；可调整布局、部分可独立窗口 | 复用现有面板，统一布局/导航，不重复实现整套 Code UI |
| 代码上下文 | @文件、附件、可编辑文件、保存冲突提示 | 所有文件操作必须匹配实际执行环境 |
| 权限与计划 | Manual、Accept edits、Plan、Auto、Bypass；Auto 含分类器检查，不等于无条件允许 | 先实现可验证的 Ask / Accept edits / Read-only Plan；自动审批作为单独安全能力 |
| Git | worktree 隔离、Diff 行评论、代码审查、PR/CI 状态、自动修复、可选自动合并 | 现有 Git 能力可复用；GitHub 生命周期需新增服务，危险操作需要明确授权 |
| 应用验证 | dev server 管理、浏览器预览、截图/DOM/点击、自动验证 | 整合现有浏览器工具与 dev server 生命周期；SSH 需端口通道 |
| 任务组织 | 并行会话、后台 shell/subagent、side chat、会话间消息 | 持久任务状态与输出索引；插件提供的能力不能默认视为内置 |
| Projects（Code） | 一个协调会话派发多个线程，Overview / Library / PR / Routines | 这是任务编排项目，不仅是侧栏目录分组；安排在基础会话/Runner之后 |
| 长任务 | Cloud 与部分 SSH 任务可离线继续；受凭证、主机、工具路由限制 | Remote daemon + 事件重放，不依赖持续存在的桌面 SSH 子进程 |
| 扩展 | Skills、Plugins、MCP/Connectors，可按环境生效 | 统一资源管理和兼容边界；Pi 插件不天然等同于 Claude 插件格式 |
| 原生平台能力 | 如 macOS iOS Simulator、电脑控制等 | 单列平台扩展，不作为 Linux 首版默认保证 |

依据：S3、S12。

### 1.3 Routines：必须区分三种东西

| 形态 | 运行位置 | 桌面关闭/电脑关机 | 触发方式与状态 |
|---|---|---|---|
| 会话内 `/loop` | 当前运行会话所在机器 | 不能独立于所依赖的会话/机器运行 | 适合短期轮询，不是完整 Routines 产品 |
| Desktop Local scheduled task | 本机，由桌面调度 | 配置跨重启；仅 app 打开且电脑醒着时触发 | 手动、周期、一次性；模型、权限、目录、worktree；历史、跳过原因、补跑 |
| Cloud routine | 云端，或官方支持的组织自托管环境 | 不依赖用户电脑在线 | 周期/一次性 + API + GitHub，仓库、环境、连接器、运行记录 |

官方 Local scheduled task 包含：名称、描述、指令、模型、权限、目录、隔离 worktree、手动运行、启停、编辑、删除、历史、工具批准记录。休眠/重启会检查最近七天漏跑，最多补一次最近的任务；还需呈现上轮未结束或并发已满等跳过原因。

官方 Cloud routine 是保存的「prompt + repos + environment + connectors + triggers」。可组合 schedule、API、GitHub PR/Release 事件，每次运行产生可打开的完整会话；支持 Run now、启停、编辑、删除与历史。调度有时区、最小间隔和限额等具体规则。

Chat 的 Scheduled 与 Code 的 Routines 也不是同一个列表名称下的完全相同产品：Chat 针对通用任务，Code 面向开发环境/仓库。本项目可以用同一底层任务引擎、不同默认表单/结果视图。

依据：S4、S5、S6。

## 2. pi-app 基线对照

状态定义：「已有」指能在源码中找到实现；「部分」指有基础但未达到所列产品语义；「缺口」指当前检查范围未发现内置完整实现。可安装扩展与内置产品能力分开计算。不使用没有验收口径的「已完成百分比」。

| 对齐项 | 上游状态 | 源码证据/可复用点 | 主要差距 |
|---|---|---|---|
| Chat / Code 一级导航 | 缺口 | `src/renderer/src/app/app.tsx` | 当前 main/settings，主要是同一开发界面 |
| 普通对话 | 部分 | `src/main/sandbox-workspaces.ts`、`features/workspace/` | 临时目录中的 Pi agent 不等于权限受控的通用 Chat；名称 sandbox 不代表 OS 隔离 |
| 对话渲染/附件/模型 | 已有基础 | `features/timeline/`、`features/composer/` | 附件多以 @path/临时图片路径拼入文本；不等于直接多模态上传 |
| 原生图片/文档摄入 | 部分/需补齐 | `worker-manager.ts` 的 `sendPrompt()`、`worker/handlers/worker-handlers-turn.ts`、`composer/attachment-text.ts` | 当前桌面链主要传文本，未见传递 SDK `options.images`；PDF/Office 的图标或系统打开入口不代表已经解析/OCR并送入模型 |
| 全历史搜索 | 部分 | `features/workspace/project-session-tree.ts` 的 `matchesSessionQuery()`、`main/sqlite-index.ts` | 当前侧栏搜索标题/首消息/sessionId，不等于消息全文或语义检索 |
| 持久指令 | 已有基础 | `main/pi-prompt-catalog.ts`、`features/settings/prompts-settings-panel.tsx` | 可复用 AGENTS.md/CLAUDE.md 与 SYSTEM/APPEND_SYSTEM 资源管理，但需新增面向 Chat 的用户/项目指令，不直接让用户偏好替换整个 harness system prompt |
| Chat Projects/知识库 | 缺口 | 现有 project 主要对应本地路径与会话 | 需新增领域项目、资料索引、共享指令与记忆作用域 |
| Artifacts 产品 | 缺口（已有可视化基础） | `features/ui-blocks/`、`main/capabilities/pi-ui.md` 的图表/表格/卡片、Markdown/Mermaid、文件预览、Browser | 声明式可视化不是完整 Artifacts；缺持久产物 ID、版本、库、编辑协议、安全运行时、导出/分享 |
| Web Research | 部分基础 | 浏览器工具与扩展适配 | 不等于内置搜索提供商、可引用研究工作流 |
| Memory | 部分外围 | session/history、扩展、浏览器 site notes | 没有证据表明具备统一账户/项目记忆与隐私控制 |
| 本地 Code 会话 | 已有 | `worker-manager*.ts`、`worker/`、`features/timeline/` | 保留并重构为 Code 区 |
| WSL | 已有 | `src/main/wsl/`、`worker-transport.ts` | 运行时目前较多全局选择语义，需抽象为环境 |
| Diff/Git 分支与 hunk stage | 已有 | `git-workspace.ts`、`git-branches.ts`、`features/review/` | Turn/Session scope 主要按触及路径筛选当前 Git diff，并非每轮精确文件快照；完整 PR/CI 自动化还需新服务 |
| Worktree 生命周期 | 部分 | `git-worktrees.ts`、`features/workspace/use-project-worktrees.ts` | 已有发现/分组，未发现内置完整 add/remove 管理，不能宣称已实现一任务一隔离工作树 |
| Rewind/文件 checkpoint | 部分 | `features/rewind/`、`main/pi-rewind-read.ts`、`builtin/pi-rewind.adapter.json` | 对话 fork/tree/rewind 已有，文件 checkpoint 创建/恢复依赖加载的 pi-rewind 扩展，不能混为同一能力 |
| 内置终端 | 已有 | `src/main/terminal/`、`features/terminal/` | 当前本地/现有运行时语义，SSH 需要远端 PTY |
| 文件面板 | 已有 | `workspace-fs.ts`、`features/workspace-files/` | 路径和授权有本机假设，不能直接传 SSH 路径 |
| 浏览器工具 | 已有 | `src/main/browser/`、`worker-browser-tools.ts` | 需补环境路由与 preview server 管理；不等于 Computer use |
| Plan/权限模式 | 缺统一产品层 | `trusted-workspace.ts`、扩展 UI、`main/capabilities/catalog.ts` | workspace 信任、capability 开关、提示词中的「先询问」都不等于后端逐工具审批、read-only plan 或安全分类器 |
| Skills/扩展管理 | 已有兼容基础 | `extension-compat/`、`features/settings/settings-extensions-panel.tsx`、`skills-settings-panel.tsx` | 可启停/编辑/适配；未发现完整市场搜索/安装/卸载 UI；Pi/Claude 格式兼容需另行验证 |
| MCP 管理 | 已有内置集成 | `worker/worker-runtime.ts` 注册 `createMcpExtension`；`main/mcp/`、`ipc/handlers/mcp.ts`、`mcp-settings-panel.tsx` | 已有 stdio/HTTP、导入、启停、状态与登录/登出；管理 handler 当前拒绝 WSL，SSH 原型未接入；仍需统一 Connectors/环境授权 |
| 后台会话/通知 | 已有基础 | worker pool、completion notifications | 长任务与持久调度不同；桌面退出后不能据此承诺继续运行 |
| 手机连接 | 已有 | `main/remote/`、`apps/mobile/` | 是手机控制桌面的 gateway，不是远端 SSH Runner |
| Routines 管理/调度 | 缺口 | 尚未发现完整的内置 routines 领域模型和 UI | 不能拿当前开发 harness 的 cron/loop 工具算作 pi-app 功能 |
| Cloud / Remote Runner | 缺口 | 可复用 worker/stdin framing 部分设计 | 需要服务进程、事件日志、身份、任务队列、重连与凭证策略 |
| SSH | 上游无完整实现；本分支有原型 | 新增 `main/ssh/`、`features/ssh/` | 原型是单独 RPC 聊天；不是统一环境，也不具备离线驻留、PTY、完整 Review |

此表已结合独立只读源码复核更新；没有执行完整产品功能验收来宣称所有「已有」项都达到 Claude 水准。特别注意：`doc/ROADMAP.md` 的部分旧描述已落后于源码（例如 MCP），且原上游曾明确不做每步审批；对齐 Claude 需要主动改变权限产品策略，而不只是打开一个已有开关。

## 3. 推荐的信息架构

```text
Pi Desktop
├─ Chat
│  ├─ 新对话 / 搜索 / 历史
│  ├─ Projects：资料、指令、记忆、对话
│  ├─ Artifacts：产物库、版本、导出
│  └─ Scheduled：通用自动任务
├─ Code
│  ├─ New session：环境 + 仓库/目录 + 模型 + 权限
│  ├─ Sessions：运行中 / 等待批准 / 完成，按项目/环境筛选
│  ├─ Projects：后期协调多任务、Overview / Library / PR
│  ├─ Routines：本地、SSH、后续自托管 Runner
│  └─ Workbench：Chat / Diff / Files / Terminal / Browser / Tasks
└─ 共用
   ├─ Customize：Skills / Connectors / Plugins
   ├─ Environments：Local / SSH / WSL / Self-hosted Runner
   ├─ Inbox：完成、失败、等待批准
   └─ Settings：模型、凭证、权限、记忆、外观、数据
```

**SSH 应当出现在 Code 的环境选择器里，不是与 Chat/Code 并列的第三种产品。** Routines 是正式页面和领域对象，不只是输入框里的 `/loop`。

## 4. 架构调整：保留核心，重构边界

### 4.1 分离产品语义与 Pi 运行时

建议引入持久化的领域对象：

- `Project`：Chat 知识项目与 Code 编排项目可以共享基础信息，但类型/能力要明确；不能直接等同于 cwd。
- `Environment`：稳定 ID、类型、能力、凭证引用、健康状态。
- `Workspace`：`environmentId + nativePath`，必要时包含 repository/worktree 信息。
- `Session`：`surface: chat|code`、projectId、workspaceId、权限策略、Pi session reference。
- `Artifact`：owner/project/session、版本、源文件、运行能力、导出元数据。
- `Routine` / `Trigger` / `Run` / `Approval` / `Event`：分别持久化，不能全部塞进 UI store。

Chat 与 Code 复用模型选择、流式消息、附件、工具事件及 Pi SDK；各自拥有默认工具集、权限、布局与数据过滤。**Chat 默认不拥有 Code 的任意 shell/全盘文件能力。** UI 隐藏按钮不是后端权限隔离。

### 4.2 WorkspaceProvider / SessionBackend

在现有 IPC 与 worker 之间引入能力明确的接口，而不是在每个 handler 到处写 `if ssh`：

```ts
interface WorkspaceBackend {
  capabilities(): BackendCapabilities
  sessions: SessionBackend
  files: FileBackend
  git: GitBackend
  terminal: TerminalBackend
  tasks: TaskBackend
  previews: PreviewBackend
}
```

先将 Host/WSL 现有服务适配；再加入 SSH backend。所有 ID 都携带环境归属；`/home/a/repo` 在两台机器上是不同工作区。本地与远端路径保持原生字符串，只用 opaque ID 关联，避免把 URI 交给本地 path normalize/fs。

### 4.3 SSH 的正式实现

- OpenSSH + 现有 SSH config/Agent，严格 known_hosts、指纹确认；不默认转发 Agent。
- 明确征得用户同意后部署版本化远端 helper/runner；探测 Node、Pi、权限、磁盘和协议能力。
- 文件访问、Git、PTY、session/history、工作树、开发服务器管理都由远端 backend 执行。
- SSH 只作为安全传输，不是任务的生命周期拥有者。
- 远端 helper 管理 Pi workers，持久化事件序号和执行状态。断线后任务不随 ssh 子进程消失；重连补事件和恢复批准请求，不重复发送 prompt。
- 默认仅使用远端凭证/安全注入的 SecretRef，不自动复制本地模型密钥。
- 预览端口按请求显式开通，本地 loopback 监听，关闭/审计生命周期独立处理。
- POSIX 远端先验收；Windows 远端作为单独平台适配，不声称靠同一 POSIX 启动字符串就支持。

本轮 RPC 原型可用于验证 Pi 协议与连接流程，但不建议直接扩成第二套独立 Code 产品。引用官方 SSH 离线能力时也要保留其凭证/主机/工具限制，不能承诺任意情况永不停止。

### 4.4 Routines 引擎

Routines 的产品层配置至少包括：

```text
name / description / surface / prompt
projectId / environmentId / workspace or repositories
model / thinking / skills / connectors / secretRefs
permissionPolicy / isolation: worktree|container|none
triggers: manual | once | cron(+IANA timezone) | webhook | github
maxConcurrency / timeout / costBudget / retryPolicy / misfirePolicy
```

每次触发新建 `Run`，状态示例：

```text
queued → provisioning → running → succeeded / failed / cancelled
                          ↘ awaiting_approval → running
另记 skipped / expired / interrupted 及明确原因
```

关键约束：

1. 调度在主进程之外可持续运行的服务中实现，React/renderer 不持有 cron 定时器。
2. 本地首版明确标为「桌面开启时运行」；要支持彻底退出后运行，需单独安装/启动本机服务，不能虚假宣传。
3. SSH routines 将任务和调度配置部署到用户的远端 runner，由远端持续调度，桌面离线仍可运行；桌面每分钟 SSH 轮询不满足这个目标。
4. SQLite 等持久存储记录定义/触发/运行/事件；runner 通过 lease/锁领取任务，处理进程崩溃、重启和多客户端重复触发。现有 `main/sqlite-index.ts` 是可重建、失败可禁用的缓存索引，不可原样当作任务真值账本；需要独立可靠库、迁移与恢复策略。
5. 时区/DST、漏跑补偿、同任务重叠、全局并发和成本预算必须定义行为。对齐官方默认时可采用「七天内最多补最近一次」，也可提供可配置策略，但不能含糊。
6. 事件投递采用至少一次 + 去重键/幂等控制；外部发消息、提交 PR 等副作用不能承诺泛化的 exactly-once。
7. 无人值守任务使用专门的工具 allowlist/网络/写入范围，未知动作等待批准或失败，不自动同意全部扩展弹窗。
8. Webhook token 只授予触发对应 routine 的能力；签名验证、轮换、限流、防重放；传入 payload 标为不可信数据，不覆盖保存的任务指令。
9. 每次运行记录版本快照、模型、预算、工具审计、文件/PR/报告产物与失败原因；可从历史进入对应会话。
10. 通用 Chat Scheduled 与 Code Routines 共用引擎，但表单/模板/输出视图不同。

## 5. 分阶段交付与验收

### P0：产品骨架与数据边界

- Chat / Code 顶层切换，共用 Customize / Inbox / Settings。
- 会话 `surface`、项目和环境身份；迁移现有会话，保持 CLI JSONL 兼容。
- backend 接口与权限/能力协商；先保留当前 Local/WSL 正常工作。
- 验收：切换分区不会串历史、工具、草稿或运行状态；Chat 未授权不能执行 Code shell。

### P1：Code + 正式 SSH

- 复用现有 Code UI，将 SSH 放入环境选择器；补内置 worktree add/remove 生命周期与可验证的文件 checkpoint。
- 远端会话、Files、Git/Diff、worktree、PTY 和预览通道，helper 生命周期、重连/事件回放。
- 实施 Ask / Accept edits / Read-only Plan 与批准收件箱，后端执行策略。
- 验收：远端读写/Git/终端全在测试主机；两台同路径机器不会串数据；断网后任务继续、恢复事件不重放任务；拒绝未知/变更主机密钥。

### P2：Routines 首个完整闭环

- 列表、创建/编辑/启停/删除、Run now、历史、下次运行、失败与批准状态。
- 手动/一次性/cron，Local 和 SSH runner；每次独立 session/worktree、权限和预算。
- 验收：重启配置保留；模拟休眠与 DST；重叠/并发/补跑行为可测试；桌面关机时远端任务照常启动；不重复执行危险副作用。

### P3：完整 Chat 工作流

- 独立 Chat Projects / 资料索引与引用；补原生图片传输、文档解析/OCR与格式/模型能力判断，不能仅沿用 @文件路径作为所有附件的实现。
- Search / Research、受控文件任务、Artifacts 库/版本/安全预览/导出。
- 显式长期记忆、项目隔离、编辑/删除/单次禁用。
- 验收：资料引用可追踪，恶意附件不能扩大工具权限，artifact 无 Node/IPC/默认联网能力；删除记忆后不再检索使用。

### P4：事件自动化与高级对齐

- API/GitHub triggers、PR/CI 状态与可选自动修复；自托管 runner fleet。
- Code Projects 协调多线程、Overview/Library/PR；跨会话消息与 Side chat。
- 产物分享/同步、移动端持续任务、系统 Quick Entry；Computer use/模拟器按平台单独评估。
- 验收：签名/幂等/限流/审批/审计完整，端到端故障恢复通过；明确哪些能力仍是 Beta。

产品界面可先露出两区及明确标注的规划入口，但在后端和验收前不能把按钮存在当作功能已完成。P2 优先于完整 Chat 高级产物，是因为用户特别要求 Routines + 远程开发；不是删除其余对齐目标。

## 6. 无法靠复刻 UI 获得的服务

- Claude 官方账户同步、Anthropic 云算力、付费额度、企业权限与官方 Connector 目录/授权服务，不会因为 fork pi-app 自动获得。
- Anthropic 的官方安全分类器、Design/Docs/Slides 编辑后端、发布/协作/托管存储不能假定有可供 Pi 调用的公开兼容接口。
- 本项目应实现同类能力，并保留 Pi 多模型优势；云端执行可以先用用户自己的 SSH runner，自建公共托管服务另立项目。
- 第三方 MCP/OAuth/搜索/文档转换服务各有凭证、费用与许可；明确用户自备还是产品内置。
- 目标是功能/工作流对齐，不冒用 Claude 品牌、官方登录或声称运行在 Anthropic 基础设施。

## 7. 前一轮 SSH 原型审查：不能直接作为正式版本

独立只读审查发现以下待解决问题（研究阶段保留记录，尚未继续修改功能代码）：

- 请求超时后 pending 被删除，但远端 bash 可能仍在执行。必须持久保留「结果未知」状态/活动锁直到确认结束，防止重试破坏性操作或无提示退出。
- UI 的单一 `working` 布尔值不能正确表达并发的 prompt、权限回答和 abort。正式 backend 需要操作级互斥/计数和可验证状态机。
- 修改连接显示名称也会清除 session-resume 指针；正式身份模型应只在远端目标/工作区真正变化时失效。
- 文件预览声称支持 256 KiB，但经 Pi bash RPC 返回的数据还受 bash 输出截断限制（审查指出约 50 KiB），JSON 转义又会放大体积。应使用独立文件传输/分块协议，不能以远端 helper 的读取上限冒充端到端可预览上限。

这进一步支持「统一 SSH backend + 专用文件协议 + 持久远端 Runner」的方案，而不是继续扩大独立 SSH 聊天原型。以上审查不等于已完成安全测试。

研究转向前启动的检查结果：原型构建成功；定向回归 10 个测试文件、69 个测试通过；IPC allowlist 双向契约测试 2 项通过；定向 lint 无错误但有 1 项无用 eslint-disable 警告。最近一次类型检查失败于 SSH profile 的 Zod 默认值输入/输出类型；之后已改过该处，但尚无新的全量 typecheck 通过证据。没有真实 SSH 主机端到端验证、GUI 实机验收或完整仓库测试通过声明。这些结果只说明部分原型检查，不证明本报告目标已经实现。

## 8. 官方来源（访问于 2026-10-17）

- S1 发布说明（含 2026-09-16 Chat/Cowork 合并）：https://support.claude.com/en/articles/12138966-release-notes
- S2 新统一对话体验与灰度边界：https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- S3 Code Desktop 总览、权限、面板、SSH、会话、Git/浏览器：https://code.claude.com/docs/en/desktop
- S4 Code Cloud Routines：https://code.claude.com/docs/en/routines
- S5 Code Local scheduled tasks：https://code.claude.com/docs/en/desktop-scheduled-tasks
- S6 Chat/Cowork Scheduled：https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- S7 Artifacts：https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- S8 Memory / 历史检索：https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- S9 Chat Projects：https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects
- S10 Research：https://support.claude.com/en/articles/11088861-use-research-on-claude
- S11 Customize：https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory
- S12 Code Projects / 协调多线程：https://code.claude.com/docs/en/claude-projects
- S13 macOS Quick Entry（已查到官方条目，未做系统实测）：https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac

本报告为产品/架构研究，不是完成功能的声明，也不替代真实 SSH、OS 级安全、凭证、数据隔离及无人值守执行的测试。
