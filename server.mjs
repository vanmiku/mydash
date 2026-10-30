// mydash 网页服务：只监听 127.0.0.1。访问方式由安装时选：只本机，或由 tailscale serve 转发到 tailnet。
// 两个端口：PORT 是工作台；CONTENT_PORT 只提供原始文件，网页类产物在这里运行，和工作台不同源，脚本碰不到工作台的接口。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, CONFIG_PATH, scanAll, readMeta, latest, readConfig, updateConfig, baseUrl, contentPort, httpsContentPort, INSTALL_ID, cleanName } from './lib/store.mjs';
import { vapidKeys, subscriptions, addSubscription, removeSubscription, sendWebPush } from './lib/webpush.mjs';
import { t, htmlLang, lang, clientDict, withLang, defaultLang } from './lib/i18n.mjs';
import { kindOf, mimeOf, VIEWABLE } from './lib/kinds.mjs';
import { renderFile } from './lib/render.mjs';
import { homePage, projectPage, digestPage, itemPage, notFoundPage, loginPage, setBuild, setNavSource, setReadSource, setNamesSource, setPinsSource, setResponsesSource, setTodosSource, settingsPage, channelRows, pushSummary, promptPage, sidebar, ACTIVE_RE } from './lib/views.mjs';
import { setMuted, setArchived, autoArchiveDays } from './lib/quiet.mjs';
import { readResponses, addApproval, addComment, deleteComment, latestApproval, setTodo, addAsk, ASK_MAX } from './lib/responses.mjs';
import { versionTodos, todoProgress, checksAllowed } from './lib/todo.mjs';
import { approvalStatus, syncOpen } from './lib/waiting.mjs';
import { runChecks } from './lib/todocheck.mjs';
import { createPrompt, getPrompt, allPrompts, answerPrompt, setPromptStatus, touchPrompt, reapPrompts, promptTitle, promptsEnabled } from './lib/prompts.mjs';
import { projectForSession, agentInfo } from './lib/agents.mjs';
import { questionsOf, validateAnswers, summarize } from './lib/approval.mjs';
import { renderDiff } from './lib/diff.mjs';
import { search } from './lib/search.mjs';
import { createNotifier, notifySettings, sendTo, sendPush, CHANNEL_TYPES, CHANNELS, badField, telegramChat, withChannels, newChannelId, publicChannel } from './lib/notify.mjs';
import { tokenName } from './lib/remote.mjs';
import { commitPublish } from './lib/publish.mjs';
import { readResponses as readResp, openComments as openCm, resolveComments as resolveCm } from './lib/responses.mjs';
import os from 'node:os';
import { isMuted } from './lib/quiet.mjs';
import { CATEGORY_LABEL } from './lib/categories.mjs';
import { approvalState, todoState, PAGE_CSP } from './lib/views.mjs';
import { pipeline } from 'node:stream';
// 能逐行对比的格式
const DIFFABLE = new Set(['md', 'text', 'code', 'json', 'table']);
import { readMap, markRead, markUnread, markAllRead } from './lib/readstate.mjs';
import { projectNames, setProjectName } from './lib/names.mjs';
import { pins, setPin } from './lib/pins.mjs';
import { watchNode } from './lib/tailscale.mjs';
import { classify, lanHostOk, validSession, checkCode, createSession, sessionCookie, rateLimited, noteFailure, accessCode, prettyCode, lanUrls, lanAddresses, loginUrl, qrSvg, deviceCount } from './lib/lan.mjs';

const APP = path.dirname(fileURLToPath(import.meta.url));
const cfg = readConfig();
const PORT = Number(process.env.MYDASH_PORT || cfg.port || 4870);
// 始终监听本机；开了局域网访问（config.lan）再额外监听这台机器的局域网地址。
// 不用 0.0.0.0 / '::'：tailscale serve 可能占着 tailnet 网卡上的同一个端口，监听全部网卡会冲突。
const LAN = cfg.lan === true;
const HOST = process.env.MYDASH_HOST || '127.0.0.1';
const CONTENT_PORT = contentPort();
const HTTPS_CONTENT_PORT = httpsContentPort();

// 防 DNS 重绑定：只接受已知的 Host
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1', 'localhost']);
try { ALLOWED_HOSTS.add(new URL(baseUrl()).host); } catch {}
for (const h of cfg.allowedHosts || []) ALLOWED_HOSTS.add(h);
// 内容端口接受同样的主机名（带内容端口号）
const CONTENT_HOSTS = new Set([...ALLOWED_HOSTS].flatMap(h => [CONTENT_PORT, HTTPS_CONTENT_PORT].map(p => `${h.replace(/:\d+$/, '')}:${p}`)));
try { if (cfg.contentOrigin) CONTENT_HOSTS.add(new URL(cfg.contentOrigin).host); } catch {}
// tailnet 里的名字：短名，或 <短名>.<tailnet>.ts.net（独立节点登录前还不知道 tailnet 名）
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let TAILNET_MAIN = null, TAILNET_CONTENT = null;
function setTailnetNames(names) {
  const TN = names.map(reEsc).join('|');
  TAILNET_MAIN = TN ? new RegExp(`^(${TN})(\\.[a-z0-9-]+\\.ts\\.net)?(:(80|${Number(cfg.publicPort || 80)}))?$`, 'i') : null;
  TAILNET_CONTENT = TN ? new RegExp(`^(${TN})(\\.[a-z0-9-]+\\.ts\\.net)?:(${CONTENT_PORT}|${HTTPS_CONTENT_PORT})$`, 'i') : null;
}
setTailnetNames(cfg.tailnetNames || []);
// 独立节点的真实名字：网址和放行的主机名都跟着它走，旧名字不再放行
let nodeName = null;
function useNodeName(short) {
  const url = `http://${short}`, c = readConfig();
  if (short === nodeName && c.baseUrl === url) return;
  const old = (c.tailnetNames || []).filter(n => n !== short);
  for (const n of old) { ALLOWED_HOSTS.delete(n); for (const p of [CONTENT_PORT, HTTPS_CONTENT_PORT]) CONTENT_HOSTS.delete(`${n}:${p}`); }
  nodeName = short; setTailnetNames([short]);
  if (c.baseUrl !== url || old.length) {
    updateConfig(x => ({ ...x, baseUrl: url, tailnetNames: [short], allowedHosts: [...new Set([...(x.allowedHosts || []).filter(h => !old.includes(h)), short])] }));
    console.log(new Date().toISOString(), `tailnet name: ${short}, address: ${url}`);
  }
}
const hostOk = h => ALLOWED_HOSTS.has(h) || Boolean(TAILNET_MAIN?.test(h));
const contentHostOk = h => CONTENT_HOSTS.has(h) || Boolean(TAILNET_CONTENT?.test(h));

// 静态资源版本号（每次部署变化）
const BUILD = crypto.createHash('sha1').update(['static/app.css', 'static/app.js', 'static/pdf-view.mjs', 'static/icon.svg', 'static/favicon.ico', 'static/icon-180.png', 'lib/locales/zh.mjs'].map(f => { try { return fs.statSync(path.join(APP, f)).mtimeMs; } catch { return 0; } }).join('|') + lang()).digest('hex').slice(0, 8);
setBuild(BUILD);
// 浏览器端用到的译文：只挑 app.js / pdf-view.mjs 里 T('...') 用到的
// 浏览器端的译文，按语言各算一份（页面语言可以按设备选，见 withLang）
const I18N_JS = {};
const i18nJs = l => (I18N_JS[l] ??= `window.__LANG=${JSON.stringify(l)};window.__T=${JSON.stringify(clientDict([path.join(APP, 'static', 'app.js'), path.join(APP, 'static', 'pdf-view.mjs')], l))};`);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 索引缓存 + 变更推送 ----------
// 新鲜度不只靠 fs.watch（Linux 上递归监听新建的目录会慢一拍）：最多每秒核对一次各级目录的修改时间
let INDEX = null; let INDEX_AT = 0; let INDEX_SIG = 0; let SIG_AT = 0;
function dataSig() {
  let sig = 0;
  try {
    sig += fs.statSync(DATA_DIR).mtimeMs;
    for (const p of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      const pd = path.join(DATA_DIR, p.name); sig += fs.statSync(pd).mtimeMs;
      for (const sl of fs.readdirSync(pd, { withFileTypes: true })) if (sl.isDirectory() && !sl.name.startsWith('.')) sig += fs.statSync(path.join(pd, sl.name)).mtimeMs;
    }
  } catch {}
  return sig;
}
function index() {
  const now = Date.now();
  if (INDEX && now - SIG_AT > 1000) { SIG_AT = now; if (dataSig() !== INDEX_SIG) INDEX = null; }
  if (!INDEX || now - INDEX_AT > 15000) { INDEX_SIG = dataSig(); SIG_AT = now; INDEX = scanAll(); INDEX_AT = now; }
  return INDEX;
}
setNavSource(index);
setReadSource(readMap);
setNamesSource(projectNames);
setPinsSource(pins);
setResponsesSource(readResponses);
setTodosSource(m => versionTodos(m.project, m.slug, latest(m)));
// 条目某个版本的主文档原文（审批单要从里面读题目）
function mainText(project, slug, ver) {
  if (!ver || ver.kind !== 'md') return '';
  const abs = safeJoin(path.join(DATA_DIR, project, slug, `v${ver.v}`), ver.main);
  try { return abs ? fs.readFileSync(abs, 'utf8') : ''; } catch { return ''; }
}
const clients = new Set();
const pending = new Map();
let flushTimer = null;
// 条目有变化：清缓存，合并 250ms 内的事件推给打开的页面。来源是 fs.watch，或 CLI 发布后的通知（/api/published）
let notifier = null; // 推送通知，见下面
function noteChange(project, slug) {
  INDEX = null;
  if (notifier) { const meta = readMeta(project, slug); if (meta?.versions?.length) { meta.project = project; meta.slug = slug; notifier.onChange(meta); } }
  pending.set(project + '/' + slug, { project, slug });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    for (const ev of pending.values()) {
      const msg = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const c of clients) c.write(msg);
    }
    pending.clear();
  }, 250);
}
// 监听出错（比如 Linux 上刚建的目录转眼就被删了）不能把服务带崩：记一笔，过一秒重新监听；这期间靠 index() 里的定时核对
function watchData() {
  try {
    const w = fs.watch(DATA_DIR, { recursive: true }, (_evt, filename) => {
      if (!filename) { INDEX = null; return; }
      const parts = filename.split(path.sep);
      if (parts.length < 2 || parts[0].startsWith('.')) return;
      const base = parts[parts.length - 1];
      if (parts.length > 2 && base !== 'meta.json') return; // 只关心 meta.json 和整个条目被删
      noteChange(parts[0], parts[1]);
    });
    w.on('error', e => { console.error(new Date().toISOString(), 'fs.watch lost track of a folder (', e.code || e.message, '), watching again'); try { w.close(); } catch {} INDEX = null; setTimeout(watchData, 1000).unref(); });
  } catch (e) { console.error('fs.watch failed; falling back to periodic index refresh:', e.message); }
}
watchData();

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();
// 推送：新版本发一条；每天定点一条今日摘要
notifier = createNotifier({
  items: () => index(), isMuted,
  describe: meta => {
    const l = meta.versions[meta.versions.length - 1]; const proj = projectNames()[meta.project]?.name || meta.project;
    const cat = l.category && l.category !== 'other' && Object.hasOwn(CATEGORY_LABEL, l.category) ? t(CATEGORY_LABEL[l.category]) : '';
    if (l.category === 'approval') return { title: t('Awaiting your approval: {title}', { title: l.title }), body: proj };
    if (l.category === 'todo') return { title: t('To-do for you: {title}', { title: l.title }), body: proj };
    return { title: `${proj}${cat ? ' · ' + cat : ''}${l.v > 1 ? ` · v${l.v}` : ''}`, body: l.title + (l.note ? `\n${l.note}` : '') };
  },
  log: m => console.error(new Date().toISOString(), m),
});
// 终端里的提问（lib/prompts.mjs）：等答案的进程长轮询；答了、回终端答、取消时叫醒它们
const promptWaiters = new Map();  // id → Set<resolve>
function wakePrompt(id) {
  for (const done of promptWaiters.get(id) || []) done();
  promptWaiters.delete(id);
  broadcast('prompt', { id }); broadcast('response', {});
}
// 30 秒（config.prompts.pushDelay）还没人答，推送到手机
function schedulePromptPush(p) {
  const delay = Number(readConfig().prompts?.pushDelay ?? 30) * 1000;
  if (delay < 0) return;
  setTimeout(() => {
    const cur = getPrompt(p.id); if (cur?.status !== 'pending') return;
    const c = readConfig(); const base = (c.httpsUrl || baseUrl()).replace(/\/+$/, '');
    const who = agentInfo(p.tool)?.name || 'mydash';
    sendPush({ title: t('{tool} is waiting for you · {project}', { tool: who, project: projectNames()[p.project]?.name || p.project }), body: promptTitle(p).slice(0, 200), link: `${base}/prompts/${p.id}` })
      .then(r => { if (!r.ok && r.error !== 'not configured') console.error(new Date().toISOString(), `prompt push failed: ${r.error}`); });
  }, Math.max(0, delay)).unref();
}
// 等答案的进程每 25 秒来问一次；45 秒没来（终端那边答了、按了 Esc，进程被结束），就算取消了
setInterval(() => { for (const p of reapPrompts()) wakePrompt(p.id); }, 10_000).unref();

// 待办的自动检测（<!-- check: 命令 -->）：每两分钟查一次；打开某份待办时也马上查它（同一份正在查时不重复，两次至少隔 5 秒）
const autoLog = m => console.log(new Date().toISOString(), m);
let checking = false;
async function autoCheck(only = null) {
  if (checking && !only) return;
  if (!only) checking = true;
  try { for (const id of await runChecks(index(), { only, log: autoLog })) { INDEX = null; broadcast('response', { id }); } }
  catch (e) { autoLog(`auto-check failed: ${e.message}`); }
  finally { if (!only) checking = false; }
}
const lastCheck = new Map(); const runningCheck = new Set();
function checkSoon(id) {
  const now = Date.now(); if (runningCheck.has(id) || now - (lastCheck.get(id) || 0) < 5_000) return;
  lastCheck.set(id, now); runningCheck.add(id); autoCheck(id).finally(() => runningCheck.delete(id));
}
setTimeout(() => autoCheck(), 20_000).unref();
setInterval(() => autoCheck(), 120_000).unref();
setInterval(() => notifier.tick(() => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone || undefined }).format(new Date());
  const items = index(); const n = items.filter(m => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone || undefined }).format(new Date(m.updated)) === today).length;
  const pend = items.filter(m => approvalState(m) === 'pending').length;
  const todo = items.reduce((a, m) => a + (todoState(m)?.left || 0), 0);
  if (!n && !pend && !todo) return null;
  const body = [pend ? t('{n} awaiting your approval', { n: pend }) : '', todo ? t('{n} to-do left|{n} to-dos left', { n: todo }) : ''].filter(Boolean).join(' · ');
  return { title: t('mydash today: {n} new|mydash today: {n} new', { n }), body: body || t('Tap to see today’s summary') };
}, cfg.timezone || undefined), 30_000).unref();
// 设置页传来的渠道字段：字符串当作网址；密码类留空就沿用已保存的；主字段为空就是关掉（返回 null）
// 设置页填的值和存着的合起来：密码类、带密钥的网址留空就用存着的
// clear：用户点了「清除」的字段（比如不再用的签名密钥），不沿用存着的值
function mergeChannel(type, input, old, clear = []) {
  const f = typeof input === 'string' ? { url: input } : input && typeof input === 'object' ? input : {};
  const keep = [...(CHANNELS[type].secret || []), ...(CHANNELS[type].hide || [])];
  const drop = new Set(Array.isArray(clear) ? clear.map(String) : []);
  const ch = { type };
  for (const k of CHANNELS[type].fields) {
    const v = String(f[k] ?? '').trim().slice(0, 500);
    ch[k] = v || (keep.includes(k) && old && !drop.has(k) ? old[k] || '' : '');
  }
  return ch[CHANNELS[type].main] ? ch : null;
}
function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); }

// install.sh 更新代码后 touch 这个文件，服务自行退出、由 launchd 拉起新代码（系统级模式下不需要 sudo）
const RESTART_FLAG = path.join(APP, '.restart');
let restartStamp = fs.existsSync(RESTART_FLAG) ? fs.statSync(RESTART_FLAG).mtimeMs : 0;
setInterval(() => {
  try { const m = fs.statSync(RESTART_FLAG).mtimeMs; if (m !== restartStamp) { console.log(new Date().toISOString(), 'code updated, restarting'); process.exit(0); } } catch {}
}, 2000).unref();

// ---------- 工具 ----------
function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  const csp = type.startsWith('text/html') ? { 'Content-Security-Policy': PAGE_CSP } : {};
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...csp, ...extra });
  res.end(body);
}

function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.sep + rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

async function sendFile(req, res, abs, { cache = 'no-cache', download = false, extra = {} } = {}) {
  let st;
  try { st = await fsp.stat(abs); } catch { return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  if (!st.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': mimeOf(abs), 'Cache-Control': cache, ETag: etag, 'Last-Modified': st.mtime.toUTCString(),
    'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start < 0) start = 0;
    if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(abs, { start, end }), res, () => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(abs), res, () => {});
}

// 第三方前端库：白名单映射到 node_modules
const NM = path.join(APP, 'node_modules');
const VENDOR_FILES = {
  'mermaid.min.js': path.join(NM, 'mermaid/dist/mermaid.min.js'),
  'hljs/github.min.css': path.join(NM, 'highlight.js/styles/github.min.css'),
  'hljs/github-dark.min.css': path.join(NM, 'highlight.js/styles/github-dark.min.css'),
};
const PDFJS = path.join(NM, 'pdfjs-dist');

const MANIFEST = JSON.stringify({
  name: 'mydash', short_name: 'mydash', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#f6f6f7', theme_color: '#3355ff', lang: htmlLang(),
  icons: [{ src: `/static/icon.svg?b=${BUILD}`, sizes: 'any', type: 'image/svg+xml' }, { src: `/static/icon-192.png?b=${BUILD}`, sizes: '192x192', type: 'image/png' }, { src: `/static/icon-512.png?b=${BUILD}`, sizes: '512x512', type: 'image/png' }, { src: `/static/icon-180.png?b=${BUILD}`, sizes: '180x180', type: 'image/png' }],
});

function decodeSegs(p) {
  try {
    const segs = p.split('/').filter(Boolean).map(decodeURIComponent);
    return segs.some(s => /[\/\\\0]/.test(s) || s === '.' || s === '..') ? null : segs;
  } catch { return null; }
}

// ---------- 写接口（已读/未读）----------
// 防跨站伪造：必须带自定义头（跨站请求会触发预检，而我们不放行任何跨域），Origin 若存在必须是自己
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 路由实际看到的路径（.. 和 %2e%2e 已经消掉），放行判断必须用同一个
function routePath(u) { try { return new URL(u, 'http://local').pathname; } catch { return ''; } }

// ---------- 谁在访问：本机和 tailnet 直接放行；局域网要登录；公网拒绝 ----------
// 返回 'ok'、'login'（局域网设备还没登录），或者已经回了错误时返回 null
function gate(req, res, port) {
  const where = classify(req.socket.remoteAddress);
  req.mydashWhere = where;
  if (where === 'local' || where === 'tailnet') return 'ok';
  // 别的机器带令牌来发布：tailnet 和局域网都行（令牌在 /api/remote/* 里再校验一次）
  if (where === 'lan' && port === PORT && routePath(req.url).startsWith('/api/remote/') && tokenName(req.headers.authorization)) return 'ok';
  if (where !== 'lan' || !LAN) { send(res, 403, 'Forbidden', 'text/plain; charset=utf-8'); return null; }
  if (!lanHostOk(req.headers.host, port)) { send(res, 421, 'Host not allowed', 'text/plain; charset=utf-8'); return null; }
  return validSession(req.headers.cookie) ? 'ok' : 'login';
}
// 只跳本站：/\evil、/<Tab>/evil 在浏览器里都等于 //evil
const safeNext = n => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) && !/[\0-\x1f\\]/.test(n) && !n.startsWith('/login') ? n : '/');

// 局域网设备登录：GET /login?code=…（二维码）或 POST 表单
async function handleLogin(req, res, url) {
  const ip = req.socket.remoteAddress;
  let code = url.searchParams.get('code'); let next = url.searchParams.get('next') || '/';
  if (req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req).catch(() => ''));
    code = form.get('code'); next = form.get('next') || next;
  }
  if (req.mydashWhere !== 'lan' || validSession(req.headers.cookie)) { res.writeHead(303, { Location: safeNext(next) }); return res.end(); }
  if (code == null) return send(res, 200, loginPage({ next: safeNext(next) }));
  if (rateLimited(ip)) return send(res, 429, loginPage({ next: safeNext(next), error: t('Too many wrong codes. Try again in 15 minutes.') }));
  if (!checkCode(code)) { noteFailure(ip); return send(res, 401, loginPage({ next: safeNext(next), error: t('That code is not right.') })); }
  res.writeHead(303, { Location: safeNext(next), 'Set-Cookie': sessionCookie(createSession(req.headers['user-agent'])), 'Cache-Control': 'no-store' });
  res.end();
}

// 在其他设备上打开：只给本机和 tailnet 看（访问码不能让局域网里还没登录的人拿到）
function accessInfo() {
  const urls = LAN ? lanUrls(PORT) : [];
  return {
    lan: LAN, urls, code: LAN ? prettyCode(accessCode()) : null, devices: LAN ? deviceCount() : 0,
    qr: LAN && urls.length ? qrSvg(loginUrl(urls[urls.length - 1])) : null, qrUrl: LAN && urls.length ? urls[urls.length - 1] : null,
    tailnet: cfg.access && cfg.access !== 'local' ? baseUrl() + '/' : null,
  };
}

let clientErrWindow = [];
async function handlePost(req, res) {
  const json = (status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
  if (req.headers['x-mydash'] !== '1') return json(403, { error: 'missing X-Mydash header' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: 'JSON required' });
  const origin = req.headers.origin;
  const originOk = h => (req.mydashWhere === 'lan' ? lanHostOk(h, PORT) : hostOk(h));
  if (origin) { try { if (!originOk(new URL(origin).host)) return json(403, { error: 'origin not allowed' }); } catch { return json(403, { error: 'origin not allowed' }); } }
  let body; try { body = JSON.parse(await readBody(req, 1024 * 1024) || '{}'); } catch (e) { return json(e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'body too large (1 MB max)' : 'body is not JSON' }); }
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/read') {
    const id = String(body.id || ''); const [project, slug] = id.split('/');
    const meta = project && slug ? readMeta(project, slug) : null;
    if (!meta) return json(404, { error: 'no such item' });
    let changed;
    if (body.unread) changed = markUnread(id);
    else { const vv = Math.min(Number(body.v) || latest(meta).v, latest(meta).v); changed = markRead(id, vv, meta.versions.find(x => x.v === vv)?.time); }
    if (changed) broadcast('read', { id });
    return json(200, { ok: true, changed });
  }
  if (url.pathname === '/api/pin') {
    const kind = body.kind === 'project' ? 'project' : 'item';
    const id = String(body.id || '');
    const exists = kind === 'project' ? index().some(m => m.project === id) : (() => { const [p, sl] = id.split('/'); return Boolean(p && sl && readMeta(p, sl)); })();
    if (!exists) return json(404, { error: kind === 'project' ? 'no such project' : 'no such item' });
    const changed = setPin(kind, id, Boolean(body.pinned));
    if (changed) broadcast('pin', { kind, id, pinned: Boolean(body.pinned) });
    return json(200, { ok: true, changed, pinned: Boolean(body.pinned) });
  }
  if (url.pathname === '/api/project-name') {
    const project = String(body.project || '');
    if (!index().some(m => m.project === project)) return json(404, { error: 'no such project' });
    const changed = setProjectName(project, body.name);
    const name = projectNames()[project]?.name || project;
    if (changed) broadcast('project', { project, name });
    return json(200, { ok: true, changed, name });
  }
  if (url.pathname === '/api/client-error') {
    // 浏览器端出错时回报到服务日志，方便排查具体设备上的问题
    const now = Date.now(); clientErrWindow = clientErrWindow.filter(t => now - t < 60_000);
    if (clientErrWindow.length < 30) {
      clientErrWindow.push(now);
      const clip = x => String(x ?? '').slice(0, 600);
      console.error(`${new Date().toISOString()} [client error] ${clip(body.page)} | ${clip(body.message)} | ${clip(req.headers['user-agent'])}`);
    }
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/published') {
    const project = String(body.project || ''), slug = String(body.slug || '');
    if (!readMeta(project, slug)) return json(404, { error: 'no such item' });
    noteChange(project, slug);
    return json(200, { ok: true });
  }
  // 审批单：提交答复
  if (url.pathname === '/api/approval') {
    const [project, slug] = String(body.id || '').split('/');
    const meta = project && slug ? readMeta(project, slug) : null;
    const ver = meta?.versions.find(x => x.v === Number(body.v));
    if (!ver) return json(404, { error: 'no such item or version' });
    const questions = questionsOf(mainText(project, slug, ver));
    if (!questions.length) return json(400, { error: 'this item has no approval form' });
    // 对话里定了、被取代、过期的：不再收网页上的答复
    meta.project = project; meta.slug = slug;
    const st = ver.v === latest(meta).v ? approvalStatus(meta) : null;
    if (st && ['chat', 'superseded', 'expired'].includes(st.state)) return json(409, { error: 'closed', how: st.state });
    const r = validateAnswers(questions, body.answers || {});
    if (!r.ok) return json(422, { error: 'missing answers', missing: r.errors });
    const submission = await addApproval(project, slug, { v: ver.v, answers: r.answers, from: req.mydashWhere });
    await syncOpen(project, slug);
    broadcast('response', { id: `${project}/${slug}` });
    return json(200, { ok: true, submission, summary: summarize(ver.title, ver.v, questions, r.answers) });
  }
  // 终端里的提问：钩子（bin/agent-ask.mjs）或 mydash ask 交过来
  if (url.pathname === '/api/prompts') {
    if (!promptsEnabled()) return json(409, { error: 'prompts are turned off' });
    const tool = String(body.tool || 'cli');
    const p = createPrompt({ tool, kind: String(body.kind || ''), project: String(body.project || '') || projectForSession(tool, String(body.session || ''), String(body.cwd || '')), session: body.session, cwd: body.cwd, payload: body.payload, both: body.both === true, appOnly: body.appOnly === true });
    if (!p) return json(400, { error: 'not a prompt mydash understands' });
    schedulePromptPush(p); wakePrompt(p.id);
    return json(200, { ok: true, id: p.id, url: `${(readConfig().httpsUrl || baseUrl()).replace(/\/+$/, '')}/prompts/${p.id}` });
  }
  {
    const m = url.pathname.match(/^\/api\/prompts\/(p[0-9a-f]{10})\/(answer|release|cancel)$/);
    if (m) {
      const [, id, action] = m;
      if (action === 'answer') {
        if (getPrompt(id)?.appOnly) return json(409, { error: 'answer it in the app', status: 'pending' });
        const r = answerPrompt(id, body, { by: 'web' });
        if (!r.ok) return json(r.code, { error: r.error, ...(r.question ? { question: r.question } : {}), ...(r.status ? { status: r.status } : {}) });
        wakePrompt(id); return json(200, { ok: true, prompt: r.prompt });
      }
      const p = getPrompt(id); if (!p) return json(404, { error: 'no such prompt' });
      if (p.status !== 'pending') return json(409, { error: 'already ' + p.status, status: p.status });
      setPromptStatus(id, action === 'release' ? 'released' : body.reason === 'terminal' ? 'terminal' : 'cancelled'); wakePrompt(id);
      return json(200, { ok: true, prompt: getPrompt(id) });
    }
  }
  // 「问一下」：用户在某一项待办、某一道审批题上提问，等 agent 用一两句话回答
  if (url.pathname === '/api/ask') {
    const [project, slug] = String(body.id || '').split('/');
    const meta = project && slug ? readMeta(project, slug) : null;
    const ver = meta?.versions.find(x => x.v === Number(body.v));
    if (!ver) return json(404, { error: 'no such item or version' });
    const text = String(body.text || '').trim();
    if (!text || text.length > ASK_MAX) return json(400, { error: 'question is empty or too long' });
    const kind = body.kind === 'approval' ? 'approval' : 'todo'; const key = String(body.key || '');
    let label = '';
    if (kind === 'todo') label = versionTodos(project, slug, ver).find(x => x.key === key)?.text || '';
    else {
      meta.project = project; meta.slug = slug;
      if (['chat', 'superseded', 'expired'].includes(approvalStatus(meta)?.state)) return json(409, { error: 'closed' });
      label = questionsOf(mainText(project, slug, ver)).find(q => q.id === key)?.label || '';
    }
    if (!label) return json(404, { error: 'no such item to ask about' });
    const ask = await addAsk(project, slug, { kind, key, label, v: ver.v, text, from: req.mydashWhere });
    await syncOpen(project, slug);
    broadcast('response', { id: `${project}/${slug}` });
    return json(200, { ok: true, ask });
  }
  // 命令行回答了提问（mydash asks reply）：通知打开着的页面
  if (url.pathname === '/api/responded') { broadcast('response', { id: String(body.id || '') }); return json(200, { ok: true }); }
  // 待办：勾上 / 取消
  if (url.pathname === '/api/todo') {
    const [project, slug] = String(body.id || '').split('/');
    const meta = project && slug ? readMeta(project, slug) : null;
    const ver = meta?.versions.find(x => x.v === Number(body.v));
    if (!ver) return json(404, { error: 'no such item or version' });
    const item = versionTodos(project, slug, ver).find(x => x.key === String(body.key || ''));
    if (!item) return json(404, { error: 'no such to-do' });
    const todos = await setTodo(project, slug, item.key, { done: body.done, text: item.text, v: ver.v, from: req.mydashWhere });
    await syncOpen(project, slug);
    broadcast('response', { id: `${project}/${slug}` });
    return json(200, { ok: true, todos });
  }
  // 批注：新增 / 删除（只能删还没处理的）
  if (url.pathname === '/api/comment' || url.pathname === '/api/comment/delete') {
    const [project, slug] = String(body.id || '').split('/');
    const meta = project && slug ? readMeta(project, slug) : null;
    if (!meta) return json(404, { error: 'no such item' });
    let comments;
    if (url.pathname === '/api/comment/delete') comments = await deleteComment(project, slug, String(body.cid || ''));
    else {
      if (!String(body.text || '').trim()) return json(400, { error: 'empty comment' });
      const v = meta.versions.some(x => x.v === Number(body.v)) ? Number(body.v) : latest(meta).v;
      comments = await addComment(project, slug, { v, file: body.file, quote: body.quote, heading: body.heading, text: body.text, from: req.mydashWhere });
    }
    broadcast('response', { id: `${project}/${slug}` });
    return json(200, { ok: true, comments });
  }
  // 静音项目 / 归档条目
  // 设置：自动归档天数、推送渠道、每日摘要时间。渠道：bark / ntfy 传网址字符串，其他传 { 字段 }；
  // 没传的渠道保持原样；密码类字段留空表示不改；主字段（见 notify.mjs 的 CHANNELS）为空表示关掉这个渠道
  // 设置页：改了就自动保存，每次送来改过的那几项（推送渠道走 /api/channels）
  if (url.pathname === '/api/settings') {
    const cur = readConfig(); const patch = {};
    if (body.autoArchiveDays !== undefined) {
      const days = Number(body.autoArchiveDays);
      if (!Number.isInteger(days) || days < 0 || days > 3650) return json(400, { error: 'autoArchiveDays must be a whole number of days, 0 = never', field: 'autoArchiveDays' });
      patch.autoArchiveDays = days;
    }
    if (body.daily !== undefined) {
      const daily = String(body.daily || '');
      if (daily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) return json(400, { error: 'daily must be HH:MM', field: 'daily' });
      const n = notifySettings(cur); patch.notify = { channels: n.channels, ...(daily ? { daily } : {}) };
    }
    // AI 工具的提问：总开关、两种问法、文字提问兜底、推送延迟（-1 不推）
    if (body.prompts && typeof body.prompts === 'object') {
      const p = { ...(cur.prompts || {}), ...body.prompts };
      patch.prompts = { enabled: p.enabled !== false, chat: p.chat !== false, mode: p.mode === 'hold' ? 'hold' : 'parallel', codexMode: p.codexMode === 'hold' ? 'hold' : 'app', pushDelay: [-1, 0, 30, 60].includes(Number(p.pushDelay)) ? Number(p.pushDelay) : 30 };
    }
    updateConfig(c => ({ ...c, ...patch }));
    INDEX = null;
    return json(200, { ok: true });
  }
  // 推送渠道：加、改、删、开关。同一种可以有好几个；回给页面新的列表（已经遮好密钥）
  if (url.pathname === '/api/channels') {
    const op = String(body.op || ''); const cur = notifySettings(); let list = cur.channels;
    const old = body.id ? list.find(c => c.id === body.id) : null;
    if (op !== 'add' && !old) return json(404, { error: 'no such channel' });
    if (op === 'remove') list = list.filter(c => c.id !== old.id);
    else if (op === 'toggle') list = list.map(c => (c.id === old.id ? { ...c, off: !body.on } : c));
    else if (op === 'add' || op === 'update') {
      const type = op === 'add' ? String(body.type || '') : old.type;
      if (!CHANNEL_TYPES.includes(type)) return json(400, { error: 'unknown channel' });
      const ch = mergeChannel(type, body.fields, old, body.clear);
      const bad = ch ? badField(ch) : CHANNELS[type].main;
      if (bad) return json(400, { error: `${bad} is missing or invalid`, field: bad });
      const main = CHANNELS[type].main;
      if (list.some(c => c.type === type && c[main] === ch[main] && c.id !== old?.id)) return json(409, { error: 'already added', field: main });
      const next = { ...ch, id: old?.id || newChannelId(), name: String(body.name ?? old?.name ?? '').trim().slice(0, 40), off: old?.off || false };
      list = op === 'add' ? [...list, next] : list.map(c => (c.id === old.id ? next : c));
    } else return json(400, { error: 'unknown op' });
    updateConfig(c => ({ ...c, notify: withChannels(cur, list) }));
    if (process.platform !== 'win32' && list.some(c => CHANNELS[c.type].secret || CHANNELS[c.type].hide)) { try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {} }
    const saved = notifySettings();
    return json(200, { ok: true, channels: saved.channels.map(publicChannel), html: channelRows(saved.channels), summary: pushSummary(saved.channels, subscriptions().length) });
  }
  // 设置页上的「发一条试试」：用输入框里的值（还没保存也行；密码类留空就用已保存的）
  if (url.pathname === '/api/notify-test') {
    const type = String(body.type || '');
    if (type === 'webpush' && !subscriptions().length) return json(200, { ok: false, error: t('No device has turned on web push yet.') });
    if (type === 'webpush') { const https = readConfig().httpsUrl || ''; return json(200, await sendWebPush({ title: 'mydash', body: t('Test notification'), link: https || baseUrl() }, { subject: https || baseUrl() })); }
    // 试已经存好的那一个（id），或者正在填的表单（type + fields；改的时候带上 id，留空的密钥用存着的）
    const saved = body.id ? notifySettings().channels.find(c => c.id === body.id) : null;
    if (body.id && !saved) return json(404, { error: 'no such channel' });
    const kind = saved?.type || type;
    if (!CHANNEL_TYPES.includes(kind)) return json(400, { error: 'unknown channel' });
    const ch = body.fields ? mergeChannel(kind, body.fields, saved, body.clear) : saved;
    const bad = ch ? badField(ch) : CHANNELS[kind].main;
    if (bad) return json(400, { error: `${bad} is missing or invalid`, field: bad });
    return json(200, await sendTo(ch, { title: 'mydash', body: t('Test notification'), link: baseUrl() }));
  }
  // 网页推送：这台设备的浏览器订阅 / 取消
  if (url.pathname === '/api/webpush/subscribe') {
    const n = addSubscription(body.subscription, { device: String(req.headers['user-agent'] || '') });
    return n ? json(200, { ok: true, devices: n }) : json(400, { error: 'not a valid push subscription' });
  }
  if (url.pathname === '/api/webpush/unsubscribe') return json(200, { ok: true, removed: removeSubscription(String(body.endpoint || '')), devices: subscriptions().length });
  // Telegram：找出给机器人发过消息的那个 chat
  if (url.pathname === '/api/telegram-chat') {
    const token = String(body.token || '').trim() || (body.id ? notifySettings().channels.find(c => c.type === 'telegram' && c.id === body.id)?.token : '') || '';
    if (!/^\d+:[\w-]{20,}$/.test(token)) return json(400, { error: 'bot token is missing or invalid', field: 'token' });
    return json(200, await telegramChat(token));
  }
  if (url.pathname === '/api/mute') {
    const project = String(body.project || '');
    if (!index().some(m => m.project === project)) return json(404, { error: 'no such project' });
    setMuted(project, Boolean(body.muted)); broadcast('read', { project });
    return json(200, { ok: true, muted: Boolean(body.muted) });
  }
  if (url.pathname === '/api/archive') {
    const id = String(body.id || ''); const [project, slug] = id.split('/');
    if (!project || !slug || !readMeta(project, slug)) return json(404, { error: 'no such item' });
    setArchived(id, Boolean(body.archived)); broadcast('read', { id });
    return json(200, { ok: true, archived: Boolean(body.archived) });
  }
  if (url.pathname === '/api/read-all') {
    const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    const items = index().filter(m => (!body.project || m.project === body.project) && (!ids || ids.has(`${m.project}/${m.slug}`)));
    const n = markAllRead(items);
    if (n) broadcast('read', { all: true, project: body.project || null });
    return json(200, { ok: true, marked: n });
  }
  return json(404, { error: 'not found' });
}

// 原始文件：/f/<project>/<slug>/v<N>/<path...>
// 工作台端口上，会运行脚本的文件（网页、SVG）加 CSP sandbox：直接打开也拿不到工作台的同源权限
const SANDBOX = { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads' };
function serveRaw(req, res, url, segs, isolated) {
  if (segs.length < 5 || !/^v\d+$/.test(segs[3])) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const [, project, slug, vdir, ...rest] = segs;
  if ([project, slug, ...rest].some(x => x.startsWith('.'))) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const root = path.join(DATA_DIR, project, slug, vdir);
  const abs = safeJoin(root, rest.join('/'));
  if (!abs || !abs.startsWith(DATA_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const extra = !isolated && ACTIVE_RE.test(abs) ? SANDBOX : {};
  return sendFile(req, res, abs, { download: url.searchParams.has('dl'), extra });
}

// 内容端口：只读，只有原始文件
async function handleContent(req, res) {
  const g = gate(req, res, CONTENT_PORT); if (!g) return;
  if (g === 'login') return send(res, 401, 'Log in on the workbench first', 'text/plain; charset=utf-8');
  if (req.mydashWhere !== 'lan' && !contentHostOk(req.headers.host || '') && !(LAN && lanHostOk(req.headers.host, CONTENT_PORT))) return send(res, 421, 'Host not allowed', 'text/plain; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8', { 'X-Mydash-Id': INSTALL_ID });
  const segs = decodeSegs(url.pathname);
  if (!segs || segs[0] !== 'f') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  return serveRaw(req, res, url, segs, true);
}

// ---------- 跨机器发布 /api/remote/*（Authorization: Bearer <令牌>）----------
const UPLOADS = path.join(DATA_DIR, '.uploads');
const okRel = p => typeof p === 'string' && p && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(x => x === '..' || x === '' || x.startsWith('.'));
function uploadDir(id) { return /^[a-f0-9]{24}$/.test(id) ? path.join(UPLOADS, id) : null; }
async function handleRemote(req, res, url) {
  const json = (status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
  const who = tokenName(req.headers.authorization);
  if (!who) return json(401, { error: 'invalid or missing token' });
  const segs = url.pathname.split('/').filter(Boolean); // api remote …
  if (url.pathname === '/api/remote/ping') return json(200, { ok: true, name: who, host: os.hostname(), url: baseUrl() });
  if (url.pathname === '/api/remote/items' && req.method === 'GET') {
    const proj = url.searchParams.get('project');
    return json(200, index().filter(m => !proj || m.project === proj).map(m => { const l = latest(m); return { project: m.project, slug: m.slug, title: m.title, version: l.v, updated: m.updated, url: baseUrl() + `/p/${encodeURIComponent(m.project)}/${encodeURIComponent(m.slug)}` }; }));
  }
  if (url.pathname === '/api/remote/feedback' && req.method === 'GET') {
    const proj = url.searchParams.get('project'), sl = url.searchParams.get('slug'), all = url.searchParams.has('all');
    const out = [];
    for (const m of index()) {
      if (!all && (m.project !== proj || (sl && m.slug !== sl))) continue;
      for (const c of openCm(readResp(m.project, m.slug))) out.push({ id: c.id, item: `${m.project}/${m.slug}`, title: m.title, url: baseUrl() + `/p/${encodeURIComponent(m.project)}/${encodeURIComponent(m.slug)}`, v: c.v, latest: latest(m).v, file: c.file, heading: c.heading, quote: c.quote, text: c.text, createdAt: c.createdAt });
    }
    return json(200, { ok: true, open: out });
  }
  if (url.pathname === '/api/remote/feedback/done' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req, 64 * 1024) || '{}'); } catch { return json(400, { error: 'body is not JSON' }); }
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String); let n = 0;
    for (const m of index()) if (readResp(m.project, m.slug).comments.some(c => ids.includes(c.id) && c.status === 'open')) n += await resolveCm(m.project, m.slug, ids, { note: String(body.note || '') });
    if (n) broadcast('response', {});
    return json(200, { ok: true, resolved: n });
  }
  if (url.pathname === '/api/remote/start' && req.method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req, 2 * 1024 * 1024) || '{}'); } catch { return json(400, { error: 'body is not JSON' }); }
    const project = cleanName(b.project || ''), slug = cleanName(b.slug || '');
    const files = Array.isArray(b.files) ? b.files : [];
    if (!project || !slug || !files.length || files.length > 3000 || !files.every(f => okRel(f.path) && /^[a-f0-9]{40}$/.test(f.sha1) && Number.isFinite(f.size) && f.size >= 0)) return json(400, { error: 'bad request' });
    if (files.reduce((n, f) => n + f.size, 0) > 800 * 1024 * 1024) return json(413, { error: 'too large (800 MB max)' });
    // 上一版里已经有的内容（按 sha1）不用再传
    const meta = readMeta(project, slug); const prev = meta ? latest(meta) : null;
    const have = new Set((prev?.files || []).map(f => f.sha1).filter(Boolean));
    const id = crypto.randomBytes(12).toString('hex'); const dir = uploadDir(id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    // 清掉两小时前没完成的上传
    try { for (const d of fs.readdirSync(UPLOADS)) { const st = fs.statSync(path.join(UPLOADS, d)); if (Date.now() - st.mtimeMs > 2 * 3600_000) fs.rmSync(path.join(UPLOADS, d), { recursive: true, force: true }); } } catch {}
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...b, project, slug, by: who }));
    return json(200, { ok: true, uploadId: id, need: files.filter(f => !have.has(f.sha1)).map(f => f.path) });
  }
  const dir = segs[2] ? uploadDir(segs[2]) : null;
  if (!dir || !fs.existsSync(dir)) return json(404, { error: 'no such upload' });
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (segs[3] === 'file' && req.method === 'PUT') {
    const rel = url.searchParams.get('path') || '';
    const f = man.files.find(x => x.path === rel); if (!f || !okRel(rel)) return json(400, { error: 'unknown file' });
    const out = path.join(dir, 'files', ...rel.split('/'));
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); if (fs.existsSync(out) && !fs.statSync(out).isFile()) throw new Error('not a file'); } catch { return json(400, { error: `cannot write ${rel}` }); }
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch {}
    const h = crypto.createHash('sha1'); let size = 0; const ws = fs.createWriteStream(out);
    const ok = await new Promise((resolve, reject) => {
      ws.on('error', reject);
      req.on('data', c => { size += c.length; if (size > f.size) { req.destroy(); reject(new Error('larger than announced')); return; } h.update(c); ws.write(c); });
      req.on('end', () => ws.end(() => resolve(true))); req.on('error', reject);
    }).catch(e => { ws.destroy(); try { fs.rmSync(out, { force: true }); } catch {} return e; });
    if (ok !== true) return json(400, { error: `upload failed: ${rel}: ${ok.message}` });
    if (size !== f.size || h.digest('hex') !== f.sha1) { fs.rmSync(out, { force: true }); return json(400, { error: `checksum mismatch: ${rel}` }); }
    return json(200, { ok: true });
  }
  if (segs[3] === 'finish' && req.method === 'POST') {
    // 收到的文件；没传的（上一版已有）按 sha1 从上一版找
    const meta = readMeta(man.project, man.slug); const prev = meta ? latest(meta) : null;
    const prevBySha = new Map((prev?.files || []).filter(f => f.sha1).map(f => [f.sha1, path.join(DATA_DIR, man.project, man.slug, `v${prev.v}`, ...f.path.split('/'))]));
    const entries = [];
    for (const f of man.files) {
      const staged = path.join(dir, 'files', ...f.path.split('/'));
      const src = fs.existsSync(staged) ? staged : prevBySha.get(f.sha1);
      if (!src || !fs.existsSync(src)) return json(400, { error: `missing file: ${f.path}` });
      entries.push({ src, dest: f.path });
    }
    if (!entries.some(e => e.dest === man.main)) return json(400, { error: 'main is not one of the files' });
    const mainSrc = entries.find(e => e.dest === man.main)?.src;
    let mainMd = ''; if (kindOf(man.main) === 'md' && mainSrc) { try { mainMd = fs.readFileSync(mainSrc, 'utf8'); } catch {} }
    const result = await commitPublish({ project: man.project, slug: man.slug, title: String(man.title || man.slug), titleSource: man.titleSource || 'flag', entries, main: man.main, mainMd, sources: man.sources || [], cwd: man.cwd || '', agent: man.agent || null, projectNote: man.projectNote || '', host: String(man.host || man.by).slice(0, 80), remote: true }, { note: man.opts?.note || '', type: man.opts?.type || '', resolves: man.opts?.resolves || '' });
    fs.rmSync(dir, { recursive: true, force: true });
    noteChange(man.project, man.slug);
    return json(200, result);
  }
  return json(404, { error: 'not found' });
}

// 开了 HTTPS 后：用 tailnet 的名字走 HTTP 打开网页（比如 http://mydash/），跳到 HTTPS 的同一页，这样只用记 mydash。
// HTTPS 证书只能发给完整域名，https://mydash/ 本身做不到。本机、局域网、/api/ 不跳（命令行和别的机器发布都走这些）。
// tailscale serve 转发 HTTPS 时带 X-Forwarded-Proto: https。config.httpsRedirect = false 可以关掉
function httpsTarget(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.headers['x-forwarded-proto'] === 'https' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return null;
  if (!TAILNET_MAIN?.test(String(req.headers.host || ''))) return null;
  const c = readConfig();
  return c.httpsUrl && c.httpsRedirect !== false ? c.httpsUrl.replace(/\/+$/, '') + req.url : null;
}

// ---------- 路由 ----------
async function handle(req, res) {
  const g = gate(req, res, PORT); if (!g) return;
  if (req.mydashWhere !== 'lan' && !hostOk(req.headers.host || '') && !(LAN && lanHostOk(req.headers.host, PORT))) return send(res, 421, 'Host not allowed', 'text/plain; charset=utf-8');
  const url = new URL(req.url, 'http://local');
  const up = httpsTarget(req, url);
  if (up) { res.writeHead(302, { Location: up, 'Cache-Control': 'no-store' }); return res.end(); }
  if (url.pathname.startsWith('/api/remote/')) return handleRemote(req, res, url);
  if (url.pathname === '/login') return handleLogin(req, res, url);
  if (g === 'login') {
    // 还没登录的局域网设备：只给登录页要用的静态资源，其余去登录
    const open = url.pathname === '/healthz' || url.pathname === '/i18n.js' || url.pathname === '/favicon.ico' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/static/');
    if (!open) {
      if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }); return res.end(); }
      return send(res, 401, 'Log in first', 'text/plain; charset=utf-8');
    }
  }
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
  const segs = decodeSegs(url.pathname);
  if (!segs) return send(res, 400, 'Bad path encoding', 'text/plain; charset=utf-8');

  // 还在等的提问（给页面和测试用）
  if (url.pathname === '/api/prompts') {
    const list = allPrompts().filter(p => p.status === 'pending').map(p => ({ id: p.id, kind: p.kind, tool: p.tool, project: p.project, title: promptTitle(p), at: p.at }));
    return send(res, 200, JSON.stringify({ prompts: list }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  // 等答案：最多挂 25 秒，期间答了 / 回终端答 / 取消了就马上返回
  {
    const m = url.pathname.match(/^\/api\/prompts\/(p[0-9a-f]{10})\/wait$/);
    if (m) {
      const id = m[1]; const reply = () => { const p = touchPrompt(id); return send(res, p ? 200 : 404, JSON.stringify(p ? { status: p.status, answer: p.answer || null, kind: p.kind } : { error: 'no such prompt' }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' }); };
      const p = touchPrompt(id); if (!p || p.status !== 'pending') return reply();
      await new Promise(resolve => {
        const set = promptWaiters.get(id) || new Set(); promptWaiters.set(id, set); set.add(resolve);
        const timer = setTimeout(resolve, 25_000); res.on('close', () => { clearTimeout(timer); resolve(); });
      });
      if (res.writableEnded || res.destroyed) return;
      return reply();
    }
  }
  if (url.pathname.startsWith('/prompts/')) {
    const p = getPrompt(url.pathname.slice('/prompts/'.length));
    return p ? send(res, 200, promptPage(p)) : send(res, 404, notFoundPage(t('No such question. It may have been cleared.')));
  }

  if (url.pathname === '/api/access') {
    if (req.mydashWhere === 'lan') return send(res, 403, JSON.stringify({ error: 'only on this computer or the tailnet' }), 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(accessInfo()), 'application/json; charset=utf-8');
  }

  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8', { 'X-Mydash-Id': INSTALL_ID });
  if (url.pathname === '/manifest.webmanifest') return send(res, 200, MANIFEST, 'application/manifest+json');
  // 浏览器默认会请求 /favicon.ico：每次都重新确认，图标换了马上生效
  if (url.pathname === '/favicon.ico') return sendFile(req, res, path.join(APP, 'static', 'favicon.ico'), { cache: 'no-cache' });

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/index') {
    const items = index().map(m => { const l = latest(m); return { project: m.project, slug: m.slug, title: m.title, updated: m.updated, version: l.v, kind: l.kind, url: baseUrl() + `/p/${encodeURIComponent(m.project)}/${encodeURIComponent(m.slug)}` }; });
    return send(res, 200, JSON.stringify(items), 'application/json; charset=utf-8');
  }

  // 全文搜索
  if (url.pathname === '/api/search') {
    const proj = url.searchParams.get('project') || '';
    const hits = search(index().filter(m => !proj || m.project === proj), url.searchParams.get('q') || '');
    return send(res, 200, JSON.stringify(hits.map(h => ({ id: `${h.m.project}/${h.m.slug}`, title: h.m.title, project: h.m.project, url: `/p/${encodeURIComponent(h.m.project)}/${encodeURIComponent(h.m.slug)}`, hits: h.hits, snippet: h.snippet }))), 'application/json; charset=utf-8');
  }
  if (url.pathname === '/api/sidebar') return send(res, 200, sidebar(url.searchParams.get('current') || ''));

  if (url.pathname === '/i18n.js') return send(res, 200, i18nJs(lang()), 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });

  if (segs[0] === 'static' && segs.length >= 2 && segs.length <= 3) {
    const abs = safeJoin(path.join(APP, 'static'), segs.slice(1).join('/'));
    return abs ? sendFile(req, res, abs, { cache: 'public, max-age=86400' }) : send(res, 404, 'not found');
  }

  if (segs[0] === 'vendor') {
    const rel = segs.slice(1).join('/');
    if (VENDOR_FILES[rel]) return sendFile(req, res, VENDOR_FILES[rel], { cache: 'public, max-age=604800' });
    if (segs[1] === 'pdfjs' && ['build', 'cmaps', 'standard_fonts'].includes(segs[2])) {
      const abs = safeJoin(PDFJS, segs.slice(2).join('/'));
      if (abs) return sendFile(req, res, abs, { cache: 'public, max-age=604800' });
    }
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }

  if (segs[0] === 'f') return serveRaw(req, res, url, segs, false);

  if (url.pathname === '/' || url.pathname === '') return send(res, 200, homePage(index(), { showArchived: url.searchParams.has('archived') }));
  if (url.pathname === '/today') return send(res, 200, digestPage(index()));
  if (url.pathname === '/settings') return send(res, 200, settingsPage({ archiveDays: autoArchiveDays(), notify: notifySettings(), timezone: cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, webpush: { httpsUrl: readConfig().httpsUrl || '', devices: subscriptions().length }, prompts: readConfig().prompts || {} }));
  // 网页推送：service worker 要放在根路径，才能管整个网站
  if (url.pathname === '/sw.js') return send(res, 200, fs.readFileSync(path.join(APP, 'static', 'sw.js')), 'text/javascript; charset=utf-8', { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' });
  // 某个条目上的提问和回答（agent 回答后，打开着的页面据此刷新）
  if (url.pathname === '/api/asks') {
    const [project, slug] = String(url.searchParams.get('id') || '').split('/');
    if (!project || !slug || !readMeta(project, slug)) return send(res, 404, '{}', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify({ asks: readResponses(project, slug).asks }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  // 待办的勾选状态（自动检测勾上后，打开着的页面据此刷新）
  if (url.pathname === '/api/todos') {
    const [project, slug] = String(url.searchParams.get('id') || '').split('/'); const meta = project && slug ? readMeta(project, slug) : null;
    if (!meta) return send(res, 404, '{}', 'application/json; charset=utf-8');
    const st = todoProgress(versionTodos(project, slug, latest(meta)), readResponses(project, slug).todos);
    return send(res, 200, JSON.stringify({ v: latest(meta).v, done: Object.fromEntries(st.items.map(x => [x.key, x.done])) }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === '/api/webpush') return send(res, 200, JSON.stringify({ publicKey: vapidKeys().publicKey, devices: subscriptions().length, httpsUrl: readConfig().httpsUrl || '' }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  if (segs[0] === 'p' && segs.length === 2) {
    const items = index().filter(m => m.project === segs[1]);
    if (!items.length) return send(res, 404, notFoundPage(t('Nothing has been published to this project yet.')));
    return send(res, 200, projectPage(segs[1], items, { showArchived: url.searchParams.has('archived') }));
  }

  if (segs[0] === 'p' && segs.length === 3) {
    const [, project, slug] = segs;
    if (project.startsWith('.') || slug.startsWith('.')) return send(res, 404, notFoundPage());
    const meta = readMeta(project, slug);
    if (!meta || !meta.versions?.length) return send(res, 404, notFoundPage(t('No such item. It may have been deleted.')));
    meta.project = project; meta.slug = slug;
    const vq = Number(url.searchParams.get('v'));
    const ver = (vq && meta.versions.find(x => x.v === vq)) || latest(meta);
    const fileSet = new Set(ver.files.map(f => f.path));
    let rel = url.searchParams.get('f');
    if (!rel || !fileSet.has(rel)) rel = ver.main;
    const images = ver.files.filter(f => f.kind === 'image');
    const gallery = !url.searchParams.get('f') && images.length > 1 && images.length === ver.files.length;
    const fileEntry = ver.files.find(f => f.path === rel);
    const mode = url.searchParams.get('mode') === 'text' ? 'text' : '';
    let rendered = null;
    if (!gallery) {
      const abs = safeJoin(path.join(DATA_DIR, project, slug, `v${ver.v}`), rel);
      if (!abs) return send(res, 404, notFoundPage());
      try { rendered = await renderFile({ abs, rel, project, slug, v: ver.v, fileSet, preview: fileEntry?.preview, pages: fileEntry?.pages, mode, todo: rel !== ver.main ? '' : ver.category === 'todo' ? 'all' : 'blocks', checks: checksAllowed(ver) }); }
      catch (e) { return send(res, 404, notFoundPage(t('The file is missing: {msg}', { msg: e.message }))); }
    }
    // ?diff=<旧版本号>：和那个版本对比（同一个文件）
    let diff = null;
    const dv = Number(url.searchParams.get('diff'));
    const fromVer = dv ? meta.versions.find(x => x.v === dv) : null;
    if (fromVer && fromVer.v !== ver.v && DIFFABLE.has(kindOf(rel))) {
      const read = v => { const abs = safeJoin(path.join(DATA_DIR, project, slug, `v${v}`), rel); try { const b = fs.readFileSync(abs); return b.length > 2 * 1024 * 1024 ? null : b.toString('utf8'); } catch { return ''; } };
      const oldT = read(fromVer.v), newT = read(ver.v);
      diff = oldT == null || newT == null ? { html: `<p class="diff-big">${t('This file is too large to compare.')}</p>`, added: 0, removed: 0 } : renderDiff(oldT, newT, { fromV: fromVer.v, toV: ver.v });
      Object.assign(diff, { fromV: fromVer.v, toV: ver.v });
    }
    if (versionTodos(project, slug, latest(meta)).some(x => x.check)) checkSoon(`${project}/${slug}`);
    const responses = readResponses(project, slug);
    const mdText = rendered?.needs?.approval ? mainText(project, slug, ver) : '';
    const sub = mdText ? latestApproval(responses, ver.v) : null;
    const approvalSummary = sub ? summarize(ver.title, ver.v, questionsOf(mdText), sub.answers) : '';
    const todos = rendered?.needs?.todo && rel === ver.main && !diff ? todoProgress(versionTodos(project, slug, ver), responses.todos) : null;
    return send(res, 200, itemPage(meta, ver, rel, rendered, gallery, { fileEntry, mode, responses, approvalSummary, mdText, diff, diffable: DIFFABLE.has(kindOf(rel)), todos }));
  }

  return send(res, 404, notFoundPage());
}

// 页面语言：这台设备选过的（cookie mydash_lang，设置页和顶栏的切换按钮写的；/i18n.js?l= 也算），没选过就用安装时的
const reqLang = req => (/[?&]l=(zh|en)\b/.exec(req.url || '') || /(?:^|;\s*)mydash_lang=(zh|en)\b/.exec(req.headers.cookie || '') || [])[1] || defaultLang();
const wrap = fn => (req, res) => {
  withLang(reqLang(req), () => fn(req, res)).catch(e => {
    console.error(new Date().toISOString(), req.url, e);
    if (!res.headersSent) send(res, 500, 'Server error: ' + e.message, 'text/plain; charset=utf-8');
    else res.end();
  });
};
// 每个 地址:端口 一个监听。本机的两个是必需的，失败就退出（让 launchd / systemd 重启）；
// 局域网的失败只记一次日志，服务照常运行，30 秒后再试
const listeners = new Map(); const reported = new Set();
function open(handler, addr, port, required) {
  const key = `${addr}|${port}`; if (listeners.has(key)) return;
  const srv = http.createServer(wrap(handler)); srv.keepAliveTimeout = 65000;
  srv.on('error', e => {
    listeners.delete(key);
    if (required) { console.error(new Date().toISOString(), `cannot listen on ${addr}:${port}: ${e.code}`); process.exit(1); }
    if (!reported.has(key)) { reported.add(key); console.error(new Date().toISOString(), `LAN: cannot listen on ${addr}:${port} (${e.code}); will retry`); }
  });
  srv.on('listening', () => reported.delete(key));
  srv.listen(port, addr); listeners.set(key, srv);
}
const hasContent = CONTENT_PORT && CONTENT_PORT !== PORT;
// 跟着网络变化：换了 WiFi 或路由器重新分配地址时，补上新地址、关掉没了的
function syncLan() {
  const want = new Set(LAN ? lanAddresses() : []);
  for (const [key, srv] of listeners) { const addr = key.split('|')[0]; if (addr !== HOST && !want.has(addr)) { srv.close(); listeners.delete(key); } }
  for (const a of want) { open(handle, a, PORT, false); if (hasContent) open(handleContent, a, CONTENT_PORT, false); }
}
open(handle, HOST, PORT, true);
if (hasContent) open(handleContent, HOST, CONTENT_PORT, true);
syncLan();
if (LAN) setInterval(syncLan, 30_000).unref();
console.log(`${new Date().toISOString()} mydash started http://${HOST}:${PORT}  content :${CONTENT_PORT}  data ${DATA_DIR}  url ${baseUrl()}${LAN ? '  lan ' + lanUrls(PORT).join(' ') : ''}`);
// 独立 Tailscale 节点：登录批准后自动配好转发
if (cfg.access === 'tailscale-node') watchNode({
  tcp: () => (Array.isArray(readConfig().nodeTcp) ? readConfig().nodeTcp : []), // mydash forward 22 5900
  port: PORT, contentPort: CONTENT_PORT, httpsContentPort: HTTPS_CONTENT_PORT, log: m => console.log(new Date().toISOString(), m),
  // tailnet 开了 HTTPS：记下 HTTPS 网址（网页推送、设置页要用）
  onName: useNodeName,
  onHttps: url => { if (readConfig().httpsUrl !== url) { updateConfig(c => ({ ...c, httpsUrl: url })); console.log(new Date().toISOString(), `https on: ${url}`); } },
});
