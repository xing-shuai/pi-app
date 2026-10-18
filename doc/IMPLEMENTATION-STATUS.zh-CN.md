# 第一阶段实现与验证状态

日期：2026-10-17。基于 `justhil/pi-app` 0.7.5 / `c16900f`，功能仍分阶段实现，不等于完整 Claude Desktop 复刻。

## 已落地

- Chat / Code 顶层分区及共用设置；保留各自草稿、会话和后台工作。
- 独立 Chat 后端、私有会话存储、历史恢复、标题搜索/重命名/删除、流式 Markdown、图片/文本附件。
- Chat 不加载 Code tools、扩展、MCP 或上下文文件；SDK 显式禁用全部工具并检查实际工具集；模型强行生成未授权 tool call 也不能获得工具权限。
- Chat 历史快照/流事件使用单会话 revision 对齐；不把打开历史时收到的 delta 当成丢弃整份历史的理由。
- Code 复用既有工作台；隐藏时禁用其全局快捷键和原生浏览器覆盖层。Code SDK/扩展预热延迟到实际访问 Code。
- 执行目标的稳定身份与能力描述；第四轮 SSH 已复用 Code 的会话、文件、Git/Review 和真 PTY，不假装拥有尚未交付的离线 Runner。
- Local Routines 的定义/运行账本、手动/一次性/日/工作日/周计划、IANA 时区、DST 规则、漏跑合并/补偿、去重、全局/单任务并发限制、取消/超时/中断状态、运行历史。
- Chat / Read-only Code / Trusted Code 三类 routine 执行策略，不自动加载扩展/MCP；信任执行每次保存都需显式授权。
- Chat/Routines 纳入统一退出确认和有界清理；结果未知不释放真实执行锁，退出后未完成工作不自动重放。
- 完成/失败通知遵循既有通知偏好；产品内完成事件可在其他分区显示 toast。
- 新入口使用项目原有图标主题抽象，不绕过用户选择的图标主题。

## 验证记录

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| 所有改动/新增 TS、TSX、MJS 的 ESLint | 通过 |
| `npm run build` | 通过；有既有动态导入无法拆块的构建提示，不是失败 |
| 全仓 Vitest：`--maxWorkers=4 --testTimeout=20000 --reporter=dot` | 391 个测试文件通过，2 个跳过；2197 个测试通过，13 个跳过 |
| `npm run test:scripts` | 96 个脚本文件、277 项通过，0 失败；包含图标主题边界和统一退出生命周期 |
| 最后一次受影响模块定向回归 | 21 个测试文件、143 项通过；包含 Chat/Routines/图标/退出/分区隔离 |
| IPC channel 双向契约 + sandbox preload 产物检查 | 3 项通过 |
| Electron 桌面端到端：`e2e/product-areas.spec.ts` | 通过；最终主题入口构建后再次通过 |

默认全并发/5 秒预算的首次全量测试曾超时；4 workers、5 秒预算时仅 Markdown 流式性能用例超时。后续保留全部断言，以 4 workers / 20 秒预算完成全量验证，没有修改全局默认或删减测试来掩盖该情况。

Electron 冒烟使用真实 Electron 和真实内置 Pi SDK、临时 HOME/用户目录及 localhost 模拟模型，验证：

1. Chat 的工具定义为空，不加载投毒的全局扩展/SYSTEM 文件；
2. 模拟模型强行调用未授权工具不会创建测试标记文件；
3. Local Chat routine 实际执行并保留输出；
4. Read-only Code routine 实际读取测试仓库 README，但没有 bash/write/edit/powershell；
5. 页面重载后任务配置/结果仍可查看；
6. Code 工作台完整加载后切回 Chat，Code 的拆分快捷键不影响隐藏页面。

统一退出生命周期契约的 VM fixture 已补充 Chat/Routines runtime，验证不仅要等待 Code worker flush，还要等待产品运行时清理。图标导入改为项目的主题图标接口，未放宽图标边界检查。

过程中发现并修复了 sandbox preload 被验证模块间接引入 `zod` 导致 IPC 无法挂载的问题；新增产物检查确保 preload 只 require `electron`。测试环境也显式去除继承的 `ELECTRON_RUN_AS_NODE`。

未使用用户真实模型凭证或 SSH 服务器；没有宣称真实云服务/远程 Runner 已验收。没有生成安装包。

## 第二轮：用户截图布局与 SSH 密码（2026-10-17）

本轮以用户提供的深色 Chat/Code 截图替换第一版混合布局：左上角模式切换、全高侧栏、居中的 Chat 问候/输入区、底部 Code 输入区与上弹 Local/SSH 菜单。删除多余横条、提示卡、重复标题与内存状态页脚。颜色与主要矩形用截图取样/坐标检查，不复制用户的聊天标题、头像或 Pro 身份。

测得实际屏幕 DPR 为 1.5，增加 83.3% UI 密度校准，使有效比例为参考的 1.25。Electron 验证了 1308×1224 设计视口下 290px 侧栏、42px 标题栏、768×122px Chat 输入框，并以 1090×1020 / DPR 1.5 验证输入框为 640 DIP（物理 960px）、问候字体为 33 设计 px。详情见 `doc/REFERENCE-LAYOUT.zh-CN.md`。

SSH 新增 Linux/macOS 的临时密码认证（需要 sshpass）：仅将密码经匿名 FD3 管道发送给 sshpass，不进配置、命令行、环境变量或日志；主机校验不关闭。现有密钥连接可直接用「Use password instead…」切换，提交/取消/隐藏页面清空输入。Windows、任意 MFA/多重跳板密码交互不在此实现范围。

本轮检查记录：

- 类型检查、改动文件 ESLint、生产构建通过。
- 脚本契约 96 文件、277 项通过。
- 相关回归 26 文件、162 项通过；另一次包含窗口/自定义主题边界的回归 28 文件、165 项通过。
- 实际系统 sshpass + 临时假 ssh 的 TTY/RPC 集成通过，不连接用户主机、不修改真实账户或 known_hosts。
- 最后一次 Electron 端到端通过，新增认证方式选择、密码弹窗取消/重新打开为空、配置中无临时密码值，以及实际屏幕密度检查。
- 截图：`test-results/reference-chat-empty.png`、`reference-code-local-menu.png`、`reference-native-density.png`、`reference-ssh-password.png`；坐标记录为 `reference-geometry.json` / `reference-density.json`。

真实服务器密码登录仍需用户在应用弹窗中输入凭证验证；没有宣称已登录用户服务器。此轮也没有完成下列完整 Runner/云端/知识工作功能。

## 第三轮：二级界面字号与 SSH 127 诊断

- Settings、Routines、SSH 共用 16px 正文/标签、14px 辅助说明、12px 微标签、24px 页面标题、18px 分节标题与 14px 等宽技术文本；模型/思考弹窗及设置顶部栏一起调整。未整体放大窗口，保留首页参考布局与密度。
- Electron 实测首页和 Settings 导航均为 `16px`，字体族完全一致；设置标题 `24px`、说明 `14px`。输出 `test-results/reference-settings-type.png` / `reference-typography.json`。
- 修复把 SSH 退出 127 一律归因于本机缺 ssh 的错误。密码模式先验证/使用本机 SSH 绝对路径；远端启动按 shell、目录、Node、Pi、RPC 阶段给出固定安全诊断，默认 Pi/Node 增补常见用户目录，配置的 Node 目录加入 PATH。
- 增加真实系统 sshpass + 假 ssh + 受控远端启动体的退出 127 集成，确认“远端 Pi 不存在”不会误报本机客户端缺失；测试不连接用户服务器、不执行真实用户登录 profile。
- 本轮类型检查、改动文件 ESLint、构建、277 项脚本契约、Electron 端到端通过；相关回归 38 文件 / 217 项通过，早期 SSH 专项 8 文件 / 90 项通过。

仍需用户在应用中重输凭证验证实际服务器；远端确实没有 Pi/Node 时需要安装或填写其绝对路径。客户端不会把更准确的错误诊断宣称为服务器已连接成功。

## 第四轮：共享 Code 工作台与细节浮层

按用户补充的八张细节截图，删除产品路由里的独立 SSH 页面：远端和本地复用同一个 Code 组件、侧栏、Timeline、Composer、Files、Review/Git 和 Terminal，仅执行位置/初始目录不同。新增 Add SSH、远端目录浏览和显式信任弹窗；连接/浏览/取消不启动 Pi。

主进程在本地 IPC handler 前按虚拟工作区/会话/终端身份路由到一个仅依赖 Node 内置模块的远端 helper。已实现文件边界/限额、真实 Git 操作、Pi RPC 事件投影，以及 Linux 真 PTY。旧本地/其他主机终端保留后台输出，但不能在当前主机下获得输入。断线不自动回退到本机，不自动重发修改操作；退出清理纳入既有审批。

设置改为保留背景的浮层；账户菜单和 Composer 上下文环复用真实身份/统计。订阅限额、Pro 身份、组织/云账户数据不伪造；缺少服务端接口明确不可用。Worktree 创建选项尚未启用，偏好保存不等于功能已实现。

本轮新增核查：

- 类型检查、全部改动 TS/TSX ESLint、构建和 96 文件 / 277 项脚本契约通过。
- Node helper 专项 3 文件 / 19 项通过，Linux Python 标准库路径实际验证 PTY、三路 TTY、缩放、UTF-8、EOF/进程组清理；不把缺少依赖时的跳过当作执行成功。
- Electron 两项完整端到端通过：`product-areas.spec.ts` 与 `unified-ssh-code.spec.ts`。真实主进程/共享 Code 组件/Node helper/文件/Git/PTY 均参与，只有 SSH 传输对端与模型 RPC 使用临时 fixture。检查流式到结算、历史、用量、面板、Local 恢复、前台本机终端输入不串入后台 SSH。
- 核查修复了面板 catalog 在远端被错误拒绝、running/idle 提前返回丢 usage、初始列表与 Pi 会话创建之间的竞态；首次全仓回归暴露的旧原型断言及高亮冷加载等待已分别处理。完整单测重跑为 423 文件通过 / 2 跳过、2377 项通过 / 13 跳过（4 workers / 20 秒），0 失败。该全量结果之后的会话刷新竞态及安全连接诊断补丁，另有 13 文件 / 100 项受影响模块定向回归通过；不混算为同一次全量结果。最后一次类型检查、Lint、构建、277 项脚本与两项 Electron 端到端再次全部通过。
- 密码连接保留经安全处理的认证/主机校验/Node 启动阶段诊断，不再在上层一律覆盖为泛化错误；通用/外部异常仍不回显秘密。远端 helper 用显式 POSIX shell 包装，支持 home-relative Node 路径。
- 远端虚拟身份包含连接指纹；终端/扩展交互身份混用、旧连接异步结果、跨主机 Markdown/Review 路径拒绝。接续模型事件的文件操作不会回退到本机。

真实 SSH 认证、远端 Node/Pi 安装仍需用户在应用中验证，不能以 fixture 成功宣称真实服务器已验收。客户端不保存/重用密码，也不由助手重新使用用户凭据登录。自动测试不使用真实用户凭据或服务器。

## 第五轮：统一聊天字体、模型弹窗与连续信息流

- Chat 问候/正文与 Code 信息流统一 sans；正文 16px，代码保持 14px monospace。保留已有主页/侧栏/输入框几何和用户缩放，不再把 serif 正文当成必需差异。
- Chat 原生模型 select 替换为可搜索、按 provider 分组的主题弹窗，具备键盘导航、选中态、焦点恢复和缩放定位。仅新会话可选模型，历史会话不伪装支持运行中切换。
- Code 按连续正文穿插真实工具摘要显示，摘要可展开；失败、待审批/待交互状态不被折叠隐藏。没有为零工具 Chat 制造工具记录，没有生成假的图片缩略图。
- 排查 helper 握手前退出 0：强制 RPC stdin 保留/非后台化/无继承 RemoteCommand；host 模式不额外启动登录 shell。固定标记区分 JavaScript 未运行、输入关闭、协议损坏、加载失败与信号中断，EPIPE 不抢先吞掉具体原因。输入/输出 premature close 清理实际子进程；可选 PTY 探测每项限 1.5 秒。
- 使用真实 sshpass、临时密码挑战、生产启动命令和实际 bundled helper 的无网络集成，另用真实 `ssh -G` 解析冲突配置验证参数优先级，不读取用户 SSH 配置/凭据或登录真实服务器。

本轮已完成受影响模块 54 文件 / 383 项通过、1 文件 / 4 项跳过，以及类型检查、Lint、构建、277 项脚本检查。桌面新断言已验证正文与 UI 字体一致、自定义模型搜索/焦点、连续工具记录与展开。最后一次显示标题尺寸调整后，Chat 17 项回归、类型检查/Lint/构建/277 项脚本与两项 Electron 端到端再次全部通过。截图为 `test-results/reference-chat-model-popover.png`、`reference-continuous-code-stream.png`、`product-chat.png`。不把此前全仓 2377 项结果算作本轮新增改动的全量验证。

## 第六轮：目录选择、思考设置、滚动与本地首条消息

- 移除 Code 右上 What’s new 和侧栏空工程提示卡；保留底部项目位置入口。
- 消息/工具结果、代码块、表格与模型选项支持软换行；滚动拇指细化为 4px，保留透明拖动热区/键盘操作，不改 xterm 单元格与编辑器输入。带独立固定高度行号的旧大源码 fallback 仍保留横向滚动，避免错配行号；不宣称所有源码预览均已支持软换行。
- Chat 新建/空闲会话支持 SDK 实际能力内的思考强度，保存请求/有效级别；模型不支持的级别不显示，运行期间不能更改，不影响 Code 或全局默认。
- 本地工程与 Routines 的目录按钮使用应用内选择器，支持路径/Go、面包屑、主页/根目录/最近、隐藏目录、规范路径确认及取消。不再从工程 UI 调用系统目录窗口；新工程仍需显式信任。
- 修复本地 `EPHEMERAL_SANDBOX_DRAFT` 残留：显式项目选择、真实会话创建/绑定会退出临时草稿模式；预览/后台预热不解除草稿保护，创建失败不伪装成功。发送失败保留输入并给出经过处理的具体原因。

验证：类型检查、全部改动 TS/TSX ESLint、构建、19 文件 / 135 项相关回归、96 文件 / 277 项脚本、4 项 Electron 端到端全部通过。新增桌面测试用真实内置 SDK/临时工程与本地模拟服务：选目录后首条消息实际读取 README；拦截系统 picker 并确认调用为 0；实际模型请求含 `reasoning_effort: high`，空闲改 Low 后 metadata/重载仍为 Low；长段落/代码无横向溢出、滚动条计算宽度 4px。没有使用用户真实模型凭据或 SSH 主机。沿用之前全仓记录而未把本轮定向检查伪称全仓重跑。

截图：`test-results/reference-local-folder-picker.png`、`reference-local-first-message.png`、`reference-chat-thinking-wrap.png`。

## 第七轮：去重面板、真实额度与 Node 运行时验证

- 工作台只保留主区域顶部的一组面板控制，删除右侧重复 tabs；打开/关闭/切换仍走原逻辑，项目首页打开面板时也显示唯一控制组。
- 用量弹窗增加真实 provider 查询：Codex OAuth 订阅窗口/剩余比例/重置/credits，DeepSeek 分币种 API 余额。取数/归一化参考 MIT `pi-usage`，不加载整个扩展。查询运行在当前已绑定会话的 worker，使用该会话实际 ModelRuntime；只返回 DTO，不把凭据跨到界面，也不另建默认账户运行时。官方 origin/账户前后核对、有界响应/超时、按账户盐化缓存、手动 Refresh。其他 provider/SSH/WSL 暂明确不支持，不能伪造余额。
- 修复默认 PATH Node 不经校验抢占兼容运行时：验证精确成功标记、成功退出和 Node ≥22.19，探测 stdin 独立且有界；兼容时保留默认，不兼容时尝试 Pi-managed/常见/NVM 兼容候选。显式路径不合格不偷偷替换。
- 远端导入异常与初始化异常分开；HOME 不存在/不可进入/不是目录均拒绝。语法、模块、权限、OS 资源错误仅返回固定允许类别与经过数值校验的版本，不回显错误文本/路径/凭据。构建强制 ssh-host 为单文件且只依赖 Node 内置模块。异步初始化期间提前安装流错误/关闭处理，避免漏清理。

验证：类型检查、全部改动源码 ESLint、25 文件 / 202 项受影响回归、构建、277 项脚本及 4 项 Electron 桌面端到端全部通过。端到端检查无重复导航，以及真实本地 SDK 会话经生产 quota bridge 返回 mock provider 的明确不支持（不是未接线 runtime facade）。Codex/DeepSeek 官方响应、真实 SDK 合成 OAuth、账户切换/重启缓存、header/origin/超时/DTO 防泄漏使用注入 fetch 单元/集成验证；未访问真实付费账户。真实 SSH 主机仍需用户重试，不用客户端模拟成功替代服务器验收。

说明：`doc/guide/provider-usage.zh-CN.md`。

## 第八轮：补充参考图的菜单、任务页与 tooltip

- Code 模型菜单改为真实当前/最近/可用常用项，More models 侧菜单支持搜索、provider 分组、分页、翻转/钳制定位和两级 Esc。保留异步切换确认、跨会话/跨卸载防竞争，不硬编码截图型号、Default、credits 权限。
- Effort 弹层 264px，实际强度、Faster/Smarter、24px 轨道和支持级别刻度，保留拖动提交、键盘、绑定/回滚；不虚构 Recommended。Chat 原有独立模型/思考设置不改成 Code IPC。
- Scheduled 改为 Yours/Templates、搜索/筛选/排序、新建类型菜单和响应式卡片；详情为双栏属性/指令/历史；真实输出使用 Runs 侧栏。保留本地生命周期、真实状态、权限授权与未知结果锁，不加假的云执行/PR/交互式会话。
- 主菜单为 16px Sans / 36px 行高；方向键/Home/End/Tab/Esc 和焦点恢复。常用导航/窗口/输入栏/位置/分支/用量图标使用 `data-app-tooltip` +原有可访问名字。全局与 composer 提示统一内容自适应暗色 14px 气泡，修正 CSS zoom 定位和移除/滚动/点击/overlay 关闭；不劫持全部 title，不在 NativeBrowserView 重叠区伪装 overlay。
- 活动摘要保持轻量；仅真实最终回合文件改动用边框卡片及原有 Review/文件/增删统计，不冒充已实现 Undo/PR。

验证：16 文件 / 126 项受影响回归、额外 tooltip/菜单交互 53 项通过，真实 Chrome 在 5/6 zoom、DPR 1/2 测量 tooltip；类型检查、所有改动源码 ESLint、构建、277 项脚本、4 项 Electron 桌面测试通过。文件卡片最后样式编入后，相关回归/构建/277 项脚本/4 项桌面再次通过。此轮不是全仓单测重跑。

截图位于 `test-results/`：`reference-main-menu-tooltip.png`、`reference-main-menu.png`、`reference-model-more-menu.png`、`reference-effort-slider.png`、`reference-scheduled-cards.png`、`reference-scheduled-details.png`、`reference-scheduled-runs.png`。截图数据为隔离临时模型/任务 fixtures，不复制用户参考图的私人内容或订阅身份。

## 第九轮：界面减负、统一会话与显式天气能力

- 精确取消可选 remote-pi Agent name 初始化输入，不自动命名/启用 relay，不自动回答其他权限确认。会话重置的对话去重状态改为独立叶模块同步清理，消除异步导入交互通道的循环初始化与晚到重置。兼容旧扩展把 `{defaultValue}` 当 placeholder 的格式，修复 `[object Object]`；SSH helper 在初始 RPC 绑定前同样取消该可选向导，避免隐藏输入阻塞启动。
- 删除聊天上方的功能栏；右边缘按钮打开 Workspace 抽屉，功能 Tabs、终端入口、刷新和关闭只在抽屉显示，仍使用原来的真实面板。原由旧工程树顺带加载的本地最近目录改为工作台自行读取，切到 SSH 后忽略晚到的本地目录回复；卸载时清理延迟的模型菜单预载定时器。
- 用量/能力弹层改为 360px、最高 420px、4px 透明轨道细滚动条；保留关键真实数据，技术/费用明细按需展开。精确 decimal 不转浮点，取舍非零小数才标 `≈`；Browser setup 直接打开 Capabilities / Right panels，不擅自启用配置。
- Code 侧栏合并已知 Local/SSH 会话，使用主题化位置过滤菜单和搜索，不再按工程/Worktree 分组。只隐藏可证明为空且未被用户采用的工具预建 SSH 会话，不删历史；列举不自动连接、认证或创建 worker。缓存/数量限制见会话指南。
- 重新核验点击行的工程/主机身份再打开；取消握手仍保持 SSH 意图与执行锁，必须显式选择 Local。旧连接回复不能覆盖新前台，旧操作结束不能减掉新操作的 busy 状态。服务端先过滤/搜索再截断，并轮转分配主机来源槽位。
- Routine 可显式授权只读 Open-Meteo 天气工具，旧任务仍默认关闭；普通 Chat 继续零工具，Code 权限不变。仅固定 HTTPS 端点，有超时/大小/次数限制及取消清理；不授予 shell、文件或通用网页访问。Completed 明确只表示执行完成，不独立验证目标成功。

本轮最终整合链路：类型检查、`src`/`packages` 全部源码 ESLint（0 错误、2 条既有警告）、33 项关键回归、构建、96 文件 / 277 项脚本及 4 项 Electron 桌面端到端通过。另有紧凑菜单 39 项回归及真实 Chrome 的 8 组视口/zoom/DPR 检查通过。全仓最终 Vitest：457 文件通过、2 文件跳过；2663 项通过、13 项跳过，退出码 0、无未处理错误。此前全部断言通过但有卸载异步错误的轮次不算全仓通过。全仓使用 4 workers / 20 秒预算，没有降低或删除断言。

桌面端到端使用真实内置 SDK/生产 SSH helper/文件/Git/PTY，验证可选 Agent 命名被取消、实际首条消息、同一 Code 工作台、Local/SSH 历史互切与过滤、工具预建空会话不入列、天气权限通过编辑页保存/撤销、完成目标免责声明。SSH 对端、模型和天气响应为受控测试数据；未访问用户真实 SSH、计费账户或公共天气端点。说明：`doc/guide/session-catalog.zh-CN.md`、`doc/guide/routines-weather.zh-CN.md`。

## 第十轮：历史额度、空会话删除、实时输出与切换动效

- 修复只读重载历史没有 worker 因而查不到订阅额度：优先精确已有 worker，否则仅解析已授权历史当前分支的实际模型及该 provider 的只读凭据；不启动会话/worker/模型回合，不发现扩展，不借默认/环境/其他账户，不执行凭据命令或写 auth。缺失/过期凭据、无法验证的模型与 SSH/WSL 仍明确拒绝。
- 修复探测会话提前落盘、内部历史读取误采用、pending-bind 清理丢失已选会话，以及 probe 丢失复用身份造成的空会话增长。新的 utility 不预建 JSONL，以私有 purpose sidecar 记录来源，不自动清空旧历史。
- 每行 `⋯` / 右键可明确确认删除精确空闲 SSH 历史；不为删除连接服务器或中止活动任务。文件/ID/私有权限/owner/单链接/sidecar/替换与在途操作校验失败时拒绝；成功后仅清理该文件缓存与映射。当前视图回同一执行位置的空白页，晚到结果不清空新会话。
- Routine 原有 SDK text_delta 现在以最多 10 次/秒的完整 run snapshot 发送到现有频道；立即打开手动运行视图，显示等待/接收中的实际输出。旧列表与 dispatch 回复不能盖掉新流；浏览旧输出时不强制跟随或抢焦点。最终输出持久化及 unknown/取消结算锁保持。
- Chat/Code/Routines 切换采用 160ms 交叉淡化，旧页面立即 inert/aria-hidden、Code 快捷键立即停用；会话/功能 tab 在原 DOM 上轻淡入，不随 token 重播，不平移/缩放终端或 NativeBrowserView 坐标。菜单、对话框和任务视图加入短淡入，遵循系统减少动态效果偏好。

按用户要求仅做必要定向验证：额度 6 文件/86 项；Routine 流式相关 2 文件/12 项（按名称过滤）；远端后端/helper 6 文件/30 项（按名称过滤）及菜单/列表 2 文件/12 项；动画/分区隔离 2 文件/12 项。整合类型检查、改动源码 lint、15 项整合定向检查及构建通过；单个包含精确远端删除、当前视图回同一 SSH 工程、文件真正移除且不回退本机的隔离 Electron 场景通过（18.8 秒）。首次桌面检查只因测试把现有 OK 按钮误写为 Confirm 停止；修正定位后只重跑该场景。**本轮没有重跑全仓 Vitest、277 项脚本或四项桌面套件**。未读取用户真实凭据、查询真实账户或连接用户 SSH。

## 第十一轮：远端模型空菜单与目录校验诊断

最新开发日志确认 `model.list` 与 `session.list` 都被 `unsafe_session_directory` 拒绝，不能把截图解释成服务器没有模型。更新 helper 后仅提取固定安全码，进一步确认是 `unsafe_session_directory:pi-config:write-access:0775`：全局 Pi 目录组可写，被新增保护阻止；并未修改用户远端权限。需用户决定是否保留全局共享写入布局，不能直接宣称模型已恢复。

- 修复已归属当前用户的应用私有目录在收紧到 0700 前就因旧模式被拒绝的问题；通过 O_DIRECTORY/O_NOFOLLOW 打开的校验描述符 chmod，并复核 inode/owner。非目录、符号链接、他人拥有或校验中被替换的目录仍拒绝。全局 `~/.pi` 不改权限，其原有 owner/写权限保护仍在。
- 错误增加固定的目录层级、原因及八进制模式，不回显用户名、私有路径或远端异常内容。模型缓存保留安全错误状态，权限类失败不再无意义自动重试；菜单显示真实失败原因及 Retry，不伪装成 No models available，不回退本机模型，切主机即清旧错误。
- 必要验证：3 文件中 7 个相关用例通过（其余 25 个按名称过滤未执行）、改动源码 lint、类型检查及构建通过；未跑全仓/脚本/桌面套件。测试只操作临时目录与注入 IPC，没有连接用户服务器或更改其目录。真实模型恢复需用户重新连接加载新 helper 后确认；若全局 Pi 目录仍被拒绝，依据新提示处理，不擅自放宽保护。

## 尚未交付

- SSH 离线驻留、协议升级/远程安装管理与重连事件回放；完整 worktree 创建/回收、部分会话管理和桌面扩展/浏览器透传；
- 关闭应用/电脑后独立调度的 local daemon、SSH daemon、自托管或公共 Cloud Runner；
- API/Webhook/GitHub triggers；
- 完整 Chat Projects/RAG、Memory、Research、Artifacts/文档生成；
- Code 一等 Plan/权限审批模式与完整 worktree 生命周期、PR/CI 自动化、Computer use 等高级对齐。

特别注意：当前 Local Routines 要求应用开启、电脑唤醒；只读工具不等于根目录/OS 沙箱；信任执行拥有本机用户权限。

## 启动与文件

在仓库根目录：

```bash
env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$PWD/.dev-config" npm run dev
```

此 Linux 命令隔离试用设置，避免与当前安装版共享 Electron userData；仍使用本机 Pi 的模型/登录配置。

使用说明：`doc/guide/product-areas.zh-CN.md`。
完整目标与原始差距：`doc/CLAUDE-DESKTOP-ALIGNMENT.zh-CN.md`。
自动截图：`test-results/product-chat.png`、`product-code.png`、`product-routines.png`（生成文件，不纳入 Git）。
