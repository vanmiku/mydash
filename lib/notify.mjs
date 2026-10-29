// 推送到手机：agent 发了新版本时通知一条（静音的项目不通知），可选每天定点发一条今日摘要。
// 渠道可以同时开好几个：
//   bark（iPhone）· ntfy · telegram（机器人）· pushover · webhook（企业微信 / 飞书 / 钉钉 / Slack / Discord 群机器人，按网址认）· email（SMTP）
//   · webpush（网页推送，见 webpush.mjs；不用填，浏览器订阅了就算开着）
// 只有标题、项目名和链接会经过推送服务，正文内容不会。
// 配置在 config.json 的 notify：{ channels: [{ id, type, name?, off?, ...字段 }], daily: "21:00" }（旧格式 { type, url } 也认）
// 同一种渠道可以加好几个（比如两台 iPhone 各一个 Bark）：每个有自己的 id、可选的名字，可以单独停用（off）
import crypto from 'node:crypto';
import { readConfig, baseUrl, itemPath } from './store.mjs';
import { sendMail } from './smtp.mjs';
import { subscriptions, sendWebPush } from './webpush.mjs';

// 每种渠道的字段：main 是"填了才算开着"的那个；secret 是密码类，设置页不回显，留空表示不改；
// hide 是带着密钥的网址（Bark 的设备 key、ntfy 话题、群机器人的 token），设置页只显示前后几位，留空也表示不改
export const CHANNELS = {
  bark: { fields: ['url'], main: 'url', hide: ['url'] },
  ntfy: { fields: ['url'], main: 'url', hide: ['url'] },
  telegram: { fields: ['token', 'chat'], main: 'chat', secret: ['token'] },
  pushover: { fields: ['user', 'token'], main: 'user', secret: ['token'] },
  webhook: { fields: ['url', 'secret'], main: 'url', secret: ['secret'], hide: ['url'] },
  email: { fields: ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'], main: 'host', secret: ['pass'] },
};
export const CHANNEL_TYPES = Object.keys(CHANNELS);
const okUrl = u => /^https?:\/\/\S+$/.test(String(u || ''));

// 字段齐不齐、对不对；返回错误的字段名，没问题就是 null
export function badField(ch) {
  const v = k => String(ch[k] ?? '').trim();
  switch (ch.type) {
    case 'bark': case 'ntfy': case 'webhook': return okUrl(v('url')) ? null : 'url';
    case 'telegram': return !/^\d+:[\w-]{20,}$/.test(v('token')) ? 'token' : !/^-?\d+$|^@\w{4,}$/.test(v('chat')) ? 'chat' : null;
    case 'pushover': return !/^\w{20,40}$/.test(v('user')) ? 'user' : !/^\w{20,40}$/.test(v('token')) ? 'token' : null;
    case 'email': {
      if (!/^[\w.-]+$/.test(v('host'))) return 'host';
      if (v('port') && !/^\d{1,5}$/.test(v('port'))) return 'port';
      if (!['tls', 'starttls', 'none'].includes(v('secure') || 'starttls')) return 'secure';
      if (!/@/.test(v('from') || v('user'))) return 'from';
      return /@/.test(v('to')) ? null : 'to';
    }
    default: return 'type';
  }
}
// id：存过的就用存的；旧配置里没有的，按类型和主字段算一个固定的（每次读出来都一样）
const chId = ch => 'c' + crypto.createHash('sha1').update(`${ch.type}|${String(ch[CHANNELS[ch.type].main] ?? '').trim()}`).digest('hex').slice(0, 8);
export const newChannelId = () => 'c' + crypto.randomBytes(4).toString('hex');
const clean = ch => Object.fromEntries([
  ['id', /^c[0-9a-f]{8}$/.test(ch.id || '') ? ch.id : chId(ch)], ['type', ch.type],
  ...(String(ch.name ?? '').trim() ? [['name', String(ch.name).trim().slice(0, 40)]] : []), ...(ch.off ? [['off', true]] : []),
  ...CHANNELS[ch.type].fields.map(k => [k, String(ch[k] ?? '').trim()]).filter(([, x]) => x),
]);
// 设置页上显示的样子：网址留协议和域名；路径里最后一段（Bark 的 key、ntfy 的话题、群机器人的令牌）和所有长的一段只留前后几位，
// 网址末尾的 / 不算一段；查询参数的值全遮住（钉钉的 access_token 在这里）。不是网址的留后四位
export function maskValue(v) {
  const s = String(v || '');
  const tail = x => (x.length <= 8 ? '••••' : `${x.slice(0, 3)}…${x.slice(-3)}`);
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(s);
  if (!m) return s ? `••••${s.slice(-4)}` : '';
  const segs = m[2].split('/'); const last = segs.reduce((k, x, i) => (x ? i : k), -1);
  const p = segs.map((x, i) => (x && (i === last || x.length > 8) ? tail(x) : x)).join('/');
  const q = m[3] ? '?' + m[3].slice(1).split('&').map(kv => kv.replace(/=.*/, '=••••')).join('&') : '';
  return m[1] + p + q;
}
// 给设置页的：不含密码，带密钥的网址只给遮住的样子
export function publicChannel(ch) {
  const spec = CHANNELS[ch.type]; const hidden = [...(spec.secret || []), ...(spec.hide || [])];
  return { id: ch.id, type: ch.type, name: ch.name || '', off: Boolean(ch.off),
    values: Object.fromEntries(spec.fields.filter(k => !hidden.includes(k) && ch[k]).map(k => [k, ch[k]])),
    masked: Object.fromEntries(hidden.filter(k => ch[k]).map(k => [k, maskValue(ch[k])])) };
}

// 原样读出（没有渠道时也返回，设置页要用）：{ channels, daily }
export function notifySettings(cfg = readConfig()) {
  const n = cfg.notify || {};
  const list = Array.isArray(n.channels) ? n.channels : n.type && n.url ? [{ type: n.type, url: n.url }] : [];
  const seen = new Set();
  const channels = list.filter(c => CHANNELS[c?.type] && !badField(c)).map(clean).filter(c => !seen.has(c.id) && seen.add(c.id));
  return { channels, daily: /^([01]\d|2[0-3]):[0-5]\d$/.test(n.daily || '') ? n.daily : '' };
}
// 生效的推送配置；一个渠道都没有就是 null
export function notifyConfig() {
  const n = notifySettings(); n.channels = n.channels.filter(c => !c.off);
  if (subscriptions().length) n.channels.push({ type: 'webpush' });
  return n.channels.length ? n : null;
}
// HTTPS 的网址（开了 HTTPS 才有）：网页推送只能在 HTTPS 下用，点通知也要打开 HTTPS 的页面
export const httpsUrl = () => readConfig().httpsUrl || '';
// 改某个渠道：fields 为空就去掉；字符串当作 url（bark / ntfy / webhook 的旧写法）。返回新的 notify 对象
export function withChannel(notify, type, fields, { name } = {}) {
  const n = notifySettings({ notify });
  const f = typeof fields === 'string' ? { url: fields } : fields;
  if (!f) return withChannels(n, n.channels.filter(c => c.type !== type)); // 这一种全部去掉
  // 同一个目标（主字段一样）就更新它，否则新加一个：同一种可以有好几个
  const main = CHANNELS[type].main; const same = n.channels.find(c => c.type === type && c[main] === String(f[main] ?? '').trim());
  const ch = clean({ ...(same || {}), ...f, type, id: same?.id || newChannelId(), ...(name ? { name } : {}) });
  return withChannels(n, same ? n.channels.map(c => (c.id === same.id ? ch : c)) : [...n.channels, ch]);
}
// 整个换掉渠道列表（设置页增删改用），每日摘要不变
export function withChannels(notifyOrSettings, channels) {
  const n = notifyOrSettings?.channels ? notifyOrSettings : notifySettings({ notify: notifyOrSettings });
  return { channels: channels.map(clean), ...(n.daily ? { daily: n.daily } : {}) };
}

// 群机器人按网址认是哪家
export function webhookKind(url) {
  const h = (() => { try { return new URL(url).host; } catch { return ''; } })();
  if (/qyapi\.weixin\.qq\.com$/.test(h)) return 'wecom';
  if (/(^|\.)(feishu\.cn|larksuite\.com)$/.test(h)) return 'feishu';
  if (/oapi\.dingtalk\.com$/.test(h)) return 'dingtalk';
  if (/hooks\.slack\.com$/.test(h)) return 'slack';
  if (/(discord|discordapp)\.com$/.test(h)) return 'discord';
  return 'generic';
}

const API = { telegram: () => process.env.MYDASH_TELEGRAM_API || 'https://api.telegram.org', pushover: () => process.env.MYDASH_PUSHOVER_API || 'https://api.pushover.net' };
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
// 有的服务出错也回 200，要看返回的 JSON
async function jsonOk(r, test) { let j = null; try { j = await r.json(); } catch {} return { ok: r.ok && (!test || test(j || {})), status: r.status, ...(j && !(!test || test(j)) ? { error: JSON.stringify(j).slice(0, 200) } : {}) }; }

export async function sendTo(ch, { title, body = '', link = '' }) {
  const text = [title, body, link].filter(Boolean).join('\n');
  try {
    switch (ch.type) {
      case 'bark': {
        const u = `${ch.url.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body || ' ')}?group=mydash${link ? `&url=${encodeURIComponent(link)}` : ''}`;
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        return { type: ch.type, ok: r.ok, status: r.status };
      }
      case 'ntfy': {
        // 用 JSON 发布，标题和内容都可以是中文
        const u = new URL(ch.url); const topic = u.pathname.replace(/^\/+|\/+$/g, '');
        const r = await postJson(`${u.origin}/`, { topic, title, message: body || title, ...(link ? { click: link } : {}), tags: ['memo'] });
        return { type: ch.type, ok: r.ok, status: r.status };
      }
      case 'telegram': {
        const r = await postJson(`${API.telegram()}/bot${ch.token}/sendMessage`, { chat_id: ch.chat, text, disable_web_page_preview: true });
        return { type: ch.type, ...(await jsonOk(r, j => j.ok === true)) };
      }
      case 'pushover': {
        const r = await postJson(`${API.pushover()}/1/messages.json`, { token: ch.token, user: ch.user, title, message: body || title, ...(link ? { url: link, url_title: 'mydash' } : {}) });
        return { type: ch.type, ...(await jsonOk(r, j => j.status === 1)) };
      }
      case 'webhook': {
        // 钉钉"自定义关键词"安全设置常用 mydash，所以内容总带上它
        const content = `[mydash] ${text}`;
        const kind = webhookKind(ch.url); const ts = Date.now();
        if (kind === 'wecom') return { type: ch.type, ...(await jsonOk(await postJson(ch.url, { msgtype: 'text', text: { content } }), j => j.errcode === 0)) };
        if (kind === 'feishu') {
          const sign = ch.secret ? { timestamp: String(Math.floor(ts / 1000)), sign: crypto.createHmac('sha256', `${Math.floor(ts / 1000)}\n${ch.secret}`).update('').digest('base64') } : {};
          return { type: ch.type, ...(await jsonOk(await postJson(ch.url, { ...sign, msg_type: 'text', content: { text: content } }), j => (j.code ?? j.StatusCode) === 0)) };
        }
        if (kind === 'dingtalk') {
          let u = ch.url;
          if (ch.secret) u += `${u.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(crypto.createHmac('sha256', ch.secret).update(`${ts}\n${ch.secret}`).digest('base64'))}`;
          return { type: ch.type, ...(await jsonOk(await postJson(u, { msgtype: 'text', text: { content } }), j => j.errcode === 0)) };
        }
        const r = await postJson(ch.url, kind === 'discord' ? { content } : { text: content });
        return { type: ch.type, ok: r.ok, status: r.status };
      }
      case 'email':
        await sendMail({ ...ch, from: ch.from || ch.user }, { subject: title, text: [body, link].filter(Boolean).join('\n\n') || title });
        return { type: ch.type, ok: true };
      case 'webpush': {
        const https = httpsUrl();
        return await sendWebPush({ title, body, link: https && link ? link.replace(/^https?:\/\/[^/]+/, https) : link }, { subject: https || baseUrl() });
      }
      default: return { type: ch.type, ok: false, error: 'unknown channel' };
    }
  } catch (e) { return { type: ch.type, ok: false, error: e.message }; }
}
// 发给所有渠道：{ ok（至少一个成功）, results, error }
export async function sendPush(msg, cfg = notifyConfig()) {
  if (!cfg) return { ok: false, error: 'not configured', results: [] };
  const results = await Promise.all(cfg.channels.map(ch => sendTo(ch, msg)));
  const bad = results.filter(r => !r.ok);
  return { ok: results.some(r => r.ok), results, error: bad.map(r => `${r.type}: ${r.error || r.status}`).join('; ') };
}

// Telegram：用户先给机器人发一句话，这里从 getUpdates 里找出他的 chat id
export async function telegramChat(token) {
  const r = await fetch(`${API.telegram()}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) return { ok: false, error: j.description || `HTTP ${r.status}` };
  const msg = [...(j.result || [])].reverse().map(u => u.message || u.channel_post || u.my_chat_member).find(m => m?.chat);
  return msg ? { ok: true, chat: String(msg.chat.id), name: msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || '' } : { ok: false, error: 'no messages yet' };
}

// 服务端用：记住每个条目最新的版本号，版本号变大才通知（重启时以当前数据为准，不会补发）
export function createNotifier({ items, isMuted, describe, log = () => {} }) {
  const known = new Map(items().map(m => [`${m.project}/${m.slug}`, m.versions[m.versions.length - 1].v]));
  const last = new Map(); let hour = []; let dailySent = '';
  function onChange(meta) {
    const id = `${meta.project}/${meta.slug}`; const v = meta.versions[meta.versions.length - 1]?.v || 0;
    const before = known.get(id) || 0; known.set(id, v);
    if (v <= before || isMuted(meta.project) || !notifyConfig()) return;
    const now = Date.now();
    if (now - (last.get(id) || 0) < 60_000) return;          // 同一条一分钟内只发一次
    hour = hour.filter(t => now - t < 3600_000); if (hour.length >= 30) return;  // 一小时最多 30 条
    last.set(id, now); hour.push(now);
    const d = describe(meta);
    sendPush({ title: d.title, body: d.body, link: baseUrl() + itemPath(meta.project, meta.slug) }).then(r => { if (!r.ok) log(`notify failed: ${r.error || r.status}`); });
  }
  // 每天定点发今日摘要（按配置的时区）
  function tick(summary, tz) {
    const cfg = notifyConfig(); if (!cfg?.daily) return;
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = k => f.find(x => x.type === k)?.value; const day = `${g('year')}-${g('month')}-${g('day')}`;
    if (`${g('hour')}:${g('minute')}` !== cfg.daily || dailySent === day) return;
    dailySent = day;
    const s = summary(); if (!s) return;
    sendPush({ title: s.title, body: s.body, link: `${baseUrl()}/today` }).then(r => { if (!r.ok) log(`daily notify failed: ${r.error || r.status}`); });
  }
  return { onChange, tick };
}
