// 局域网访问：同一个 WiFi 里的设备凭访问码打开。
// 只对局域网来的请求要求登录：本机（127.0.0.1）和 tailnet（100.64.0.0/10）照旧直接可用；公网地址一律拒绝。
// 首次在手机上输一次访问码（或扫二维码），之后用一个 HttpOnly cookie 记住这台设备，一年有效。
// 状态在 ~/.mydash/state/lan.json：{ code, sessions: { sha256(token): { created, seen, ua } } }。`mydash lan reset` 换码并让所有设备重新登录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import qrcode from 'qrcode-generator';
import { HOME, readConfig, contentPort } from './store.mjs';

const STATE = path.join(HOME, 'state', 'lan.json');
export const COOKIE = 'mydash_session';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0/O、1/I，手输不容易错

export function lanEnabled() { return readConfig().lan === true; }

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function save(s) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 }); fs.renameSync(STATE + '.tmp', STATE); }
function newCode() { const b = crypto.randomBytes(8); return [...b].map(x => ALPHABET[x % ALPHABET.length]).join(''); }
export const prettyCode = c => `${c.slice(0, 4)}-${c.slice(4)}`;
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

// 访问码：没有就生成一个
export function accessCode() {
  const s = load();
  if (!s.code) { s.code = newCode(); s.sessions = s.sessions || {}; save(s); }
  return s.code;
}
export function resetAccess() { save({ code: newCode(), sessions: {} }); return accessCode(); }
export function deviceCount() { return Object.keys(load().sessions || {}).length; }

export function checkCode(input) {
  const want = Buffer.from(accessCode()); const got = Buffer.from(normCode(input));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function createSession(ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const s = load(); s.sessions = s.sessions || {};
  s.sessions[hash(token)] = { created: new Date().toISOString(), seen: new Date().toISOString(), ua: String(ua || '').slice(0, 160) };
  save(s);
  return token;
}
let touched = new Map();
export function validSession(cookieHeader) {
  const m = String(cookieHeader || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  if (!m) return false;
  const h = hash(m[1]); const s = load();
  if (!s.sessions?.[h]) return false;
  // 记一下最近使用时间（每台设备最多每小时写一次）
  if (Date.now() - (touched.get(h) || 0) > 3600_000) { touched.set(h, Date.now()); s.sessions[h].seen = new Date().toISOString(); save(s); }
  return true;
}
export function sessionCookie(token) { return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`; }

// 失败太多次就先挡一会儿（每个 IP 15 分钟内最多 10 次）
const fails = new Map();
export function rateLimited(ip) { const now = Date.now(); const list = (fails.get(ip) || []).filter(t => now - t < 15 * 60_000); fails.set(ip, list); return list.length >= 10; }
export function noteFailure(ip) { const list = fails.get(ip) || []; list.push(Date.now()); fails.set(ip, list); }

// ---------- 请求来自哪里 ----------
function v4(ip) { const m = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i); return m ? m.slice(1).map(Number) : null; }
// 'local' 本机 · 'tailnet' Tailscale · 'lan' 局域网 · 'public' 其他
export function classify(addr) {
  const ip = String(addr || '');
  const a = v4(ip);
  if (a) {
    if (a[0] === 127) return 'local';
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return 'tailnet';
    if (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254)) return 'lan';
    return 'public';
  }
  const x = ip.toLowerCase();
  if (x === '::1') return 'local';
  if (x.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  if (/^f[cd][0-9a-f]{2}:/.test(x) || /^fe[89ab][0-9a-f]:/.test(x)) return 'lan';
  return 'public';
}

// 这台机器在局域网里的名字和地址
let localHostName = null;
function bonjourName() {
  if (localHostName !== null) return localHostName;
  localHostName = '';
  if (process.platform === 'darwin') { try { localHostName = execFileSync('scutil', ['--get', 'LocalHostName'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); } catch {} }
  return localHostName;
}
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const x of list || []) {
      if (x.internal || x.family !== 'IPv4') continue;
      if (classify(x.address) !== 'lan') continue;
      if (/^(bridge|docker|veth|vmnet|utun|awdl|llw|virbr|br-)/.test(name)) continue; // 虚拟机、容器、VPN 的网卡
      out.push(x.address);
    }
  }
  return out;
}
export function lanNames() {
  const names = new Set();
  const h = os.hostname().toLowerCase(); names.add(h.endsWith('.local') ? h : `${h}.local`);
  const b = bonjourName(); if (b) names.add(`${b.toLowerCase()}.local`);
  return [...names];
}
// 局域网来的请求，Host 只能是本机的局域网地址或 .local 名字（防 DNS 重绑定）
export function lanHostOk(host, port) {
  const m = String(host || '').toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m || Number(m[2] || 80) !== Number(port)) return false;
  const name = m[1].replace(/^\[|\]$/g, '');
  if (lanNames().includes(name)) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const x of list || []) if (!x.internal && x.address.toLowerCase() === name) return true;
  return false;
}

export function lanUrls(port = Number(readConfig().port || 4870)) {
  return [...lanNames().map(n => `http://${n}:${port}/`), ...lanAddresses().map(a => `http://${a}:${port}/`)];
}
// 二维码里直接带上访问码：扫一下就登录
export function loginUrl(base) { return `${base.replace(/\/$/, '')}/login?code=${accessCode()}`; }
export function qrSvg(text) { const qr = qrcode(0, 'M'); qr.addData(text); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
export function qrAscii(text) { const qr = qrcode(0, 'L'); qr.addData(text); qr.make(); return qr.createASCII(2, 2); }
export { contentPort };
