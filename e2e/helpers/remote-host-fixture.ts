import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const REMOTE_REPLY = 'REMOTE_FIXTURE_STREAM: the real SSH helper delivered this reply.'
export const REMOTE_USAGE = { input: 120, output: 24, cacheRead: 8, cacheWrite: 4, totalTokens: 156, cost: { input: 0.0012, output: 0.0024, cacheRead: 0.00008, cacheWrite: 0.00004, total: 0.00372 } }

/** Only the Pi model/RPC process is faked. The helper owns the private session directory. */
function fakePi(marker: string): string {
  return `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const marker = MARKER;
const replyText = REPLY;
const usage = USAGE;
const arg = (key) => process.argv[process.argv.indexOf(key) + 1];
const dir = arg('--session-dir');
const file = arg('--session');
if (!path.isAbsolute(dir) || path.dirname(file) !== dir) throw new Error('session outside dedicated --session-dir');
if (process.env.PI_CODING_AGENT_DIR || process.env.SSHPASS || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) throw new Error('client credentials leaked');
fs.appendFileSync(marker, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME, argv: process.argv.slice(2), envKeys: Object.keys(process.env) }) + '\n', { mode: 0o600 });
// Real Pi accepts the host's pre-created --session file. Also support a fresh file.
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const header = rows.shift();
if (header.type !== 'session' || header.version !== 3 || header.cwd !== process.cwd()) throw new Error('invalid session header');
let entries = rows, leafId = entries.at(-1)?.id || null, streaming = false, thinkingLevel = 'off';
let model = { id: 'fixture-model', provider: 'fixture', name: 'Remote fixture model', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 64000, maxTokens: 4096, cost: { input: 10, output: 100, cacheRead: 10, cacheWrite: 10 } };
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const respond = (c, data = {}) => send({ type: 'response', id: c.id, command: c.type, success: true, data });
const append = (message) => {
  const entry = { type: 'message', id: crypto.randomUUID(), parentId: leafId, timestamp: new Date(message.timestamp).toISOString(), message };
  leafId = entry.id; entries.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + '\n');
};
const tree = () => { const nodes = new Map(entries.map(entry => [entry.id, { entry, children: [] }])); const roots = []; for (const node of nodes.values()) { const parent = nodes.get(node.entry.parentId); if (parent) parent.children.push(node); else roots.push(node); } return roots; };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const c = JSON.parse(line);
  switch (c.type) {
    case 'get_state': return respond(c, { sessionId: header.id, sessionFile: file, cwd: process.cwd(), model, thinkingLevel, isStreaming: streaming, isCompacting: false, steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: false, messageCount: entries.length, pendingMessageCount: 0 });
    case 'get_available_models': return respond(c, { models: [model] });
    case 'get_messages': return respond(c, { messages: entries.filter(e => e.type === 'message').map(e => e.message) });
    case 'get_tree': return respond(c, { tree: tree(), leafId });
    case 'get_entries': {
      const i = c.since ? entries.findIndex(e => e.id === c.since) : -1;
      if (c.since && i < 0) return send({ type: 'response', id: c.id, command: c.type, success: false, error: 'Unknown entry cursor' });
      return respond(c, { entries: entries.slice(i + 1), leafId });
    }
    case 'get_session_stats': return respond(c, { sessionFile: file, sessionId: header.id, userMessages: entries.filter(e => e.message?.role === 'user').length, assistantMessages: entries.filter(e => e.message?.role === 'assistant').length, totalMessages: entries.length, toolCalls: entries.reduce((count, entry) => count + (Array.isArray(entry.message?.content) ? entry.message.content.filter(part => part.type === 'toolCall').length : 0), 0), toolResults: entries.filter(entry => entry.message?.role === 'toolResult').length, tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens }, cost: usage.cost.total, contextUsage: { tokens: usage.totalTokens, contextWindow: model.contextWindow, percent: usage.totalTokens / model.contextWindow * 100 } });
    case 'get_commands': return respond(c, { commands: [] });
    case 'set_model': model = { ...model, provider: c.provider, id: c.modelId }; return respond(c, model);
    case 'set_thinking_level': thinkingLevel = c.level; return respond(c, {});
    case 'get_available_thinking_levels': return respond(c, { levels: ['off', 'low', 'high'] });
    case 'abort': streaming = false; respond(c); send({ type: 'agent_end', messages: [] }); send({ type: 'agent_settled' }); return;
    case 'prompt': {
      streaming = true; respond(c, { disposition: 'started' });
      const user = { role: 'user', content: [{ type: 'text', text: c.message }], timestamp: Date.now() };
      const assistant = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: replyText }], usage, stopReason: 'stop', timestamp: Date.now() };
      send({ type: 'agent_start' }); send({ type: 'turn_start' });
      append(user); send({ type: 'message_start', message: user }); send({ type: 'message_end', message: user });
      const checks = [
        { name: 'read', args: { path: 'REMOTE_ONLY.txt' } },
        { name: 'bash', args: { command: "printf 'CONTROLLED_COMMAND_ONE'" } },
        { name: 'bash', args: { command: "printf 'CONTROLLED_COMMAND_TWO'" } },
      ].map(tool => ({ ...tool, id: crypto.randomUUID() }));
      const intro = { ...assistant, content: [{ type: 'text', text: '先检查目录中的文件，再运行两条受控命令。' }, ...checks.map(tool => ({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args }))], usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse' };
      append(intro); send({ type: 'message_start', message: intro }); send({ type: 'message_end', message: intro });
      for (const tool of checks) {
        send({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.args });
        const text = tool.name === 'read' ? fs.readFileSync(path.join(process.cwd(), tool.args.path), 'utf8') : require('node:child_process').execFileSync('/bin/sh', ['-c', tool.args.command], { cwd: process.cwd(), encoding: 'utf8' });
        const result = { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text }], isError: false, timestamp: Date.now() };
        append(result); send({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: { content: result.content, isError: false }, isError: false });
      }
      send({ type: 'message_start', message: { ...assistant, content: [], stopReason: 'pending' } });
      send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'REMOTE_FIXTURE_STREAM: ' } });
      setTimeout(() => {
        if (!streaming) return;
        send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: replyText.slice('REMOTE_FIXTURE_STREAM: '.length) } });
        append(assistant); send({ type: 'message_end', message: assistant }); send({ type: 'turn_end', message: assistant, toolResults: [] });
        send({ type: 'agent_end', messages: [user, assistant] }); streaming = false; send({ type: 'agent_settled' });
      }, 1600);
      return;
    }
    default: return send({ type: 'response', id: c.id, command: c.type, success: false, error: 'Fixture does not implement ' + c.type });
  }
});
input.on('close', () => process.exit(0));
`.replace('MARKER', JSON.stringify(marker)).replace('REPLY', JSON.stringify(REMOTE_REPLY)).replace('USAGE', JSON.stringify(REMOTE_USAGE))
}

export type RemoteHostFixture = {
  home: string; remoteHome: string; local: string; remote: string; configFile: string; piMarker: string; sshMarker: string; profileId: string
  app: ElectronApplication; win: Page
  close(): Promise<void>
}

export async function launchRemoteHostFixture(options: { localModelPort?: number } = {}): Promise<RemoteHostFixture> {
  const root = mkdtempSync(join(tmpdir(), 'pi-unified-ssh-e2e-'))
  let app: ElectronApplication | undefined
  try {
  const home = join(root, 'client-home'), remoteHome = join(root, 'remote-home')
  const local = join(home, 'code', 'local-project'), remote = join(remoteHome, 'remote-project')
  const bin = join(root, 'client-bin'), agentDir = join(home, '.pi', 'agent'), config = join(home, '.config', 'Electron')
  const configFile = join(config, 'pi-desktop.json'), piMarker = join(root, 'pi-starts.jsonl'), sshMarker = join(root, 'ssh-starts.jsonl')
  const pi = join(remoteHome, 'fixture-pi.cjs'), profileId = randomUUID()
  const remoteBin = join(remoteHome, 'bin')
  for (const dir of [local, remote, bin, remoteBin, agentDir, config, join(remoteHome, 'tmp')]) mkdirSync(dir, { recursive: true })
  // Optional genuine util-linux binary for minimal test images; never substitute a fake PTY.
  if (process.env.PI_E2E_REMOTE_BIN) copyFileSync(join(process.env.PI_E2E_REMOTE_BIN, 'script'), join(remoteBin, 'script'))
  writeFileSync(join(local, 'LOCAL_ONLY.txt'), 'LOCAL_FILESYSTEM_SENTINEL\n')
  writeFileSync(join(local, 'sentinel.txt'), 'LOCAL_NOT_REMOTE\n')
  writeFileSync(join(remote, 'REMOTE_ONLY.txt'), 'REMOTE_FILESYSTEM_SENTINEL\n')
  writeFileSync(join(remote, 'sentinel.txt'), 'REMOTE_GIT_BASE\n')
  const gitEnv = { HOME: remoteHome, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const args of [['init', '-b', 'fixture-branch'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture base']]) execFileSync('git', args, { cwd: remote, env: gitEnv, stdio: 'pipe' })
  writeFileSync(join(remote, 'sentinel.txt'), 'REMOTE_GIT_BASE\nREMOTE_GIT_CHANGED\n')
  writeFileSync(pi, fakePi(piMarker), { mode: 0o700 }); chmodSync(pi, 0o700)
  // Last argv is the production-generated remote command. No stdin parsing, reply synthesis,
  // SSH config, known_hosts, credentials, or client agent environment crosses this boundary.
  const shim = `#!/bin/sh\nif [ "$1" = -V ]; then echo 'OpenSSH_fixture' >&2; exit 0; fi\nfor command do :; done\nprintf '%s\\n' "$$" >> ${quote(sshMarker)}\nexec /usr/bin/env -i HOME=${quote(remoteHome)} PATH=${quote(`${remoteBin}:${dirname(process.execPath)}:/usr/bin:/bin`)} SHELL=/bin/sh LANG=C.UTF-8 TMPDIR=${quote(join(remoteHome, 'tmp'))} /bin/sh -c "$command"\n`
  writeFileSync(join(bin, 'ssh'), shim, { mode: 0o700 })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'off', defaultProvider: 'local-fixture', defaultModel: 'local-model' }))
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'local-fixture': { baseUrl: `http://127.0.0.1:${options.localModelPort || 9}/v1`, api: 'openai-completions', apiKey: 'unused-local-fixture', models: [{ id: 'local-model', name: 'Local fixture model', contextWindow: 32000, maxTokens: 1000, reasoning: false, input: ['text'] }] } } }))
  writeFileSync(configFile, JSON.stringify({ language: 'en', currentProject: local, recentProjects: [local], windowBounds: { width: 1440, height: 1050 }, rightPanelPrefs: { files: true, review: true }, autoCheckRegistryUpdates: false, sshProfiles: [{ id: profileId, name: 'Fixture host', host: 'fixture.invalid', authMethod: 'agent', cwd: '/', piPath: pi, nodePath: process.execPath }] }))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}`, PI_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ executablePath: require('electron') as string, args: [resolve('out/main/index.js'), `--user-data-dir=${config}`, '--ozone-platform=headless', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], env, timeout: 60000 })
    const win = await app.firstWindow()
    return { home, remoteHome, local, remote, configFile, piMarker, sshMarker, profileId, app, win, close: async () => {
      try {
        await win.evaluate(async (id) => {
          const api = (window as unknown as { piDesktop: { invoke: (channel: string, request: unknown) => Promise<unknown> } }).piDesktop
          await api.invoke('ipc:code.ssh.disconnect', { profileId: id, force: true }).catch(() => {})
        }, profileId).catch(() => {})
        await win.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.terminal-drawer [aria-label="Close terminal"]').forEach((button) => button.click())).catch(() => {})
        await app!.close()
      } finally { rmSync(root, { recursive: true, force: true }) }
    } }
  } catch (error) {
    await app?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function piStarts(fixture: RemoteHostFixture): Array<{ cwd: string; home: string; argv: string[]; envKeys: string[] }> {
  return existsSync(fixture.piMarker) ? readFileSync(fixture.piMarker, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}
