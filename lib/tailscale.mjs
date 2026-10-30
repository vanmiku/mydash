// Tailscale：系统自带的 tailscale（access=tailscale），或 mydash 自己的独立节点（access=tailscale-node，
// 用户态网络、不需要 root，状态在 ~/.mydash/ts）。都只用 HTTP 的 tailscale serve 把本机端口转发到 tailnet。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME } from './store.mjs';
import { which, IS_WIN } from './sys.mjs';

export const TS_DIR = path.join(HOME, 'ts');
export const NODE_SOCKET = path.join(TS_DIR, 'tailscaled.sock');
export const NODE_BIN = { cli: path.join(TS_DIR, 'bin', 'tailscale'), daemon: path.join(TS_DIR, 'bin', 'tailscaled') };
export const TS_VERSION = process.env.MYDASH_TS_VERSION || '1.104.1';


export function systemCli() {
  const win = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe') : null;
  for (const c of [which('tailscale'), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale', win]) if (c && fs.existsSync(c)) return c;
  return null;
}

// target: { cli, socket? }
const sockArgs = tg => (tg.socket ? [`--socket=${tg.socket}`] : []);
function ts(tg, args, timeout = 15_000) {
  try { return { ok: true, out: execFileSync(tg.cli, [...sockArgs(tg), ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout }).toString() }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message).trim() }; }
}

export function status(tg) {
  const r = ts(tg, ['status', '--json'], 8000);
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

// 节点的短名和完整域名
export function names(st) {
  const fqdn = String(st?.Self?.DNSName || '').replace(/\.$/, '');
  return { short: fqdn.split('.')[0] || null, fqdn: fqdn || null, suffix: st?.MagicDNSSuffix || fqdn.split('.').slice(1).join('.') || null };
}

// 已有的 serve 配置：{ 端口号: 目标 }（只看 HTTP 根路径）
export function serveMap(tg) {
  const r = ts(tg, ['serve', 'status', '--json'], 8000);
  const out = {};
  if (!r.ok) return out;
  let j; try { j = JSON.parse(r.out || '{}'); } catch { return out; }
  for (const [hostPort, web] of Object.entries(j.Web || {})) {
    const port = Number(hostPort.split(':').pop());
    const proxy = web?.Handlers?.['/']?.Proxy;
    if (port) out[port] = proxy || '(other)';
  }
  for (const [port, h] of Object.entries(j.TCP || {})) if (!(port in out) && !h.HTTP && !h.HTTPS) out[Number(port)] = h.TCPForward ? `tcp://${h.TCPForward}` : '(tcp)';
  return out;
}

export function serve(tg, publicPort, localPort) {
  return ts(tg, ['serve', '--bg', `--http=${publicPort}`, `http://127.0.0.1:${localPort}`]);
}
export function serveOff(tg, publicPort) { return ts(tg, ['serve', `--http=${publicPort}`, 'off']); }
// HTTPS 转发（tailnet 在后台开了 HTTPS 才行；第一次访问时 tailscaled 自己去申请证书）
export function serveHttps(tg, publicPort, localPort) {
  return ts(tg, ['serve', '--bg', `--https=${publicPort}`, `http://127.0.0.1:${localPort}`]);
}

// 原样转发 TCP（独立节点上转发屏幕共享 5900、SSH 22：重启后还没人登录时，也能从 tailnet 连进来登录这台机器）
export function serveTcp(tg, p) { return ts(tg, ['serve', '--bg', `--tcp=${p}`, `tcp://127.0.0.1:${p}`]); }
export function serveTcpOff(tg, p) { return ts(tg, ['serve', `--tcp=${p}`, 'off']); }
export const nodeTarget = () => ({ cli: NODE_BIN.cli, socket: NODE_SOCKET });

export function up(tg, hostname) {
  return ts(tg, ['up', `--hostname=${hostname}`, '--accept-dns=false', '--timeout=10s'], 20_000);
}

// 独立节点：在 server 进程里每分钟看一次，登录批准后把 HTTP 80 和内容端口转发到本地服务。
// tailnet 开了 HTTPS（后台 DNS → HTTPS Certificates）时，再加一份 HTTPS：443 → 工作台，httpsContentPort → 内容端口；原来的 HTTP 照常
// 节点的真实名字也在这里报给 server：名字被占用时 Tailscale 会自动改名（mydash-1），批准之前也还不知道名字
export function watchNode({ port, contentPort, httpsContentPort, tcp = () => [], log = () => {}, onHttps = () => {}, onName = () => {} }) {
  const tg = { cli: NODE_BIN.cli, socket: NODE_SOCKET };
  const tick = () => {
    if (!fs.existsSync(NODE_SOCKET) || !fs.existsSync(tg.cli)) return;
    const st = status(tg); if (!st) return;
    const authFile = path.join(TS_DIR, 'auth-url.txt');
    if (st.BackendState === 'Running') {
      fs.rmSync(authFile, { force: true });
      const short = names(st).short; if (short) onName(short);
      const have = serveMap(tg);
      for (const [pub, local] of [[80, port], [contentPort, contentPort]]) {
        if (have[pub] !== `http://127.0.0.1:${local}`) { const r = serve(tg, pub, local); log(`tailscale serve :${pub} -> ${local} ${r.ok ? 'ok' : r.out}`); }
      }
      for (const p of tcp()) if (have[p] !== `tcp://127.0.0.1:${p}`) { const r = serveTcp(tg, p); log(`tailscale serve tcp :${p} ${r.ok ? 'ok' : r.out}`); }
      const domain = st.CertDomains?.[0];
      if (domain && httpsContentPort) {
        let ok = true;
        for (const [pub, local] of [[443, port], [httpsContentPort, contentPort]]) {
          if (have[pub] !== `http://127.0.0.1:${local}`) { const r = serveHttps(tg, pub, local); ok = ok && r.ok; log(`tailscale serve https :${pub} -> ${local} ${r.ok ? 'ok' : r.out}`); }
        }
        if (ok) onHttps(`https://${domain}`);
      }
    } else if (st.BackendState === 'NeedsLogin' && st.AuthURL) {
      try { fs.writeFileSync(authFile, st.AuthURL); } catch {}
    }
  };
  setTimeout(tick, 3000).unref();
  setInterval(tick, 60_000).unref();
}
