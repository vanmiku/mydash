// 网页推送（Web Push）：不装 App，浏览器订阅后直接收通知。
// 浏览器只在 HTTPS 下允许订阅；iPhone 还要先把 mydash 加到主屏幕、从主屏幕打开。
// 发送：VAPID（RFC 8292，ES256 签名）表明是谁发的；内容按 RFC 8291（aes128gcm）加密，只有订阅的那个浏览器能解开。
// 密钥和订阅存在 state/webpush.json（只给自己读）。不引入依赖，全用 node:crypto。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './store.mjs';

const FILE = path.join(HOME, 'state', 'webpush.json');
const b64u = b => Buffer.from(b).toString('base64url');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
function save(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); fs.renameSync(tmp, FILE);
}

// 这一套安装的 VAPID 密钥（第一次用时生成）
export function vapidKeys() {
  const s = load();
  if (!s.vapid) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    s.vapid = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) }; s.subs = s.subs || []; save(s);
  }
  return s.vapid;
}
function privateKeyObject({ publicKey, privateKey }) {
  const pub = Buffer.from(publicKey, 'base64url');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}
export function vapidAuth(endpoint, vapid, subject) {
  const enc = o => b64u(JSON.stringify(o));
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// RFC 8291：用浏览器给的 p256dh、auth 加密一条消息（一个记录，rs = 4096）
export function encrypt(payload, p256dh, auth) {
  const uaPublic = Buffer.from(p256dh, 'base64url'); const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, sealed]);
}

export const subscriptions = () => load().subs || [];
// 推送服务的地址必须是 HTTPS（本机的测试地址除外）
const okEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && x.hostname === '127.0.0.1'); } catch { return false; } };
export function addSubscription(sub, { device = '' } = {}) {
  const p = Buffer.from(String(sub?.keys?.p256dh || ''), 'base64url'); const a = Buffer.from(String(sub?.keys?.auth || ''), 'base64url');
  if (!okEndpoint(sub?.endpoint) || p.length !== 65 || p[0] !== 4 || a.length < 16) return null;
  vapidKeys();
  const s = load(); s.subs = (s.subs || []).filter(x => x.endpoint !== sub.endpoint);
  s.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(device).slice(0, 200), at: new Date().toISOString() });
  save(s); return s.subs.length;
}
export function removeSubscription(endpoint) {
  const s = load(); const before = (s.subs || []).length;
  s.subs = (s.subs || []).filter(x => x.endpoint !== endpoint); save(s);
  return before - s.subs.length;
}

// 发给所有订阅了的浏览器。msg：{ title, body, link }；subject：VAPID 的联系方式（https: 网址）
export async function sendWebPush(msg, { subject }) {
  const s = load();
  if (!s.vapid || !s.subs?.length) return { type: 'webpush', ok: false, error: 'no browser has turned on notifications yet' };
  // 一条推送只能装约 4 KB（RFC 8291 单记录）：标题和正文截短，中文一字 3 字节
  const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const payload = JSON.stringify({ title: cut(msg.title, 200), body: cut(msg.body, 600), link: cut(msg.link, 1000) });
  const results = await Promise.all(s.subs.map(async sub => {
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST', body: encrypt(payload, sub.keys.p256dh, sub.keys.auth), signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidAuth(sub.endpoint, s.vapid, subject) },
      });
      return { endpoint: sub.endpoint, ok: r.ok, status: r.status };
    } catch (e) { return { endpoint: sub.endpoint, ok: false, error: e.message }; }
  }));
  // 404 / 410：订阅已经失效（取消了通知、换了浏览器），删掉
  for (const r of results) if (r.status === 404 || r.status === 410) removeSubscription(r.endpoint);
  const bad = results.filter(r => !r.ok);
  return { type: 'webpush', ok: results.some(r => r.ok), sent: results.length - bad.length, ...(bad.length ? { error: bad.map(r => r.error || r.status).join(', ') } : {}) };
}
