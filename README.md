<div align="center">

<img src="resources/icon.svg" alt="pi Desktop" width="72" height="72" />

# pi Desktop · Chat / Code / Routines

A desktop workspace built on [justhil/pi-app](https://github.com/justhil/pi-app) and the [pi](https://github.com/earendil-works/pi) agent SDK.<br/>
Separate everyday chat from coding, work locally or over SSH in the same Code interface, and schedule local routines.

**English** · [简体中文](./README.zh-CN.md) · [This branch](https://github.com/xing-shuai/pi-app/tree/feat/desktop-chat-routines-ssh) · [MIT License](./LICENSE)

</div>

> **Development snapshot — `feat/desktop-chat-routines-ssh`.** This is not an upstream release or an official Claude client. Upstream installers and screenshots do not represent this branch. Build from source to try these changes; see [known limitations](#known-limitations) before use.

## What this branch adds

| Area | Current capabilities | Boundary |
|---|---|---|
| **Chat** | Independent history, streaming Markdown, text/image attachments, model selection for new chats, and supported thinking levels. | Ordinary Chat has no model tools and does not discover Code extensions, MCP, Skills, or workspace instructions. |
| **Code** | A shared timeline, composer, Files, Review/Git, and terminal; model/Effort controls and context/usage views. | Code tools and terminals run with the selected machine account's permissions, not in an OS sandbox. |
| **Local / SSH** | Choose the execution location without leaving Code. Remote files, Git, real PTYs, and Pi RPC run on the remote host. | Unknown or stale remote identities are rejected; requests never silently fall back to your local machine. |
| **Scheduled tasks / Routines** | Manual, one-time, daily, weekday, and weekly schedules; time zones, persistent run history, live text output, cancellation, and timeouts. | Local execution only. The app must be running and the computer awake. |

The interface uses a dark reference layout, a unified session sidebar with location filters, and a right-hand **Workspace** drawer for panels and terminal controls.

### Models, Effort, and usage

- Model availability and thinking levels come from the selected runtime; unsupported levels are not invented.
- Context occupancy is a Pi estimate and can be unknown, especially after compaction. It is separate from provider subscription limits.
- Quota/balance queries support compatible Codex OAuth and DeepSeek stored credentials. Remote queries stay on the remote host and require a supported Pi installation and verifiable provider configuration.
- Unsupported authentication, provider overrides, or bridge versions report **unavailable**, not a fake zero balance or a desktop-account fallback. Real paid accounts are not exercised by fixtures.

### No project

Local **No project** uses a private scratch workspace, allocated when needed for the first send. SSH **No project** uses that host's real home directory after explicit trust; it is not a disposable scratch directory or a sandbox.

## Run from source

### Requirements

- Node.js **22.19+** and npm.
- A desktop environment for Electron; do not skip installation scripts or native dependency setup.
- Your own configured model provider account. The application bundles Pi SDK **1.0.2**; it does not include a subscription or API credits.
- For SSH: local OpenSSH, a trusted host key, and a remote POSIX host with compatible Node and Pi CLI installations. See [SSH setup](#ssh-setup).

```bash
git clone --branch feat/desktop-chat-routines-ssh --single-branch https://github.com/xing-shuai/pi-app.git
cd pi-app
npm ci
npm run dev
```

### Do I need to build before starting?

| Command | Behavior |
|---|---|
| `npm ci` | Installs locked dependencies; `postinstall` prepares native dependencies and builds the app. |
| `npm run dev` | Compiles the main/preload/helper code and serves the renderer with Vite. **No separate build is normally needed before each development start.** |
| `npm run build` | Creates production bundles in `out/`; does not create an installer. |
| `npm start` / `npm run preview` | Opens an existing production build. Run `npm run build` first if it is missing or stale. |
| `npm run package` | Exports icons, builds production bundles, and runs electron-builder to create packages. |

For a Linux trial with separate desktop settings:

```bash
env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$PWD/.dev-config" npm run dev
```

`.dev-config/` is ignored by Git. This separates Electron application data, **not** the Pi account or credentials under `~/.pi/agent`. Clearing `ELECTRON_RUN_AS_NODE` is useful when launching from an Electron-based terminal or agent harness.

## First use

1. **Chat:** start a conversation without selecting a code folder. Choose a model before the first message; an existing Chat keeps its model.
2. **Code:** select **Local** or **SSH**, then choose a folder or **No project**. Confirm trust when requested.
3. **Workspace:** open the drawer on the right edge of Code for Files, Review, and terminal controls. Local and SSH use the same interface.
4. **History:** filter the unified list by location or host. Listing history does not automatically connect to a server. Delete an idle session through its menu and confirmation dialog.
5. **Scheduled tasks:** create a local routine, choose its model, permissions, time zone, and schedule, then use **Run now** to inspect its output.

## SSH setup

1. Verify the host's SSH fingerprint through a trusted channel and register it in your local `known_hosts`. The app does not bypass host-key checks.
2. Install compatible Node **22.19+** and Pi CLI separately on the remote host; configure the model account there. Compatibility is developed against Pi **1.0.2** RPC. The desktop does not install them automatically or copy your local model credentials.
3. In Code's location picker, add a host using an SSH alias or `user@host`. An identity-file setting refers to the **private key**, not the `.pub` file. Unlock encrypted keys in ssh-agent first.
4. Test the connection, browse a remote directory, and approve the exact host/workspace before using Code. Connection testing is not proof that a model account is ready.

Linux/macOS password mode additionally needs local `sshpass`. Passwords are entered in an application dialog, passed through a temporary anonymous pipe, and are not saved or put into chat, command arguments, or environment variables. This password path is not supported on Windows.

```text
Local Electron UI
  └─ Main process: identity validation and IPC routing
      ├─ Local Code → Pi SDK worker → local files / Git / terminal
      └─ OpenSSH → bundled Node helper on the remote host
                    ├─ remote files / Git / real PTY
                    └─ remote Pi RPC → remote model account
```

There is no whole-repository synchronization or permanently installed remote daemon. Model/command discovery may lazily start a hidden remote probe after workspace trust; selecting a folder alone does not send a model prompt.

## Routines and permissions

- **Chat routine:** no tools by default. A per-routine opt-in can enable the read-only Open-Meteo weather tool; this does not enable tools in ordinary Chat or provide general web browsing.
- **Read-only Code:** a restricted tool policy, not filesystem isolation. Allowed read tools can still access paths permitted to your OS account.
- **Trusted Code:** requires explicit authorization and can execute commands or modify files with your local account's permissions. Routine runs do not load interactive extensions or MCP.
- A routine does not overlap itself; at most two run concurrently. Cancellation or timeout does not release the execution lock until the executor actually settles.
- **Completed** means execution ended successfully, not that the task's objective was independently verified. There is no exactly-once guarantee for external side effects.

## Data and trust boundaries

| Data | Location / ownership |
|---|---|
| Local Code models, authentication, and history | The selected local Pi runtime's configuration and session directories; existing CLI integration is retained. |
| Chat history | A separate `chat-workspaces/` directory under Electron user data. |
| Routine definitions and run ledger | `routines/` under Electron user data. |
| SSH Code history | Remote `~/.pi/desktop-code/sessions/<workspace-hash>/`; arbitrary CLI histories are not automatically imported. |
| Remote model authentication | The remote Pi account; no desktop-account fallback. |

**Trust is not a sandbox.** Code tools, extensions, and terminals can act outside the selected folder with that machine account's permissions. Do not connect untrusted hosts or run untrusted instructions. Keep credentials, local settings, and generated artifacts out of commits.

## Known limitations

- **Open regression:** a metadata probe in SSH **No project** mode can appear as an empty session in history. Old empty histories are not automatically deleted; use explicit deletion only for records you intend to remove.
- Remote quota availability depends on SDK/CLI identity, stored authentication, and provider configuration. Fixture success is not verification of your live account.
- No reliable offline runner, disconnect replay, guaranteed execution after the desktop closes, SSH/WSL/cloud routines, or automatic replay of interrupted operations.
- Remote export/rewind/fork-at, full worktree creation/reclamation, image upload, and complete browser/desktop-adapter forwarding are not implemented.
- Chat knowledge projects/RAG, long-term memory, Research, and full Artifacts are not implemented.
- Upstream WSL, Android, and adapter code remains in the repository; full compatibility with the new Chat/Routines/SSH paths is not claimed. Remote macOS/BSD PTYs have not been validated on real machines.

## Development and documentation

Stack: Electron 43 · React 18 · TypeScript · Zustand · i18next · xterm.js · Pi SDK 1.0.2.

Use checks relevant to the change rather than running every suite for a documentation or isolated UI edit. Available commands include `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:scripts`, and `npm run test:e2e`. Historical results are not a guarantee that the current branch passes every suite.

- [Documentation index](./doc/README.md)
- [Chat / Code / Routines guide (Chinese)](./doc/guide/product-areas.zh-CN.md)
- [SSH guide (Chinese)](./doc/guide/ssh-workspaces.zh-CN.md)
- [Provider usage (Chinese)](./doc/guide/provider-usage.zh-CN.md)
- [Weather authorization (Chinese)](./doc/guide/routines-weather.zh-CN.md)
- [Adapter authoring](./doc/adapter-authoring-guide.md)

Some detailed guides still describe earlier iterations. This README states the current branch boundaries; a broader documentation refresh is pending. Upstream demonstration assets remain in `doc/assets/readme/` and are not screenshots of this interface.

## Credits and license

Based on [justhil/pi-app](https://github.com/justhil/pi-app); the original project and contributors retain their attribution. This branch is maintained in [xing-shuai/pi-app](https://github.com/xing-shuai/pi-app).

[MIT](./LICENSE). The minimal pi-usage-derived normalization code retains its [third-party license](./src/main/provider-usage/LICENSE.pi-usage).
