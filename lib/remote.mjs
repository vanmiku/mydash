// 跨机器发布：别的机器（比如云服务器上跑的 agent）把产物传到这台机器的 mydash。
//   这台机器：mydash remote token --name <名字> 生成令牌（只显示一次）；服务端接口在 server.mjs 的 /api/remote/*
//   那台机器：./setup.sh install --remote <网址> --token <令牌>（只装命令行，不装服务），之后照常 mydash publish
// 文件按 sha1 去重：上一版已有的不重传。预览（Office 转 PDF、PDF 逐页图片）在这台机器上生成。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, CONFIG_PATH, readConfig, sha1File, sha1Buf } from './store.mjs';
import { t } from './i18n.mjs';

// ---------- 客户端（发布的那台机器）----------
export function remoteConfig() {
  const c = readConfig().remote || {};
  const url = process.env.MYDASH_REMOTE || c.url; const token = process.env.MYDASH_TOKEN || c.token;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}
async function call(remote, method, p, body, extraHeaders = {}) {
  const r = await fetch(remote.url + p, {
    method, headers: { Authorization: `Bearer ${remote.token}`, ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body == null ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body), signal: AbortSignal.timeout(10 * 60_000),
  });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
export const remoteGet = (remote, p) => call(remote, 'GET', p);
export const remotePost = (remote, p, body) => call(remote, 'POST', p, body);

export async function remotePublish(prep, opts, remote) {
  const files = prep.entries.map(e => ({ path: e.dest, size: e.content ? e.content.length : fs.statSync(e.src).size, sha1: e.content ? sha1Buf(e.content) : sha1File(e.src) }));
  const start = await call(remote, 'POST', '/api/remote/start', {
    project: prep.project, slug: prep.slug, title: prep.title, titleSource: prep.titleSource, main: prep.main, sources: prep.sources, cwd: prep.cwd,
    agent: prep.agent, host: prep.host, projectNote: prep.projectNote, files,
    opts: { note: opts.note || '', type: opts.type || opts.category || '', resolves: opts.resolves || '' },
  });
  for (const f of files) {
    if (!start.need.includes(f.path)) continue;
    const e = prep.entries.find(x => x.dest === f.path);
    const buf = e.content ? e.content : fs.readFileSync(e.src);
    await call(remote, 'PUT', `/api/remote/${start.uploadId}/file?path=${encodeURIComponent(f.path)}`, new Uint8Array(buf), { 'Content-Type': 'application/octet-stream' });
  }
  const r = await call(remote, 'POST', `/api/remote/${start.uploadId}/finish`, {});
  return { ...r, uploaded: start.need.length, remote: remote.url };
}

// ---------- 服务端（收产物的这台机器）：令牌 ----------
const TOKENS = path.join(HOME, 'state', 'tokens.json');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKENS, 'utf8')).tokens || []; } catch { return []; } }
function saveTokens(list) { fs.mkdirSync(path.dirname(TOKENS), { recursive: true }); fs.writeFileSync(TOKENS + '.tmp', JSON.stringify({ tokens: list }, null, 2), { mode: 0o600 }); fs.renameSync(TOKENS + '.tmp', TOKENS); }
export function createToken(name) {
  const token = 'md_' + crypto.randomBytes(24).toString('base64url');
  const list = loadTokens().filter(x => x.name !== name);
  list.push({ name, hash: hash(token), created: new Date().toISOString() });
  saveTokens(list);
  return token;
}
export function listTokens() { return loadTokens().map(({ hash: _h, ...x }) => x); }
export function revokeToken(name) { const list = loadTokens(); const next = list.filter(x => x.name !== name); saveTokens(next); return list.length - next.length; }
// Authorization: Bearer md_… → 令牌名字（无效返回 null）
export function tokenName(authHeader) {
  const m = String(authHeader || '').match(/^Bearer\s+(md_[A-Za-z0-9_-]{20,})$/); if (!m) return null;
  const h = hash(m[1]); const list = loadTokens(); const hit = list.find(x => x.hash === h);
  if (!hit) return null;
  if (!hit.lastUsed || Date.now() - Date.parse(hit.lastUsed) > 3600_000) { hit.lastUsed = new Date().toISOString(); saveTokens(list); }
  return hit.name;
}
export { t };

// ---------- 命令行：mydash remote … ----------
//   token [--name 名字]   在收产物的机器上生成令牌（只显示这一次）
//   tokens / revoke <名字>
//   set <网址> --token <令牌>   在发布的机器上：以后 mydash publish 都传到那边
//   off                    在发布的机器上：改回发到本机
//   （不带参数）           看现在的状态
function writeCfg(c) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(c, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH); }
export async function cmdRemote(pos, opts) {
  const sub = pos[0];
  const out = (r, text) => { if (opts.json) process.stdout.write(JSON.stringify(r) + '\n'); else process.stdout.write(text + '\n'); if (r.ok === false) process.exitCode = 1; };
  if (sub === 'token') {
    const name = String(opts.name || pos[1] || 'remote').replace(/[^\w.-]+/g, '-').slice(0, 40);
    const token = createToken(name);
    return out({ ok: true, name, token }, t('Token for “{name}” (shown only once):', { name }) + `\n  ${token}\n` + t('On the other machine: ./setup.sh install --remote {url} --token <token>, or mydash remote set {url} --token <token>', { url: readConfig().baseUrl || 'http://<this machine>' }));
  }
  if (sub === 'tokens') { const list = listTokens(); return out({ ok: true, tokens: list }, list.length ? list.map(x => `${x.name}  ${t('created {d}', { d: x.created.slice(0, 10) })}${x.lastUsed ? ' · ' + t('last used {d}', { d: x.lastUsed.slice(0, 16).replace('T', ' ') }) : ''}`).join('\n') : t('No tokens yet. Create one with: mydash remote token --name <name>')); }
  if (sub === 'revoke') { const n = revokeToken(pos[1]); return out({ ok: n > 0 }, n ? t('Revoked “{name}”.', { name: pos[1] }) : t('No token named “{name}”.', { name: pos[1] })); }
  if (sub === 'set') {
    const url = String(pos[1] || '').replace(/\/+$/, ''); const token = String(opts.token || '');
    if (!/^https?:\/\//.test(url) || !token) return out({ ok: false }, t('Usage: mydash remote set <url> --token <token>'));
    try { const r = await remoteGet({ url, token }, '/api/remote/ping'); const c = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })(); writeCfg({ ...c, remote: { url, token }, ...(opts.machine ? { machine: String(opts.machine).slice(0, 40) } : {}) }); return out({ ok: true, host: r.host }, t('Connected to {host}. mydash publish now sends everything there.', { host: r.host })); }
    catch (e) { return out({ ok: false, error: e.message }, t('Could not connect to {url}: {err}', { url, err: e.message })); }
  }
  if (sub === 'off') { const c = readConfig(); delete c.remote; writeCfg(c); return out({ ok: true }, t('mydash publish now writes to this machine again.')); }
  const rc = remoteConfig();
  if (!rc) return out({ ok: true, remote: null, tokens: listTokens().length }, t('This machine publishes locally. {n} token(s) for other machines. Commands: mydash remote token | tokens | revoke | set | off', { n: listTokens().length }));
  try { const r = await remoteGet(rc, '/api/remote/ping'); return out({ ok: true, remote: rc.url, host: r.host, name: r.name }, t('Publishing to {url} ({host}) as “{name}”.', { url: rc.url, host: r.host, name: r.name })); }
  catch (e) { return out({ ok: false, remote: rc.url, error: e.message }, t('Publishing to {url}, but it does not answer: {err}', { url: rc.url, err: e.message })); }
}
