# Chat / Code / Routines：第一阶段实现

此分支按 `doc/CLAUDE-DESKTOP-ALIGNMENT.zh-CN.md` 分阶段对齐 Claude Desktop。第二轮布局以用户提供的 Chat/Code 深色截图为准（见 `doc/REFERENCE-LAYOUT.zh-CN.md`），首次升级采用该深色基准；随后仍可修改外观设置。当前交付不等于全部功能已经复刻。

## 启动

```bash
npm ci
npm run dev
```

需要 Node.js ≥22.19，Electron 与 better-sqlite3 的安装/原生构建步骤不能被跳过。Linux 建议隔离试用设置：

```bash
env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$PWD/.dev-config" npm run dev
```

如果从 Electron/Agent 的终端启动，注意清除继承的 `ELECTRON_RUN_AS_NODE`，否则 Electron 会按 Node 模式运行而无法创建桌面窗口。

模型沿用本机 Pi 的模型/登录配置；支持 `PI_CODING_AGENT_DIR`。Chat 与本地 Routines 使用应用自带的 Pi SDK 和本机凭证，不读取 WSL 内的账户配置。Code 仍保留原来的 SDK/WSL 设置。

## 顶层分区

- **Chat**：不要求选择代码目录。独立会话列表、标题搜索、重命名/删除、Markdown 流式回复、图片/文本附件、停止生成。
- **Code**：同一个会话、Timeline、Composer、Files、Review/Git 与 Terminal 工作台，初始化时从 Local / SSH 选择执行位置。SSH 不跳到独立 Remote 页面；部分本地专属高级能力在远端明确不可用。
- **Routines**：两区共用的自动化入口，当前仅支持 Local 执行。
- **设置**：账户菜单打开共用浮层，保留背景工作台；Usage 展示实际统计。上下文环使用现有估算，订阅/每周限额没有接口时明确不可用，不伪造 Claude Pro 数据。

新用户默认进入 Chat；已有 currentProject 的用户首次升级默认进入 Code。后续记住主动选择的分区。切换分区保留草稿和已运行会话；隐藏的 Code 页面不响应终端快捷键，不应因在 Chat 按 Ctrl+` 就创建本地终端。

## Chat 的权限边界

Chat 通过独立后端创建会话，使用自定义资源加载器，不自动加载：

- read/bash/write/edit 等代码工具；
- 用户或项目扩展、MCP、Skills、模板；
- AGENTS.md、CLAUDE.md、SYSTEM.md 等工作区上下文。

这是工具/资源层隔离，不只是隐藏 Code 按钮，但不是独立 OS 进程/容器沙箱。消息不会路由给原 Code worker，Chat 存储在应用的独立目录，不混入已有 Code 项目会话。模型可以处理用户主动提供的文字/图片，但没有自主读写磁盘或运行 shell 的工具。本机凭证/模型配置仍属于可信配置，SDK 的凭证辅助命令等机制不受「零模型工具」保证覆盖。

图片传给 SDK 的 `options.images`，不是一个让模型自行读取的本地路径。当前支持 PNG/JPEG/WebP/GIF，每次最多 4 个附件、单图片最多 4 MiB、图片合计最多 12 MiB；文本/代码文件最多 256 KiB，消息/文本附件合计最多 200,000 字符。PDF/Office、音视频转录、OCR 还没有接入，不能把文件图标当作已实现解析。

Chat 在新建会话时选择模型；已有会话的模型保持固定。思考强度可在新会话中预选，也可在已有空闲会话中修改并保存，仅列出当前模型由 SDK 支持的级别，回复期间禁用。不支持思考的模型只提供 Off；界面显示实际恢复的有效级别，不修改 Code 或全局默认。跨模型继续现有会话的交互留待后续实现。模型目录在首次使用时缓存，修改自定义模型配置后需重启应用。自动压缩与重试关闭，超长会话可能触及模型上下文上限。默认无联网搜索和外部工具；模型的回答不代表它已查过实时资料。

## Routines

运行后会立即打开当前输出视图；真实 assistant 文本最多每 100ms 合并显示，不必等到完成。没有文本时显示等待输出，取消/超时仍等待执行器实际结算。阅读较早内容时不会强制滚到底部；主动选择旧记录或任务详情后，新运行不会抢走该视图。

### 配置

保存名称、描述、指令、Chat/Code 类型、模型、权限、启停状态及计划：

- 仅手动；
- 一次性指定时间；
- 每天、工作日、每周，支持 IANA 时区。

Code 任务还需选择**本机绝对路径**。当前不能选择 SSH/WSL/Cloud 目标，不把 Code 当前环境路径悄悄解释成本机路径。

### 权限

- **Chat routine**：默认无工具，与 Code 工具隔离。可在编辑页显式勾选并保存只读 Open-Meteo 天气查询；旧任务默认关闭，不从指令自动授权。它不开放 shell、文件、通用网页、扩展或 MCP，普通 Chat 对话仍零工具。见[天气授权说明](./routines-weather.zh-CN.md)。
- **只读代码分析**：禁止修改工具与 shell；read/grep/find/ls 仍可读取当前用户有权访问的项目外路径。这是工具策略而非文件系统沙箱，也不是可任意执行命令的 Plan 模式。
- **信任执行**：明确勾选授权后才保存；拥有本机用户的代码工具权限。这不是 OS/container 沙箱，命令可能读取敏感内容或修改工作区之外的文件。只在信任的仓库/任务上启用。

任务不自动加载日常交互使用的扩展/MCP，不会为了无人值守而自动同意扩展权限弹窗。

### 调度与恢复

- 任务定义和运行记录独立持久化，不使用可丢弃的会话索引作为任务账本。
- **必须保持应用进程运行、电脑醒着**。没有承诺退出应用、关机或 SSH 断线后仍能运行。
- 唤醒/启动时最多补最近七天内的一次漏跑，不批量重放。
- 单任务不重叠，全局并发上限为 2；运行记录标明跳过、失败、中断和取消原因。
- 已经执行过的定时触发有去重身份；进程退出前未完成的任务按中断处理，不直接重发可能产生副作用的命令。
- 可 Run now、暂停/启用、编辑、删除，查看持久输出和每次状态。运行中的任务先取消并等待结束后再编辑/删除。删除任务保留有界审计历史，不删除项目文件；全局最多保留 100 条运行记录，单次账本输出最多 250 KiB。
- 已完成/失败任务会根据现有应用通知设置提醒；其他分区中的完成结果可显示 toast。执行中的输出目前主要在结束后汇总，不等同于逐行实时终端。
- 夏令时不存在的本地时刻跳过，重复时刻取首次；计划按 IANA 时区计算，约每 30 秒检查，不保证准秒触发。
- 单次执行默认最多 10 分钟；高级配置可通过 `PI_DESKTOP_ROUTINE_TIMEOUT_MS` 设置全局时限（毫秒，最多 24 小时）。超时先请求停止，实际锁要等执行器退出才释放。
- 任务超时/断线的「结果未知」不能当成执行失败然后盲目重试。任意外部副作用不提供 exactly-once 保证。

### 适用示例

- 每天只读审阅项目并生成风险清单；
- 每周生成复盘问题提纲（没有连接器时不能声称读过日历/邮件）；
- 对信任的测试仓库显式授权后运行测试并汇总结果。

## SSH 的当前状态

从 **Local → SSH** 添加/选择主机，在远端目录选择器中 Go / Select folder，核对实际主机与规范路径后 Trust workspace。连接、浏览和取消信任不启动 Pi；批准后才使用远端 Pi/模型凭证。Linux/macOS 支持临时密码（需本机 sshpass），不保存密码；仍严格验证主机指纹。

同一个 Code 工作台已接入远端会话/模型、文件读/搜索/预览/新建/重命名、Git 状态/diff/hunks/分支与真实 PTY。终端标签、profiles 和异步输入按工作区隔离，不能把旧本地终端显示成远端终端。文件预览不再经 bash 文本拼接，文本上限 1 MiB；远端路径不能交给本机默认应用。

已支持连接状态下通过每行 `⋯` 确认删除精确空闲 SSH 历史，活动执行不会为删除而被中止；旧空白记录不自动清理。会话导出/rewind、完整 worktree 创建回收、桌面插件/浏览器透传、远端图片粘贴、离线驻留、事件回放和 SSH Routines 仍未交付。退出/断线不承诺远端任务继续或副作用可撤销。具体边界、依赖和排错见 [SSH 使用说明](./ssh-workspaces.zh-CN.md)。

## 尚未实现的对齐项

Chat 知识型 Projects、长期记忆、全文/语义历史搜索、Research、完整 Artifacts/文档生成；Code 的统一权限模式、真正受限的 Plan、完整 Worktree 创建/回收；SSH 离线 Runner；Cloud Routines；Webhook/GitHub triggers；账号同步、官方托管 Connector 服务、Computer use。

上述能力不会以可点击但不工作的入口伪装完成。后续实现以调研文档中的验收矩阵为准。

## 检查

```bash
npm run typecheck
npm run test:unit -- --maxWorkers=4 --testTimeout=20000
npm run build
npm run test:scripts
node --test scripts/tests/ipc-channel-sync.test.mjs scripts/tests/preload-product-sandbox.test.mjs
npx playwright test e2e/product-areas.spec.ts
```

新增桌面冒烟使用临时 HOME/用户数据目录、回环 mock 模型服务，不使用用户真实模型凭证或 SSH 主机。它检查 Chat 工具隔离、拒绝模型强行调用未授权工具、Local Routines 实际运行/持久化，以及 Code 分区入口。测试是否通过以交付检查结果为准。
