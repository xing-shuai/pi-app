<div align="center">

<img src="resources/icon.svg" alt="pi Desktop" width="72" height="72" />

# pi Desktop · Chat / Code / Routines

基于 [justhil/pi-app](https://github.com/justhil/pi-app) 和 [pi](https://github.com/earendil-works/pi) Agent SDK 的桌面工作台。<br/>
日常聊天与代码执行分区，在同一个 Code 界面使用本机或 SSH 服务器，并运行本地计划任务。

[English](./README.md) · **简体中文** · [当前分支](https://github.com/xing-shuai/pi-app/tree/feat/desktop-chat-routines-ssh) · [MIT 许可证](./LICENSE)

</div>

> **开发快照：`feat/desktop-chat-routines-ssh`。** 这不是上游正式发行版，也不是 Claude 官方客户端。上游安装包和演示截图不代表本分支；体验当前改动请从源码启动，并先阅读[已知限制](#已知限制)。

## 当前分支做了什么

| 分区 / 能力 | 当前实现 | 权限与边界 |
|---|---|---|
| **Chat** | 独立历史、流式 Markdown、图片与文本附件、新会话模型选择，以及模型实际支持的思考等级。 | 普通 Chat 不提供模型工具，不发现 Code 扩展、MCP、Skills 或工作区指令。 |
| **Code** | 共用 Timeline、输入框、Files、Review/Git、终端；模型 / Effort、上下文与用量入口。 | 工具和终端使用所选机器账户的权限，不是 OS 沙箱。 |
| **Local / SSH** | 在同一个 Code 工作台切换执行位置；远端文件、Git、真实 PTY 和 Pi RPC 均在服务器运行。 | 未知、过期的远端身份明确拒绝，绝不静默回退到本机执行。 |
| **Scheduled tasks / Routines** | 手动、一次性、每日、工作日、每周计划，支持时区、持久运行历史、实时文本输出、取消与超时。 | 当前只在本机运行；必须保持应用开启、电脑唤醒。 |

界面采用深色参考布局、带位置筛选的统一历史侧栏，以及承载功能面板和终端控制的右侧 **Workspace** 抽屉。

### 模型、Effort 与用量

- 可用模型和思考等级来自所选运行时；不伪造模型、订阅身份或不受支持的 Effort 等级。
- 上下文占用是 Pi 估算，压缩后等情况下可能未知；它与服务商订阅额度是两类数据。
- 额度 / 余额查询支持兼容的 Codex OAuth 和 DeepSeek 已存储凭据。SSH 查询在远端完成，需要可验证的 Pi 安装和服务商配置。
- 不兼容的认证、服务商覆盖或桥接版本会显示**不可用**，不会显示假零余额，也不会借用桌面账户兜底。测试 fixture 不访问真实付费账户。

### 不选工程也能使用

本地 **No project** 使用私有临时工作区，首条发送需要时才分配。SSH **No project** 使用该服务器的真实 HOME，首次使用需明确确认信任；它不是一次性目录，也不是沙箱。

## 从源码启动

### 环境要求

- Node.js **22.19+**、npm。
- 可运行 Electron 的桌面环境；不要跳过安装脚本及原生依赖处理。
- 自行配置模型服务商账户。应用内置 Pi SDK **1.0.2**，不附带订阅或 API 额度。
- 使用 SSH 时，本机需 OpenSSH、已核验的主机指纹；远端需 POSIX 环境及兼容的 Node、Pi CLI，见 [SSH 配置](#ssh-配置)。

```bash
git clone --branch feat/desktop-chat-routines-ssh --single-branch https://github.com/xing-shuai/pi-app.git
cd pi-app
npm ci
npm run dev
```

### 启动前需要编译、构建吗？

| 命令 | 实际行为 |
|---|---|
| `npm ci` | 按锁文件安装依赖；`postinstall` 会处理原生依赖并构建应用。 |
| `npm run dev` | 自动编译 Main / Preload / helper，由 Vite 提供界面。**日常开发启动通常不用先单独执行 build。** |
| `npm run build` | 生成 `out/` 下的生产构建，不生成安装包。 |
| `npm start` / `npm run preview` | 打开已有生产构建；产物不存在或源码已变化时，先运行 `npm run build`。 |
| `npm run package` | 导出图标、生产构建，并用 electron-builder 生成安装包。 |

Linux 下建议用独立桌面配置试用，避免混用正式安装版的设置：

```bash
env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$PWD/.dev-config" npm run dev
```

`.dev-config/` 已被 Git 忽略。它隔离的是 Electron 应用数据，**不隔离** `~/.pi/agent` 中的 Pi 账户与凭据。从 Electron 终端或 Agent 环境启动时，清除 `ELECTRON_RUN_AS_NODE` 可避免 Electron 被当成 Node 运行。

## 第一次使用

1. **Chat**：无需选择代码目录即可新建聊天；首条消息前选择模型，已有 Chat 会话保持原模型。
2. **Code**：先选 **Local** 或 **SSH**，再选择目录或 **No project**；需要时确认信任。
3. **Workspace**：点击 Code 右边缘入口，在抽屉中打开 Files、Review 或终端；本机与 SSH 共用同一套界面。
4. **历史**：按执行位置或主机筛选统一列表；列出历史不会自动连接服务器。删除空闲会话需通过菜单并确认。
5. **计划任务**：新建本地 Routine，选择模型、权限、时区与计划，先用 **Run now** 查看实际输出。

## SSH 配置

1. 通过可信渠道核对服务器指纹，在本机 `known_hosts` 中登记。应用不会绕过主机密钥校验。
2. 在远端自行安装 Node **22.19+** 和兼容 Pi CLI，并在远端登录模型账户。当前按 Pi **1.0.2** RPC 开发兼容；桌面端不会自动安装，也不会复制本机模型凭据。
3. 在 Code 的位置选择器添加 SSH 别名或 `user@host`。Identity file 填**私钥路径**，不是 `.pub`；加密私钥先在 ssh-agent 中解锁。
4. 测试连接、浏览远端目录，核对准确主机与工作区后确认信任。连接成功不等于模型账户已就绪。

Linux/macOS 密码模式另需本机 `sshpass`。密码在应用内掩码弹窗输入，经临时匿名管道传输，不保存，不进入聊天、命令参数或环境变量；Windows 暂不支持这条密码路径。

```text
本地 Electron 界面
  └─ Main：身份校验与 IPC 路由
      ├─ Local Code → Pi SDK Worker → 本机文件 / Git / 终端
      └─ OpenSSH → 远端单文件 Node helper
                    ├─ 远端文件 / Git / 真实 PTY
                    └─ 远端 Pi RPC → 远端模型账户
```

不整仓同步，不在服务器安装常驻 daemon。信任工作区后，模型 / 命令发现可能按需启动隐藏探测进程；单纯选目录不会发送模型 prompt。

## Routines 与权限

- **Chat routine**：默认无工具；可按任务单独授权只读 Open-Meteo 天气工具。不因此开放普通 Chat 的工具，也不提供通用网页浏览。
- **只读 Code**：是受限工具策略，不是文件系统隔离；允许的读取工具仍可能访问账户有权限读取的其他路径。
- **Trusted Code**：必须明确授权，可用本机账户权限执行命令、修改文件。Routine 不加载交互 Code 的扩展或 MCP。
- 同一任务不重叠，全局最多并发 2 个；取消、超时后，必须等执行器实际结算才释放执行锁。
- **Completed** 仅表示执行成功结束，不代表任务目标已独立核验；外部副作用没有 exactly-once 保证。

## 数据与信任边界

| 数据 | 存储位置 / 归属 |
|---|---|
| 本地 Code 模型、认证、历史 | 所选本地 Pi 运行时的配置与会话目录，保留既有 CLI 集成。 |
| Chat 历史 | Electron 用户数据目录下独立的 `chat-workspaces/`。 |
| Routine 定义与运行账本 | Electron 用户数据目录下的 `routines/`。 |
| SSH Code 历史 | 远端 `~/.pi/desktop-code/sessions/<workspace-hash>/`，不自动导入任意 CLI 历史。 |
| 远端模型认证 | 远端 Pi 账户，不使用桌面账户兜底。 |

**信任不是沙箱。** Code 工具、扩展与终端可使用对应机器账户的权限，在所选目录外产生副作用。不要连接不可信主机或执行不可信指令；不要把凭据、本机配置和生成产物提交进仓库。

## 已知限制

- **尚未修复的回归**：SSH **No project** 模式的元数据探测可能以空白会话出现在历史中。不自动删除旧空记录；只明确删除你确实不需要的会话。
- 远端额度可用性取决于 SDK / CLI 身份、已存储认证和服务商配置；fixture 成功不等于真实账户已验收。
- 没有可靠离线 Runner、断线事件回放、退出桌面后继续运行的保证，也没有 SSH / WSL / 云端 Routines；中断操作不会自动重发。
- 远端 export / rewind / fork-at、完整 worktree 创建回收、图片上传及完整浏览器 / 桌面适配器透传尚未实现。
- Chat 知识型 Projects / RAG、长期记忆、Research、完整 Artifacts 尚未实现。
- 仓库保留上游 WSL、Android 和适配器代码，但不宣称已完整适配新增 Chat / Routines / SSH 路径；远端 macOS/BSD PTY 尚未经真实系统验收。

## 开发与文档

技术栈：Electron 43 · React 18 · TypeScript · Zustand · i18next · xterm.js · Pi SDK 1.0.2。

按改动范围执行必要检查，不因文档或单点 UI 修改重复跑整仓。可用命令包括 `npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run test:scripts` 和 `npm run test:e2e`；历史结果不代表当前分支全量测试已通过。

- [文档索引](./doc/README.md)
- [Chat / Code / Routines](./doc/guide/product-areas.zh-CN.md)
- [SSH 使用说明](./doc/guide/ssh-workspaces.zh-CN.md)
- [服务商额度](./doc/guide/provider-usage.zh-CN.md)
- [天气工具授权](./doc/guide/routines-weather.zh-CN.md)
- [适配器编写](./doc/adapter-authoring-guide.md)

部分专题文档仍描述较早迭代；本 README 说明当前分支边界，完整文档后续统一整理。`doc/assets/readme/` 中保留的是上游演示素材，不是本分支界面截图。

## 上游与许可证

基于 [justhil/pi-app](https://github.com/justhil/pi-app) 二次开发，保留原项目及贡献者署名。本分支维护于 [xing-shuai/pi-app](https://github.com/xing-shuai/pi-app)。

采用 [MIT](./LICENSE) 许可证；最小化引用的 pi-usage 额度归一化逻辑保留其[第三方许可证](./src/main/provider-usage/LICENSE.pi-usage)。
