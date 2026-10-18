# SSH：同一个 Code 工作台，不是独立 Remote 页面

入口：**Code → 输入框上方的 Local → SSH**。选择主机、浏览远端目录并确认信任后，继续使用原来的会话侧栏、Timeline、Composer、Files、Review/Git 和 Terminal。切回 Local 不停止后台会话，也不把远端路径改成本机路径。

## 连接与目录选择

1. **Add SSH connection…** 填写友好名称、`user@hostname` 或 SSH config 别名、可选端口/私钥路径。
2. Authentication 选择 Key / SSH Agent 或 Password。Advanced runtime paths 可填写远端 Pi、Node 的可执行文件绝对路径；不是任意 shell 命令。
3. **Test connection** 只验证 SSH 和远端 Node helper，不启动 Pi，也不代表模型已经登录。
4. 添加/选择连接后，在 **Select remote folder** 中输入远端路径并 Go，或逐层进入目录，再 Select folder。
5. 核对信任弹窗中的实际 `user@host:port` 与规范化路径，再 Trust workspace。取消不会启动 Pi；已批准的同主机/同规范目录可恢复。

连接主机与选择项目分开；旧配置的 cwd 仅用于建议初始目录。Worktree folder 目前仅保存偏好，**自动为新会话创建/回收 worktree 尚未启用**；可把已有 worktree 选为普通项目目录。

## 认证与主机指纹

保留系统 OpenSSH、`~/.ssh/config`、IdentityFile、ProxyJump 和 SSH Agent。加密私钥请先在 Agent 中解锁。Linux/macOS 密码模式另需本机 `sshpass`；Windows 暂不支持此密码路径。

密码只在独立掩码弹窗中输入，取消/提交即清空，不发送到聊天。经 `sshpass -d 3` 的专用匿名 FD3 传递，不写入 argv、环境变量、配置、会话或日志，不传给远端 Node helper。JavaScript 字符串无法可靠擦除，不落盘不等于从未进入内存。不支持任意 MFA/OTP、多个跳板各用不同密码的交互流程。

RPC 连接强制 `StdinNull=no`、`ForkAfterAuthentication=no`、`RemoteCommand=none`，避免 SSH 别名配置丢弃标准输入或后台化；主机、端口、密钥/Agent、跳板等设置仍沿用系统 SSH。helper 使用受控 `/bin/sh -c`，不额外启动登录 shell，以免登录脚本消费握手数据。服务器自己的 forced command/账户 shell 行为仍可能影响连接。

两种认证都保持 **StrictHostKeyChecking=yes**。未知或变更的主机密钥不会自动批准。首次请在本机终端执行 `ssh dev-server`，通过可信渠道核对 SHA256 指纹后加入 known_hosts；不要为解决连接错误绕过校验。应用禁用 Agent/X11/配置端口转发、LocalCommand 与复用，不复制本机模型凭证到远端。

## 远端运行时

支持提供 POSIX shell 的 Linux/macOS 服务器；不支持原生 Windows 服务器 shell。远端 helper 使用经验证的 Node ≥22.19，并安装兼容本仓库 Pi 1.0.2 RPC 的版本、在远端配置模型登录：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
cd /absolute/path/to/project
pi
# 在远端 Pi 中 /login 或按 Pi 文档配置模型。
```

连接和选目录只启动一个应用打包的 Node helper；首次信任工作区后的会话/模型操作才启动远端 `pi --mode rpc`。默认 Node 先验证 PATH 中的实际版本和执行结果；不兼容时检查 pi-node/current、常见目录和 NVM 兼容版本，不再让旧 Node 抢先覆盖新运行时。探测使用独立的空 stdin、固定成功标记和有界等待。显式 Node 路径不合格时明确拒绝，不偷偷切换。默认 Pi 查找 PATH、`~/.local/bin`、pi-node 等常见目录；显式无效路径不会偷偷替换为其他 Pi。Node 不在登录 PATH 时填写绝对路径。客户端不会未经确认自动安装软件。

**握手前退出 0 也不代表连接成功。** 客户端分别识别 Node 是否执行 JavaScript、helper 输入是否提前结束、协议字节是否被修改、模块导入失败或远端信号中断。模块导入与 host 初始化不再共用一个错误；缺失/不可访问/非目录的 HOME 单独说明。语法、内置模块、权限和 OS 资源故障只按固定允许类别返回，并显示经过数值校验的 Node 版本。诊断仅用固定 stderr 标记，不回显输入、密码或原始认证日志。EPIPE 会有界等待随后到达的具体阶段信息，避免抢先覆盖真正原因；输入/输出异常关闭都会清理子进程。可选 PTY 探测每项最多 1.5 秒，不占满 30 秒握手预算。

**127 不等于本机缺 SSH。** 本机 OpenSSH 会先单独验证；后续可能是远端 Node/Pi、shebang 或 PATH 问题。用菜单的编辑按钮进入 Advanced runtime paths。密码模式不输出原始认证 stderr，因此部分启动错误只给出安全的阶段提示；SSH 登录、Node 可用和 Pi/模型就绪是三件事。

## 已接入的共享能力

项目首页与会话不再在聊天上方放功能栏。点击聊天区域右边缘的 **Open workspace panel**，在右侧 Workspace 抽屉中选择 Files、Review 等功能 Tab；终端入口、刷新和关闭也位于抽屉内。仍可用 **Ctrl+K → Open Files panel**（macOS 使用对应 Command 快捷键）。Local / SSH 使用同一套入口。

- 会话列表、历史/树、流式文本与思考、工具结果、停止/队列、模型/思考切换，以及支持的 Pi 扩展交互；不会自动批准扩展请求。每行 `⋯ → Delete` 可在确认后删除精确空闲历史；不清空其他会话，不为删除自动连接或中止活动任务。
- 同一个 Files 面板的目录浏览、搜索、文本/图片预览、新建与重命名。文本最多 1 MiB，图片最多 8 MiB。远端文件链接只在该工作区 Files 中打开；不在本机文件管理器/默认应用中打开远端路径。
- 同一个 Review/Git 面板的真实状态、diff、stage/unstage hunks、分支列表与切换；读取已有 worktree 列表。
- 同一个 Terminal drawer 的真实远端 PTY。优先使用 Linux util-linux / BSD `script`；缺少时可用远端 Python 3 标准库 `pty`，两种方式都是真实 PTY，并需要远端 shell、`stty` 与 `tty`。没有自动安装，没有管道假终端或本机 shell 回退。Python 兼容路径已在 Linux 实测；macOS/BSD 尚未经真实系统验收。
- 终端标签、profiles、输入和异步创建结果按工作区身份隔离，保留后台输出。即使两台主机的原生目录相同也不会混用。

## 路由、信任与生命周期

客户端使用 `/__pi_ssh__/…` 的服务端签发虚拟身份，原生路径仅用于显示。主进程在本地 IPC handler/文件操作之前分流；未知、混合或过期远端身份拒绝，不静默执行本机操作。纯文件/Git helper 操作限制在已注册根目录内，检查路径、符号链接、目标父目录与输入大小。

**信任不等于 OS 沙箱。** Pi 的代码工具、扩展和用户终端命令具有远端账户权限，可以产生工作区外副作用；只连接信任的主机/仓库。窄文件 API 的边界不能推导为任意代码执行也被隔离，更不能抵抗恶意远端 OS 或所有并发文件系统变化。

本客户端会话存储于远端 `~/.pi/desktop-code/sessions/<workspace-hash>/`（私有目录/文件），不任意打开其他会话文件，也不自动导入原 CLI 历史。最多四个 SSH 连接、每个 helper 最多四个 Pi runtime、八个 PTY；没有后台无限扩容或静默驱逐活动任务。

退出先经过统一审批，再有界 abort/flush/清理。`agent_settled` 才代表回合结束，不把 prompt ACK 或 `agent_end` 当作完成。超时/断线可能结果未知，不自动重发修改操作。

## 明确未交付

- 离线驻留 daemon、断线事件回放、端口转发、关闭桌面后继续执行的保证；故意脱离进程的远端任务也不保证可终止。
- SSH Routines、云端 Runner、远程桌面插件适配器/浏览器与资源配置的完整透传。
- clone/export、rewind/checkpoints、fork-at 等未支持的 RPC 功能；明确拒绝，不改用本机文件系统。
- 剪贴板图片上传到远端、直接用本机应用打开远端二进制文件、完整 worktree 生命周期。

真实主机/密码仍需用户在应用中验证。自动测试使用临时 HOME、模拟 SSH/Pi 对端和真实 helper/文件/Git/PTY，不连接用户服务器，不改用户 known_hosts，不以模拟成功宣称真实服务器已验收。

## 启动与检查

```bash
env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$PWD/.dev-config" npm run dev
npm run typecheck
npm run test:unit -- --maxWorkers=4 --testTimeout=20000
npm run build
npm run test:scripts
npx playwright test e2e/product-areas.spec.ts e2e/unified-ssh-code.spec.ts --workers=1
```
