// 体检：setup check（装之前看环境，给出推荐的安装选项）和 doctor（装之后看是否正常）共用。
// 每一项 { id, ok, level: 'required'|'recommended'|'optional'|'info', detail, fix?, human? }
//   fix 是给 agent 照做的命令或说明；human 为 true 表示这一步必须由用户本人来做（输密码、点授权链接等）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { HOME, DATA_DIR, CONFIG_PATH, INSTALL_ID, readConfig, baseUrl, contentPort, accessMode } from './store.mjs';
import { serviceManager, lingerEnabled, serviceInstalled } from './service.mjs';
import * as TS from './tailscale.mjs';
import { findSoffice, pageRenderer } from './office.mjs';
import { t, lang } from './i18n.mjs';
import { lanUrls, deviceCount } from './lan.mjs';
import { which, IS_WIN } from './sys.mjs';

const tilde = p => String(p).replace(os.homedir(), '~');
// mydash 命令放哪：Windows 上优先放 npm 的全局目录（装 Node 时就加进 PATH 了），其他系统放 ~/.local/bin
const WIN_NPM_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
export const DEFAULT_BIN_DIR = IS_WIN && String(process.env.PATH || process.env.Path || '').split(path.delimiter).some(p => path.resolve(p) === path.resolve(WIN_NPM_DIR))
  ? WIN_NPM_DIR : path.join(os.homedir(), '.local', 'bin');
// 把目录加进 PATH 的说明（给 agent 照做）
export function pathFix(dir) {
  return IS_WIN
    ? t('Add {dir} to the user PATH (PowerShell): {cmd}', { dir, cmd: `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${dir}', 'User')` })
    : t('Add {dir} to PATH in the shell profile (~/.zshrc or ~/.bashrc): export PATH="{dir}:$PATH"', { dir });
}

function linuxPkg() { return which('apt-get') ? 'apt' : which('dnf') ? 'dnf' : which('pacman') ? 'pacman' : which('apk') ? 'apk' : null; }
const PKGS = {
  office: { apt: 'sudo apt-get install -y libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress', dnf: 'sudo dnf install -y libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress', pacman: 'sudo pacman -S --noconfirm libreoffice-fresh', apk: 'sudo apk add libreoffice' },
  pdftoppm: { apt: 'sudo apt-get install -y poppler-utils', dnf: 'sudo dnf install -y poppler-utils', pacman: 'sudo pacman -S --noconfirm poppler', apk: 'sudo apk add poppler-utils' },
  cjk: { apt: 'sudo apt-get install -y fonts-noto-cjk', dnf: 'sudo dnf install -y google-noto-sans-cjk-fonts', pacman: 'sudo pacman -S --noconfirm noto-fonts-cjk', apk: 'sudo apk add font-noto-cjk' },
  git: { apt: 'sudo apt-get install -y git', dnf: 'sudo dnf install -y git', pacman: 'sudo pacman -S --noconfirm git', apk: 'sudo apk add git' },
};
const WINGET = { office: 'winget install --id TheDocumentFoundation.LibreOffice -e', pdftoppm: 'winget install --id oschwartz10612.Poppler -e', cjk: '', git: 'winget install --id Git.Git -e' };
const pkgFix = what => process.platform === 'darwin'
  ? { office: 'brew install --cask libreoffice', pdftoppm: 'xcode-select --install', cjk: '', git: 'xcode-select --install' }[what]
  : IS_WIN ? WINGET[what] : (PKGS[what][linuxPkg()] || PKGS[what].apt);

function portState(port) {
  return new Promise(resolve => {
    const s = net.createServer().once('error', () => resolve('busy')).once('listening', () => s.close(() => resolve('free'))).listen(port, '127.0.0.1');
  });
}
// own=true：还要确认回应的是这一套安装（看 X-Mydash-Id），不是同一台机器上的另一套
async function healthz(url, ms = 3000, host, own = false) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: host ? { Host: host } : {} }); return r.ok && (!own || r.headers.get('x-mydash-id') === INSTALL_ID); } catch { return false; }
}

export function systemTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
export function guessLang() { return /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '') ? 'zh' : 'en'; }
export function binDirOnPath(dir = DEFAULT_BIN_DIR) { return String(process.env.PATH || '').split(path.delimiter).some(p => path.resolve(p) === path.resolve(dir)); }

// ---------- 装之前：环境 ----------
// opts：setup 命令行的选项，用户指定了端口就检查指定的端口
export async function environment(opts = {}) {
  const c = []; const add = x => c.push(x);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const platformOk = ['darwin', 'linux', 'win32'].includes(process.platform);
  add({ id: 'platform', ok: platformOk, level: 'required', detail: `${process.platform} ${os.arch()}${process.platform === 'linux' ? ` (${linuxPkg() || 'unknown package manager'})` : ''}`, fix: platformOk ? undefined : t('mydash supports macOS, Linux and Windows.') });
  add({ id: 'node', ok: nodeMajor >= 20, level: 'required', detail: `Node.js ${process.versions.node} (${tilde(which('node') || process.execPath)})`, fix: nodeMajor >= 20 ? undefined : (process.platform === 'darwin' ? 'brew install node' : IS_WIN ? 'winget install --id OpenJS.NodeJS.LTS -e' : t('Install Node.js 20 or newer: https://nodejs.org/en/download')) });
  const git = which('git');
  add({ id: 'git', ok: Boolean(git), level: 'recommended', detail: git ? tilde(git) : t('not found (needed for mydash update)'), fix: git ? undefined : pkgFix('git') });
  const mgr = serviceManager();
  add({ id: 'service-manager', ok: mgr !== 'none', level: 'recommended', detail: mgr === 'launchd' ? t('launchd (starts when you log in)') : mgr === 'systemd' ? 'systemd --user' : mgr === 'startup' ? t('Windows Startup folder (starts when you sign in, no admin needed)') : t('none: mydash will run as a background process and will not come back after a reboot') });
  if (mgr === 'systemd') {
    const lg = lingerEnabled();
    add({ id: 'linger', ok: lg !== false, level: 'recommended', human: lg === false, detail: lg ? t('enabled: services keep running after you log out') : t('disabled: mydash stops when you log out (for example when an SSH session ends)'), fix: lg === false ? `sudo loginctl enable-linger ${os.userInfo().username}` : undefined });
  }
  const sys = TS.systemCli(); const st = sys ? TS.status({ cli: sys }) : null; const nm = TS.names(st);
  add({ id: 'tailscale', ok: st?.BackendState === 'Running', level: 'optional', detail: sys ? `${tilde(sys)} · ${st?.BackendState || t('not running')}${nm.fqdn ? ` · ${nm.fqdn}` : ''}` : t('not installed (only needed to open mydash from your phone or other devices)'), fix: sys ? (st?.BackendState === 'Running' ? undefined : t('Start Tailscale and log in')) : `https://tailscale.com/download${IS_WIN ? '/windows' : ''}`, human: Boolean(sys) && st?.BackendState !== 'Running' });
  if (process.platform === 'darwin') {
    const go = which('go');
    add({ id: 'go', ok: Boolean(go), level: 'optional', detail: go ? tilde(go) : t('not found (only needed for --access tailscale-node on macOS)'), fix: go ? undefined : 'brew install go' });
  }
  const so = findSoffice();
  add({ id: 'libreoffice', ok: Boolean(so), level: 'optional', detail: so ? tilde(so) : t('not found: Word / PowerPoint files can be downloaded but not previewed'), fix: so ? undefined : pkgFix('office') });
  if (process.platform === 'darwin') {
    const sw = which('swiftc') || fs.existsSync(path.join(HOME, 'bin', 'pdfpages'));
    add({ id: 'pdf-pages', ok: Boolean(sw), level: 'optional', detail: sw ? t('swiftc available: PDFs are shown as page images') : t('swiftc not found: PDFs are rendered in the browser instead'), fix: sw ? undefined : pkgFix('pdftoppm') });
  } else {
    const pp = which('pdftoppm') && which('pdfinfo');
    add({ id: 'pdf-pages', ok: Boolean(pp), level: 'optional', detail: pp ? t('pdftoppm available: PDFs are shown as page images') : t('pdftoppm not found: PDFs are rendered in the browser instead'), fix: pp ? undefined : pkgFix('pdftoppm') });
    let cjk = IS_WIN; try { if (!IS_WIN) cjk = execFileSync('fc-list', [':lang=zh'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; } catch {}
    if (!IS_WIN) add({ id: 'cjk-fonts', ok: cjk, level: 'optional', detail: cjk ? t('CJK fonts installed') : t('no CJK fonts: Chinese / Japanese text in Office previews would be missing'), fix: cjk ? undefined : pkgFix('cjk') });
  }
  const cfg = readConfig();
  // 和安装时（setup.mjs 的 optsFrom）算法一样：查的就是安装真正要用的端口
  const port = Number(opts.port || cfg.port || 4870), cport = Number(opts['content-port'] || cfg.contentPort || port + 1);
  // 每个端口各自看：是自己这套在用，或者是 v0.1 之前的旧版（不带 X-Mydash-Id，同一个家目录里有配置）：安装时会被替换
  const mineOn = async p => {
    if (await healthz(`http://127.0.0.1:${p}/healthz`, 800, undefined, true)) return true;
    if (!fs.existsSync(CONFIG_PATH)) return false;
    try { const r = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(800) }); return r.ok && !r.headers.get('x-mydash-id') && (await r.text()) === 'ok'; } catch { return false; }
  };
  for (const [id, p] of [['port', port], ['content-port', cport]]) {
    const s = await portState(p); const mine = s !== 'free' && await mineOn(p);
    add({ id, ok: s === 'free' || mine, level: 'required', detail: s === 'free' ? t('{port} is free', { port: p }) : mine ? t('{port} is used by mydash itself', { port: p }) : t('{port} is in use by another program', { port: p }), fix: s === 'free' || mine ? undefined : t('Pick other ports with --port and --content-port') });
  }
  add({ id: 'bin-dir', ok: binDirOnPath(), level: 'recommended', detail: binDirOnPath() ? t('{dir} is on PATH', { dir: tilde(DEFAULT_BIN_DIR) }) : t('{dir} is not on PATH', { dir: tilde(DEFAULT_BIN_DIR) }), fix: binDirOnPath() ? undefined : pathFix(DEFAULT_BIN_DIR) });
  const tz = systemTimezone();
  add({ id: 'timezone', ok: !/^(UTC|Etc\/UTC|Etc\/GMT)$/.test(tz), level: 'info', detail: tz, fix: /^(UTC|Etc\/UTC|Etc\/GMT)$/.test(tz) ? t('The system clock is UTC (common on servers). Ask the user for their timezone and pass --timezone, e.g. --timezone Europe/London') : undefined });
  add({ id: 'agents', ok: true, level: 'info', detail: [fs.existsSync(path.join(os.homedir(), '.claude')) && 'Claude Code', fs.existsSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) && 'Codex'].filter(Boolean).join(', ') || t('none found') });
  add({ id: 'existing', ok: true, level: 'info', detail: fs.existsSync(CONFIG_PATH) ? t('already installed: {cfg}', { cfg: JSON.stringify({ access: cfg.access || accessMode(), lang: cfg.lang, url: baseUrl() }) }) : t('not installed yet') });

  const recommend = {
    access: cfg.access || (st?.BackendState === 'Running' ? 'tailscale' : 'local'),
    office: so ? 'yes' : 'no',
    lang: cfg.lang || guessLang(),
    timezone: cfg.timezone || tz,
  };
  return { checks: c, recommend, tailscale: { cli: sys, state: st?.BackendState || null, ...nm } };
}

// 数据目录有多少条目、占多少空间
function dataUsage() {
  let items = 0, bytes = 0;
  const walk = d => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { if (e.name === 'meta.json') items++; try { bytes += fs.statSync(p).size; } catch {} } } };
  walk(DATA_DIR);
  return { items, bytes };
}

// ---------- 装之后：是否正常 ----------
export async function health() {
  const c = []; const add = x => c.push(x);
  const cfg = readConfig();
  const port = Number(process.env.MYDASH_PORT || cfg.port || 4870), cport = contentPort();
  const mode = accessMode(); const mgr = cfg.service || serviceManager();
  add({ id: 'installed', ok: fs.existsSync(CONFIG_PATH), level: 'required', detail: fs.existsSync(CONFIG_PATH) ? tilde(CONFIG_PATH) : t('no config: mydash is not installed'), fix: fs.existsSync(CONFIG_PATH) ? undefined : t('Run ./setup.sh install from the mydash source folder') });
  const up = await healthz(`http://127.0.0.1:${port}/healthz`, 3000, undefined, true);
  add({ id: 'server', ok: up, level: 'required', detail: up ? t('running on 127.0.0.1:{port}', { port }) : t('not responding on 127.0.0.1:{port}', { port }), fix: up ? undefined : t('Check {log}; reinstall with ./setup.sh install', { log: tilde(path.join(HOME, 'logs')) }) });
  const cup = await healthz(`http://127.0.0.1:${cport}/healthz`, 3000, `127.0.0.1:${cport}`, true);
  add({ id: 'content-port', ok: cup, level: 'required', detail: cup ? t('running on 127.0.0.1:{port}', { port: cport }) : t('not responding on 127.0.0.1:{port}', { port: cport }), fix: cup ? undefined : t('Restart the service: mydash setup install (same options as before)') });
  const installed = mgr !== 'none' && serviceInstalled('server', mgr);
  add({ id: 'service', ok: installed, level: 'recommended', detail: mgr === 'none' ? t('no service manager: started as a background process, will not survive a reboot') : mgr === 'launchd-boot' ? (installed ? `launchd · ${t('starts at boot, before anyone logs in')}` : t('set to start at boot, but the administrator step has not been run yet')) : `${mgr}${mgr === 'launchd' || mgr === 'startup' ? ' · ' + t('starts when you log in') : ''}`, fix: mgr === 'launchd-boot' && !installed ? `sudo ${path.join(cfg.binDir || DEFAULT_BIN_DIR, 'mydash')} service boot` : undefined });
  if (mgr === 'systemd') {
    const lg = lingerEnabled();
    add({ id: 'linger', ok: lg !== false, level: 'recommended', human: lg === false, detail: lg ? t('enabled') : t('disabled: mydash stops when you log out'), fix: lg === false ? `sudo loginctl enable-linger ${os.userInfo().username}` : undefined });
  }
  let url = baseUrl();
  if (mode === 'tailscale-node') {
    const tg = { cli: TS.NODE_BIN.cli, socket: TS.NODE_SOCKET };
    const st = fs.existsSync(tg.cli) ? TS.status(tg) : null;
    const auth = st?.AuthURL || (() => { try { return fs.readFileSync(path.join(TS.TS_DIR, 'auth-url.txt'), 'utf8').trim(); } catch { return ''; } })();
    add({ id: 'tailscale-node', ok: st?.BackendState === 'Running', level: 'required', human: st?.BackendState === 'NeedsLogin', detail: st ? `${st.BackendState}${st.Self?.DNSName ? ' · ' + st.Self.DNSName.replace(/\.$/, '') : ''}` : t('not running'), fix: st?.BackendState === 'NeedsLogin' && auth ? t('The user must open this link and approve the new device: {url}', { url: auth }) : st ? undefined : t('Reinstall with ./setup.sh install --access tailscale-node') });
  } else if (mode === 'tailscale') {
    const sys = TS.systemCli(); const tg = { cli: sys };
    const map = sys ? TS.serveMap(tg) : {};
    const pub = Number(cfg.publicPort || 80);
    const ok = map[pub] === `http://127.0.0.1:${port}` && map[cport] === `http://127.0.0.1:${cport}`;
    add({ id: 'tailscale-serve', ok, level: 'required', detail: ok ? t('tailscale serve forwards :{pub} and :{cport}', { pub, cport }) : t('tailscale serve is not forwarding :{pub} and :{cport}', { pub, cport }), fix: ok ? undefined : `${sys || 'tailscale'} serve --bg --http=${pub} http://127.0.0.1:${port} && ${sys || 'tailscale'} serve --bg --http=${cport} http://127.0.0.1:${cport}` });
  }
  if (mode !== 'local') {
    const reach = await healthz(url + '/healthz', 4000);
    add({ id: 'url', ok: reach, level: 'recommended', detail: reach ? t('{url} opens from this machine', { url }) : t('{url} does not open from this machine', { url }), fix: reach ? undefined : t('Check that Tailscale is running on this machine; MagicDNS must be on for short names') });
  }
  if (cfg.lan) add({ id: 'lan', ok: true, level: 'info', detail: t('on: {urls} · {n} device logged in|on: {urls} · {n} devices logged in', { urls: lanUrls(port).join('  '), n: deviceCount() }), fix: t('Access code: mydash lan') });
  const so = findSoffice(); const pr = pageRenderer();
  // macOS：直接用 /Applications 里的原版，后台转换看不到系统字体，中文会丢；setup 会准备带 Noto 字体的副本
  const rawMacLo = process.platform === 'darwin' && so && so.startsWith('/Applications/');
  if (cfg.office === 'no') add({ id: 'office', ok: true, level: 'info', detail: t('Office previews are turned off (--office no)') });
  else add({ id: 'office', ok: Boolean(so) && !rawMacLo, level: 'optional', detail: !so ? t('LibreOffice not found: no Word / PowerPoint previews') : rawMacLo ? t('using LibreOffice from /Applications directly: Chinese text in previews may be missing') : tilde(so), fix: !so ? pkgFix('office') : rawMacLo ? './setup.sh install --office yes' : undefined });
  add({ id: 'pdf-pages', ok: Boolean(pr), level: 'optional', detail: pr ? pr : t('no page renderer: PDFs are rendered in the browser'), fix: pr ? undefined : (process.platform === 'darwin' ? 'xcode-select --install && ./setup.sh install' : pkgFix('pdftoppm')) });
  const cli = which('mydash');
  add({ id: 'cli', ok: Boolean(cli), level: 'recommended', detail: cli ? tilde(cli) : t('the mydash command is not on PATH'), fix: cli ? undefined : pathFix(cfg.binDir || DEFAULT_BIN_DIR) });
  let writable = false; try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); writable = true; } catch {}
  const usage = dataUsage();
  add({ id: 'data', ok: writable, level: 'required', detail: `${tilde(DATA_DIR)} · ${t('{n} item|{n} items', { n: usage.items })} · ${(usage.bytes / 1048576).toFixed(0)} MB` });
  return { checks: c, url, access: mode, lang: lang() };
}

// 打印给人看
export function printChecks(checks) {
  const mark = x => x.ok ? '✓' : x.level === 'required' ? '✗' : x.level === 'info' ? '·' : '!';
  for (const x of checks) {
    process.stdout.write(`${mark(x)} ${x.id.padEnd(16)} ${x.detail}\n`);
    if (x.fix && (!x.ok || x.level === 'info')) process.stdout.write(`  ${' '.repeat(16)} → ${x.human ? t('(needs the user) ') : ''}${x.fix}\n`);
  }
}
export const allRequiredOk = checks => checks.every(x => x.ok || x.level !== 'required');
