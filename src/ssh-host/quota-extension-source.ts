/** Fixed helper-private extension. No local SDK dependency, commands, tools or transcript writes.
 * Uses only the public 1.0.x extension registry to prove a built-in stored-account route.
 * Deliberately never calls getApiKeyAndHeaders/getProviderAuth: those can execute !commands.
 * All account/config access and HTTP happen inside the remote Pi; FD3 carries numeric DTOs only. */
export const QUOTA_EXTENSION_SOURCE = String.raw`
import { Socket } from 'node:net';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export default function(pi) {
  let socket, context, epoch = 0, busy = false;
  const nonce = process.env.PI_DESKTOP_QUOTA_NONCE;
  if (!/^[a-f0-9]{64}$/.test(nonce || '')) return;
  const initialAgentEnv = Object.fromEntries(Object.entries(process.env).filter(([key])=>key.endsWith('_CODING_AGENT_DIR')));
  const fail = reason => { throw { reason }; };
  const official = (value, provider) => {
    try { const u = new URL(value); return u.origin === (provider === 'openai-codex' ? 'https://chatgpt.com' : 'https://api.deepseek.com') && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
  };
  const bounded = async (path, requireOwner = true, cap = 1048576) => {
    let h;
    try {
      h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = await h.stat();
      if (!s.isFile() || requireOwner && s.uid !== process.getuid?.() || s.size > cap) fail('runtime-unavailable');
      const b = Buffer.alloc(s.size + 1); let n = 0;
      while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
      const after = await h.stat();
      if (n !== s.size || after.mtimeMs !== s.mtimeMs || after.size !== s.size) fail('account-changed');
      return b.subarray(0,n).toString('utf8');
    } catch (e) { if (e.code === 'ENOENT') return '{}'; throw e; } finally { await h?.close(); }
  };
  const agentDirectory = async () => {
    try {
      // Resolve the SDK of the ACTUAL running CLI, never a global/default install or account.
      const cli = await realpath(process.argv[1]);
      let root = dirname(cli), entry, configPath;
      for (let depth = 0; depth < 5; depth++) {
        const pkg = JSON.parse(await bounded(join(root, 'package.json'), false, 65536));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        const main = pkg.main || pkg.exports?.['.']?.import;
        // Both distributed bundle/cli.js and the SDK's legacy dist/cli.js are valid.
        // Resolve only this running package, never createRequire's require-condition
        // lookup (the SDK exposes an ESM import-only entry) or another installation.
        if (pkg.name === '@earendil-works/pi-coding-agent' && typeof main === 'string' && (typeof bin === 'string' && resolve(root,bin) === cli || join(root,'dist','cli.js') === cli)) {
          entry = await realpath(resolve(root,main));
          if (entry !== join(root,'dist','index.js')) fail('remote-sdk-unsupported');
          configPath = await realpath(join(dirname(entry),'config.js'));
          if (configPath !== join(root,'dist','config.js')) fail('remote-sdk-unsupported');
          break;
        }
        const parent = dirname(root); if (parent === root) break; root = parent;
      }
      if (!configPath) fail('remote-sdk-unsupported');
      const config = await import(pathToFileURL(configPath).href);
      if (typeof config.getAgentDir !== 'function' || typeof config.ENV_AGENT_DIR !== 'string') fail('remote-sdk-unsupported');
      if (process.env[config.ENV_AGENT_DIR] !== initialAgentEnv[config.ENV_AGENT_DIR]) fail('account-changed');
      const path = config.getAgentDir();
      if (typeof path !== 'string' || !isAbsolute(path)) fail('remote-sdk-unsupported');
      return path;
    } catch (e) { fail(e?.reason === 'account-changed' ? 'account-changed' : 'remote-sdk-unsupported'); }
  };
  const safeMetadata = (value, depth = 0) => {
    if (depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 8192;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 512 && value.every(x=>safeMetadata(x,depth+1));
    return !!value && typeof value === 'object' && Object.keys(value).length <= 512 && Object.values(value).every(x=>safeMetadata(x,depth+1));
  };
  const safeProviderOverlay = (cfg, provider) => {
    if (cfg === undefined) return true;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
    const api = provider === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions';
    const metadata = new Set(['id','name','reasoning','thinkingLevelMap','input','inputLimits','cost','promptCache','contextWindow','maxTokens','samplingParams','samplingParamsByThinkingLevel','compat']);
    const model = row => !!row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length <= 40 && Object.entries(row).every(([key,value])=>key === 'baseUrl' ? official(value,provider) : key === 'api' ? value === api : key === 'provider' ? value === provider : key === 'type' ? value === 'chat' : metadata.has(key) && safeMetadata(value));
    return Object.keys(cfg).length <= 5 && Object.entries(cfg).every(([key,value])=>key === 'baseUrl' ? official(value,provider) : key === 'api' ? value === api : key === 'compat' ? safeMetadata(value) : key === 'models' ? Array.isArray(value) && value.length <= 512 && value.every(model) : key === 'modelOverrides' ? !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 512 && Object.values(value).every(model) : false);
  };
  const inspect = async ctx => {
    if (ctx.mode !== 'rpc' || !ctx.isProjectTrusted?.()) fail('remote-session-untrusted');
    const m = ctx.model, r = ctx.modelRegistry;
    if (!m || !['openai-codex','deepseek'].includes(m.provider)) fail('provider-unsupported');
    const p = m.provider;
    // Require the safe public registry surface. Older/alternate SDKs fail closed.
    if (!r || typeof r.getRegisteredNativeProvider !== 'function' || typeof r.getProviderAuthStatus !== 'function' || typeof r.getRegisteredProviderConfig !== 'function') fail('remote-sdk-unsupported');
    // Declarative model metadata does not change the stored account. Native/custom
    // auth, headers, callbacks or transport overrides cannot prove the same owner.
    if (r.getRegisteredNativeProvider(p) || !safeProviderOverlay(r.getRegisteredProviderConfig(p),p)) fail('remote-provider-config-unsupported');
    if (m.api !== (p === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions')) fail('provider-unsupported');
    if (!official(m.baseUrl,p) || r.getProvider(p)?.baseUrl && !official(r.getProvider(p).baseUrl,p)) fail('proxy-unsupported');
    // No runtime/config/environment fallback, and never borrow the helper's account.
    if (r.getProviderAuthStatus(p)?.source !== 'stored') fail('auth-unavailable');
    const agent = await agentDirectory();
    const [authRaw, modelsRaw] = await Promise.all([bounded(join(agent,'auth.json')), bounded(join(agent,'models.json'))]);
    const cfg = JSON.parse(modelsRaw);
    // Permit extra model IDs/capabilities and verified official endpoints only.
    // Any credential/header/env/command/custom callback field remains unsupported.
    if (!safeProviderOverlay(cfg.providers?.[p],p)) fail('remote-provider-config-unsupported');
    const credential = JSON.parse(authRaw)[p];
    let token;
    if (p === 'openai-codex') {
      if (!r.isUsingOAuth?.(m) || credential?.type !== 'oauth') fail('oauth-required');
      if (!Number.isFinite(credential.expires) || credential.expires <= Date.now() + 300000) fail('auth-unavailable');
      token = credential.access;
    } else {
      if (credential?.type !== 'api_key') fail('auth-unavailable');
      token = credential.key;
    }
    if (typeof token !== 'string' || !token || token.length > 32768 || /\s/.test(token) || /^[!$]/.test(token)) fail('auth-unavailable');
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    let account;
    if (p === 'openai-codex') {
      try { account = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth']?.chatgpt_account_id; } catch { fail('auth-unavailable'); }
      if (typeof account !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(account)) fail('auth-unavailable');
      headers['ChatGPT-Account-Id'] = account;
    }
    return { provider:p, model:m.id, headers, token, account, key:JSON.stringify([ctx.sessionManager.getSessionId(),ctx.sessionManager.getSessionFile(),m,agent,authRaw,modelsRaw,r.getProviderAuthStatus(p)]) };
  };
  // Only bounded numeric/boolean quota fields cross the pipe, never a provider response/string.
  const numeric = x => (typeof x === 'number' && Number.isFinite(x) || typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) && x.length <= 64) ? x : undefined;
  const bool = x => typeof x === 'boolean' ? x : undefined;
  const window = x => ({used_percent:numeric(x?.used_percent),limit_window_seconds:numeric(x?.limit_window_seconds),reset_at:numeric(x?.reset_at)});
  const rate = x => ({primary_window:window(x?.primary_window),secondary_window:window(x?.secondary_window),limit_reached:bool(x?.limit_reached)});
  const project = (p,x) => p === 'openai-codex' ? {
    rate_limit:rate(x?.rate_limit), additional_rate_limits:Array.isArray(x?.additional_rate_limits) ? x.additional_rate_limits.slice(0,16).map(y=>({rate_limit:rate(y?.rate_limit)})) : [],
    credits:{has_credits:bool(x?.credits?.has_credits),unlimited:bool(x?.credits?.unlimited),balance:numeric(x?.credits?.balance)}
  } : {is_available:bool(x?.is_available),balance_infos:Array.isArray(x?.balance_infos) ? x.balance_infos.slice(0,3).map(y=>({currency:['CNY','USD'].includes(y?.currency)?y.currency:undefined,total_balance:numeric(y?.total_balance),granted_balance:numeric(y?.granted_balance),topped_up_balance:numeric(y?.topped_up_balance)})) : []};
  const query = async q => {
    const ctx = context, generation = epoch, signal = AbortSignal.timeout(6500);
    if (ctx.sessionManager.getSessionId() !== q.sessionId || ctx.sessionManager.getSessionFile() !== q.sessionFile) fail('session-unavailable');
    const before = await inspect(ctx);
    const guard = async () => { const after = await inspect(ctx); if (ctx !== context || generation !== epoch || before.key !== after.key || signal.aborted) fail('account-changed'); };
    await guard();
    const response = await fetch(before.provider === 'openai-codex' ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.deepseek.com/user/balance', {method:'GET',headers:before.headers,redirect:'error',signal});
    if (!response.ok || response.redirected) { void response.body?.cancel(); fail(response.status === 401 || response.status === 403 ? 'auth-unavailable' : 'request-failed'); }
    if (!response.body || Number(response.headers.get('content-length')) > 65536) { void response.body?.cancel(); fail('invalid-response'); }
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); fail('invalid-response'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const payload = project(before.provider, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    await guard();
    const encoded = JSON.stringify(payload);
    if ([before.token,before.account].some(s=>s && encoded.includes(s))) fail('invalid-response');
    return {provider:before.provider,payload};
  };
  const send = x => { const line = JSON.stringify({nonce,...x})+'\n'; if (Buffer.byteLength(line) <= 16384 && !socket.destroyed && socket.writableLength < 32768) socket.write(line); };
  pi.on('session_start', (_e,ctx) => {
    // Factories may be probed/reloaded before an actual session binds. Consume the
    // nonce only at the lifecycle boundary, not in a discarded factory invocation.
    delete process.env.PI_DESKTOP_QUOTA_NONCE;
    context = ctx; epoch++;
    if (socket) return;
    socket = new Socket({fd:3,readable:true,writable:true});
    socket.on('error',()=>socket.destroy());
    let tail = '';
    socket.on('data', data => {
      tail += data.toString('utf8');
      if (Buffer.byteLength(tail)>2048) { socket.destroy(); return; }
      let at;
      while ((at=tail.indexOf('\n'))>=0) {
        const line=tail.slice(0,at); tail=tail.slice(at+1);
        let q; try { q=JSON.parse(line); } catch { socket.destroy(); return; }
        if (q.nonce!==nonce || q.type!=='quota' || !/^[a-f0-9-]{36}$/.test(q.id || '')) continue;
        if (busy) { send({id:q.id,reason:'busy'}); continue; }
        busy=true;
        let timer;
        const operation = query(q).finally(()=>{busy=false;});
        Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject({reason:'timeout'}),7000);})])
          .then(value=>send({id:q.id,...value}),e=>send({id:q.id,reason:['provider-unsupported','runtime-unavailable','remote-unsupported','remote-sdk-unsupported','remote-provider-config-unsupported','remote-session-untrusted','proxy-unsupported','auth-unavailable','oauth-required','account-changed','invalid-response','request-failed','timeout','session-unavailable'].includes(e?.reason)?e.reason:'request-failed'}))
          .finally(()=>{clearTimeout(timer);});
      }
    });
    send({type:'ready',capability:'stored-provider-quota-v1'});
  });
  pi.on('session_shutdown',()=>{ epoch++; context=undefined; socket?.destroy(); });
}
`
