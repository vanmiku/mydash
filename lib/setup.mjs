// mydash setup check / install / uninstall，以及 mydash update。
// 设计给 agent 用：每一步可重复运行；--json 输出结构化结果；需要用户本人做的步骤放在 human 里，agent 照着请用户去做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, DATA_DIR, CONFIG_PATH, INSTALL_ID, readConfig, readMeta } from './store.mjs';
import { environment, allRequiredOk, printChecks, systemTimezone, DEFAULT_BIN_DIR, binDirOnPath, pathFix } from './checks.mjs';
import { serviceManager, installService, removeService, serviceInstalled, SERVICES } from './service.mjs';
import * as TS from './tailscale.mjs';
import { integrate, refresh as refreshIntegration, status as integrationStatus, APP } from './integrate.mjs';
import { findSoffice } from './office.mjs';
import { publish } from './publish.mjs';
import { t, setLang, normLang, lang } from './i18n.mjs';
import { accessCode, resetAccess, prettyCode, lanUrls, loginUrl, qrAscii, deviceCount } from './lan.mjs';
import { remoteGet } from './remote.mjs';
import { sendPush, sendTo, notifyConfig, notifySettings, withChannel, withChannels, badField, maskValue, CHANNELS, CHANNEL_TYPES } from './notify.mjs';
import { which, IS_WIN } from './sys.mjs';

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args, opts = {}) => { try { return { ok: true, out: execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...opts }).toString() }; } catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message).trim() }; } };
// Windows 上 npm 是 npm.cmd，Node 20 起执行 .cmd 必须经过 shell
const npm = (args, opts) => (IS_WIN ? sh('npm.cmd', args, { ...opts, shell: true }) : sh('npm', args, opts));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tilde = p => String(p).replace(os.homedir(), '~');
const ACCESS = ['local', 'tailscale', 'tailscale-node'];

async function waitHealthy(port, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800), headers: { Host: `127.0.0.1:${port}` } }); if (r.ok && r.headers.get('x-mydash-id') === INSTALL_ID) return true; } catch {}
    await sleep(300);
  }
  return false;
}

function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  // 可能存着推送的密码和密钥：只给自己读
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

// 代码复制到 ~/.mydash/app：服务从这里运行（macOS 不让开机自启的后台进程读 ~/Documents）
function copyApp() {
  if (path.resolve(SRC) === path.resolve(APP)) return 'in-place';
  const skip = new Set(['.git', 'test', 'local', '.DS_Store', '.restart']);
  if (which('rsync')) {
    const ex = [...skip, 'node_modules'].flatMap(x => ['--exclude', x]);
    fs.mkdirSync(APP, { recursive: true });
    const a = sh('rsync', ['-a', '--delete', ...ex, `${SRC}/`, `${APP}/`]);
    const b = sh('rsync', ['-a', '--delete', `${SRC}/node_modules/`, `${APP}/node_modules/`]);
    if (!a.ok || !b.ok) throw new Error(a.out || b.out);
    return 'rsync';
  }
  fs.rmSync(APP, { recursive: true, force: true });
  fs.cpSync(SRC, APP, { recursive: true, filter: src => !skip.has(path.basename(src)) });
  return 'copy';
}

function writeShim(binDir, node) {
  fs.mkdirSync(binDir, { recursive: true });
  const custom = path.resolve(HOME) !== path.join(os.homedir(), '.mydash');
  const entry = path.join(APP, 'bin', 'mydash.mjs');
  const sh = path.join(binDir, 'mydash');
  if (IS_WIN) {
    // PowerShell / cmd 用 mydash.cmd；Claude Code 在 Windows 上多半用 Git Bash，它不认 .cmd，所以再放一个不带扩展名的 sh 版本
    const cmd = path.join(binDir, 'mydash.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n${custom ? `set "MYDASH_HOME=${HOME}"\r\n` : ''}"${node}" "${entry}" %*\r\n`);
    const posix = p => p.replace(/\\/g, '/');
    fs.writeFileSync(sh, `#!/bin/sh\n${custom ? `MYDASH_HOME="${posix(HOME)}" ` : ''}exec "${posix(node)}" "${posix(entry)}" "$@"\n`);
    return cmd;
  }
  fs.writeFileSync(sh, `#!/bin/sh\n${custom ? `MYDASH_HOME="${HOME}" ` : ''}exec "${node}" "${entry}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

// macOS：给后台转换准备一份去掉隔离属性的 LibreOffice 克隆（原版在后台调用会卡在首次启动检查），并放进 Noto 中文字体
async function prepareOffice() {
  if (process.platform !== 'darwin') return findSoffice() ? 'system' : null;
  const appSrc = '/Applications/LibreOffice.app'; if (!fs.existsSync(appSrc)) return null;
  const ver = p => sh('defaults', ['read', path.join(p, 'Contents', 'Info.plist'), 'CFBundleShortVersionString']).out.trim();
  const dst = path.join(HOME, 'lo', 'LibreOffice.app');
  if (!fs.existsSync(dst) || ver(appSrc) !== ver(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.rmSync(dst, { recursive: true, force: true });
    const r = sh('cp', ['-cR', appSrc, path.dirname(dst) + '/'], { timeout: 600_000 });
    if (!r.ok) sh('cp', ['-R', appSrc, path.dirname(dst) + '/'], { timeout: 600_000 });
    sh('xattr', ['-cr', dst], { timeout: 300_000 });
  }
  const fontsDir = path.join(HOME, 'fonts'); fs.mkdirSync(fontsDir, { recursive: true });
  const loFonts = path.join(dst, 'Contents', 'Resources', 'fonts', 'truetype');
  for (const f of ['Sans/SubsetOTF/SC/NotoSansSC-Regular.otf', 'Sans/SubsetOTF/SC/NotoSansSC-Bold.otf', 'Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf', 'Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf']) {
    const name = path.basename(f); const local = path.join(fontsDir, name);
    if (!fs.existsSync(local) || !fs.statSync(local).size) {
      try { const r = await fetch(`https://github.com/notofonts/noto-cjk/raw/main/${f}`, { signal: AbortSignal.timeout(120_000) }); if (r.ok) fs.writeFileSync(local, Buffer.from(await r.arrayBuffer())); } catch {}
    }
    try { if (fs.existsSync(local) && !fs.existsSync(path.join(loFonts, name))) fs.copyFileSync(local, path.join(loFonts, name)); } catch {}
  }
  return 'clone';
}

function buildPdfPages() {
  if (process.platform !== 'darwin' || !which('swiftc')) return null;
  const out = path.join(HOME, 'bin', 'pdfpages'); const src = path.join(APP, 'lib', 'pdfpages.swift');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return 'ok';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return sh('swiftc', ['-O', '-o', out, src], { timeout: 300_000 }).ok ? 'built' : 'failed';
}

// 独立节点的 tailscale / tailscaled：macOS 用 go 现编，Linux 下载官方静态包
async function ensureNodeBinaries() {
  if (fs.existsSync(TS.NODE_BIN.cli) && fs.existsSync(TS.NODE_BIN.daemon)) return { ok: true };
  fs.mkdirSync(path.dirname(TS.NODE_BIN.cli), { recursive: true });
  if (process.platform === 'darwin') {
    if (!which('go')) return { ok: false, error: t('Go is needed to build the dedicated Tailscale node: brew install go') };
    const r = sh('go', ['install', `tailscale.com/cmd/tailscale@v${TS.TS_VERSION}`, `tailscale.com/cmd/tailscaled@v${TS.TS_VERSION}`],
      { cwd: os.homedir(), env: { ...process.env, GOBIN: path.dirname(TS.NODE_BIN.cli), GOTOOLCHAIN: 'auto' }, timeout: 1_200_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.out.slice(-600) };
  }
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  const url = `https://pkgs.tailscale.com/stable/tailscale_${TS.TS_VERSION}_${arch}.tgz`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-ts-'));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) return { ok: false, error: `${url}: HTTP ${res.status}` };
    fs.writeFileSync(path.join(tmp, 'ts.tgz'), Buffer.from(await res.arrayBuffer()));
    const x = sh('tar', ['xzf', path.join(tmp, 'ts.tgz'), '-C', tmp]);
    if (!x.ok) return { ok: false, error: x.out };
    const dir = fs.readdirSync(tmp).find(d => d.startsWith('tailscale_'));
    for (const b of ['tailscale', 'tailscaled']) { fs.copyFileSync(path.join(tmp, dir, b), path.join(path.dirname(TS.NODE_BIN.cli), b)); fs.chmodSync(path.join(path.dirname(TS.NODE_BIN.cli), b), 0o755); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// --service 写错了要报错，不能悄悄变成普通后台进程（重启后不会自己起来）
const SERVICE_KINDS = { darwin: ['launchd', 'launchd-boot', 'none'], linux: ['systemd', 'none'], win32: ['startup', 'none'] };
function checkService(s) {
  const ok = SERVICE_KINDS[process.platform] || ['none'];
  if (!ok.includes(s)) throw new Error(t('--service must be one of: {list}', { list: ok.join(', ') }));
  return s;
}

function optsFrom(opts, prev, env) {
  const access = opts.access || prev.access || env.recommend.access;
  if (!ACCESS.includes(access)) throw new Error(t('--access must be one of: {list}', { list: ACCESS.join(', ') }));
  if (IS_WIN && access === 'tailscale-node') throw new Error(t('--access tailscale-node is not available on Windows; use --access tailscale'));
  const timezone = opts.timezone || prev.timezone || systemTimezone();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error(t('Unknown timezone: {tz}', { tz: timezone })); }
  const port = Number(opts.port || prev.port || 4870);
  const contentPort = Number(opts['content-port'] || prev.contentPort || port + 1);
  return {
    access, timezone, port, contentPort,
    lang: normLang(opts.lang || prev.lang || env.recommend.lang),
    hostname: String(opts.hostname || prev.hostname || 'mydash').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    office: opts.office || prev.office || 'auto',
    binDir: path.resolve(String(opts['bin-dir'] || prev.binDir || DEFAULT_BIN_DIR).replace(/^~(?=\/)/, os.homedir())),
    service: checkService(opts.service || prev.service || serviceManager()),
    lan: opts.lan ? ['on', 'yes', 'true', '1'].includes(String(opts.lan).toLowerCase()) : prev.lan === true,
  };
}

// 只装命令行（--remote <网址> --token <令牌>）：这台机器上的 agent 发布时传到别的机器的 mydash，本机不跑服务
async function installClient(opts) {
  const prev = readConfig();
  const url = String(opts.remote).replace(/\/+$/, ''); const token = String(opts.token || prev.remote?.token || '');
  const steps = []; const human = []; const step = (id, ok, detail) => steps.push({ id, ok, detail });
  if (!/^https?:\/\//.test(url) || !token) return { ok: false, error: t('Usage: ./setup.sh install --remote <url> --token <token>'), steps, human, next: [] };
  let ping = null, err = '';
  try { ping = await remoteGet({ url, token }, '/api/remote/ping'); } catch (e) { err = e.message; }
  step('remote', Boolean(ping), ping ? `${url} · ${ping.host}` : t('Could not connect to {url}: {err}', { url, err }));
  if (!ping) return { ok: false, url, steps, human, next: [] };
  const lang = normLang(opts.lang || prev.lang || guessLangSafe()); setLang(lang);
  const binDir = path.resolve(String(opts['bin-dir'] || prev.binDir || DEFAULT_BIN_DIR).replace(/^~(?=\/)/, os.homedir()));
  step('copy', true, `${tilde(SRC)} → ${tilde(APP)} (${copyApp()})`);
  const shim = writeShim(binDir, which('node') || process.execPath);
  step('cli', true, tilde(shim) + (binDirOnPath(binDir) ? '' : ' · ' + t('not on PATH yet')));
  if (!binDirOnPath(binDir)) human.push({ id: 'path', agent: true, message: pathFix(binDir) });
  writeConfig({ ...prev, lang, binDir, client: true, remote: { url, token }, ...(opts.machine ? { machine: String(opts.machine).slice(0, 40) } : {}), source: fs.existsSync(path.join(SRC, '.git')) ? SRC : prev.source, installedVersion: JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version });
  step('config', true, tilde(CONFIG_PATH));
  const integ = { claude: integrationStatus('claude'), codex: integrationStatus('codex') };
  const next = []; for (const a of ['claude', 'codex']) if (integ[a].present && !integ[a].integrated) next.push(t('Ask the user, then run: mydash integrate {a} (preview the changes first with --dry-run)', { a }));
  return { ok: true, url: url + '/', client: true, steps, human, next, integrations: integ };
}
const guessLangSafe = () => (/^zh/i.test(process.env.LANG || '') ? 'zh' : 'en');

export async function install(opts = {}) {
  if (opts.remote) return installClient(opts);
  // 只装了命令行的机器（mydash update 不带 --remote 调到这里）：照样只更新命令行，不装出一整套本地服务
  { const prev = readConfig(); if (prev.client && prev.remote?.url && !opts.access && !opts.port) return installClient({ ...opts, remote: prev.remote.url }); }
  const env = await environment(opts);
  const required = env.checks.filter(c => c.level === 'required' && !c.ok);
  if (required.length) return { ok: false, error: 'requirements', checks: required };
  const prev = readConfig();
  const o = optsFrom(opts, prev, env);
  setLang(o.lang);
  const steps = []; const human = []; let needsBoot = false;
  const step = (id, ok, detail) => steps.push({ id, ok, detail });
  const node = which('node') || process.execPath;

  // Windows 会锁住正在用的文件：先停服务再复制代码
  if (IS_WIN) removeService('server', o.service);
  step('copy', true, `${tilde(SRC)} → ${tilde(APP)} (${copyApp()})`);
  for (const d of ['data', 'state', 'logs', 'bin']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
  const shim = writeShim(o.binDir, node);
  step('cli', true, tilde(shim) + (binDirOnPath(o.binDir) ? '' : ' · ' + t('not on PATH yet')));
  if (!binDirOnPath(o.binDir)) human.push({ id: 'path', agent: true, message: pathFix(o.binDir) });

  if (o.office !== 'no') {
    const r = await prepareOffice();
    // auto 时没装 LibreOffice 只是少一个功能，不算安装失败；明确要了（yes）才算
    step('office', Boolean(r) || o.office !== 'yes', r ? t('LibreOffice ready ({how})', { how: r }) : t('LibreOffice not found: Word / PowerPoint previews are off until it is installed'));
  }
  const pp = buildPdfPages();
  if (pp) step('pdf-pages', pp !== 'failed', pp === 'failed' ? t('building the PDF page renderer failed; PDFs will render in the browser') : t('PDF page renderer {state}', { state: pp }));

  // 访问方式：先算出网址和允许的主机名，写进配置，再启动服务
  const cfg = { ...prev, port: o.port, contentPort: o.contentPort, lang: o.lang, timezone: o.timezone, access: o.access, lan: o.lan, office: o.office, binDir: o.binDir, service: o.service, source: fs.existsSync(path.join(SRC, '.git')) ? SRC : prev.source, installedVersion: JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version };
  delete cfg.publicPort; delete cfg.hostname; delete cfg.tailnetNames;
  let tsTarget = null; let pub = 80;
  if (o.access === 'local') {
    cfg.baseUrl = `http://127.0.0.1:${o.port}`;
  } else if (o.access === 'tailscale') {
    const cli = TS.systemCli();
    const st = cli ? TS.status({ cli }) : null;
    if (!cli || st?.BackendState !== 'Running') {
      cfg.baseUrl = `http://127.0.0.1:${o.port}`;
      human.push({ id: 'tailscale-login', message: cli ? t('Tailscale is installed but not logged in. Ask the user to open Tailscale and log in, then run setup install again.') : t('Tailscale is not installed. Install it from https://tailscale.com/download and log in, then run setup install again.') });
    } else {
      tsTarget = { cli };
      const nm = TS.names(st);
      const map = TS.serveMap(tsTarget);
      const ours = `http://127.0.0.1:${o.port}`;
      pub = Number(opts['public-port'] || prev.publicPort || 80);
      if (map[pub] && map[pub] !== ours) pub = o.port; // 80 已被别的服务占用
      if (pub !== 80) cfg.publicPort = pub;
      cfg.baseUrl = `http://${nm.short}${pub === 80 ? '' : ':' + pub}`;
      cfg.tailnetNames = [nm.short];
    }
  } else {
    cfg.hostname = o.hostname; cfg.tailnetNames = [o.hostname];
    cfg.baseUrl = `http://${o.hostname}`;
  }
  // 以前用系统 Tailscale 转发、这次换成别的：转发关掉，那个 tailnet 名字也不再放行
  if (prev.access === 'tailscale' && o.access !== 'tailscale') {
    const cli = TS.systemCli();
    if (cli) for (const p of [Number(prev.publicPort || 80), Number(prev.contentPort || 4871)]) {
      const map = TS.serveMap({ cli }); const tgt = String(map[p] || '');
      if (tgt === `http://127.0.0.1:${prev.port || 4870}` || tgt === `http://127.0.0.1:${prev.contentPort || 4871}`) { TS.serveOff({ cli }, p); step(`serve:${p}`, true, t('stopped forwarding :{port} on Tailscale', { port: p })); }
    }
  }
  const dropNames = (prev.tailnetNames || []).filter(n => !(cfg.tailnetNames || []).includes(n));
  cfg.allowedHosts = [...new Set([...(prev.allowedHosts || []).filter(h => !dropNames.includes(h)), ...(cfg.tailnetNames || [])])];
  writeConfig(cfg);
  step('config', true, tilde(CONFIG_PATH));

  // 服务。换了服务方式（比如从普通进程换成 systemd）：先停掉旧的，免得两份抢同一个端口
  if (prev.service && prev.service !== o.service) {
    for (const k of ['server', 'tailscaled']) removeService(k, prev.service);
    if (prev.service === 'launchd-boot' && (serviceInstalled('server', 'launchd-boot') || serviceInstalled('tailscaled', 'launchd-boot'))) human.push({ id: 'boot-service-off', command: `sudo ${path.join(o.binDir, 'mydash')} service login`, message: t('mydash still starts at boot as a system service. The user runs this once to remove it (it asks for their password); then run setup install again.') });
  }
  if (o.access === 'tailscale-node') {
    const b = await ensureNodeBinaries();
    step('tailscale-binaries', b.ok, b.ok ? tilde(path.dirname(TS.NODE_BIN.cli)) : b.error);
    if (b.ok) {
      fs.mkdirSync(path.join(TS.TS_DIR, 'state'), { recursive: true });
      // 开机就启动时也要过一遍：节点在跑（登录后那个）也得把开机版放好；已经是开机版、内容没变就什么都不动
      if (o.service === 'launchd-boot' || !fs.existsSync(TS.NODE_SOCKET) || !TS.status({ cli: TS.NODE_BIN.cli, socket: TS.NODE_SOCKET })) {
        const r = await installService('tailscaled', [TS.NODE_BIN.daemon, '--tun=userspace-networking', `--statedir=${path.join(TS.TS_DIR, 'state')}`, `--socket=${TS.NODE_SOCKET}`, '--port=0'], {}, o.service);
        if (r.needsRoot) needsBoot = true;
        step('tailscaled', r.ok || r.needsRoot, r.ok ? SERVICES_LABEL('tailscaled', o.service) : r.needsRoot ? t('ready to start at boot, after one administrator step') : r.error);
        for (let i = 0; i < 40 && !fs.existsSync(TS.NODE_SOCKET); i++) await sleep(250);
      } else step('tailscaled', true, t('already running'));
    }
  } else {
    removeService('tailscaled', o.service);
    // 开机启动的系统级节点还在：要用户再跑一次 sudo … service boot 把它删掉
    if (o.service === 'launchd-boot' && serviceInstalled('tailscaled', 'launchd-boot')) needsBoot = true;
  }
  const srv = await installService('server', [node, path.join(APP, 'server.mjs')], { MYDASH_HOME: HOME }, o.service);
  if (srv.needsRoot) needsBoot = true;
  step('server', srv.ok || srv.needsRoot, srv.ok ? SERVICES_LABEL('server', o.service) : srv.needsRoot ? t('ready to start at boot, after one administrator step') : srv.error);
  // 开机就启动（launchd-boot）要装进系统目录，只能用户自己用管理员身份跑一次
  if (needsBoot) human.push({ id: 'boot-service', command: `sudo ${path.join(o.binDir, 'mydash')} service boot`, // sudo 的 PATH 里没有 ~/.local/bin，写全路径
     message: t('To start mydash at boot, before anyone logs in, the user runs this once (it asks for their password). Until then mydash keeps running the way it did.') });
  let okMain = await waitHealthy(o.port); let okContent = await waitHealthy(o.contentPort, 5000);
  // 再等一会儿复查：有些问题（比如某个端口监听失败）要启动一两秒后才会让服务退出
  if (okMain && okContent) { await sleep(1500); okMain = await waitHealthy(o.port, 3000); okContent = await waitHealthy(o.contentPort, 3000); }
  step('health', okMain && okContent, okMain && okContent ? t('both ports respond ({a}, {b})', { a: o.port, b: o.contentPort }) : t('the service did not come up; see {log}', { log: tilde(path.join(HOME, 'logs')) }));

  // 转发到 tailnet
  if (tsTarget) {
    for (const [p, local] of [[pub, o.port], [o.contentPort, o.contentPort]]) {
      const r = TS.serve(tsTarget, p, local);
      step(`serve:${p}`, r.ok, r.ok ? `:${p} → 127.0.0.1:${local}` : r.out);
      if (!r.ok && /denied|permission|operator/i.test(r.out)) human.push({ id: 'tailscale-operator', command: `sudo tailscale set --operator=${os.userInfo().username}`, message: t('Tailscale needs permission for this user to run tailscale serve. The user must run the command (it asks for their password), then run setup install again.') });
    }
  }
  if (o.access === 'tailscale-node' && fs.existsSync(TS.NODE_BIN.cli)) {
    const tg = { cli: TS.NODE_BIN.cli, socket: TS.NODE_SOCKET };
    let st = TS.status(tg);
    if (st && st.BackendState !== 'Running' && !st.AuthURL) { TS.up(tg, o.hostname); await sleep(1500); st = TS.status(tg); }
    if (st?.BackendState === 'Running') step('tailscale-node', true, TS.names(st).fqdn || o.hostname);
    else if (st?.AuthURL) human.push({ id: 'tailscale-node-login', url: st.AuthURL, message: t('Ask the user to open this link and approve the new device “{h}” in their tailnet. Forwarding is set up automatically within a minute after that.', { h: o.hostname }) });
    else step('tailscale-node', false, st?.BackendState || t('not running'));
  }

  // 欢迎条目：装完在手机上一打开就知道装好了
  if (okMain && !readMeta('mydash', 'welcome')) {
    try {
      const dir = path.join(APP, 'welcome', o.lang);
      if (fs.existsSync(dir)) { await publish([dir], { cwd: dir, slug: 'welcome', 'force-project': 'mydash', detected: { name: 'mydash', session: false, agent: null } }); step('welcome', true, 'mydash/welcome'); }
    } catch (e) { step('welcome', false, e.message); }
  }

  if (o.lan) { accessCode(); step('lan', true, lanUrls(o.port).join('  ')); for (const h of firewallNotes()) human.push(h); }
  // 以前接入过的（规则、放行、钩子）刷新到这个版本：mydash update 也走这里，不然新加的钩子老用户装不上
  for (const a of ['claude', 'codex']) {
    const r = refreshIntegration(a);
    for (const c of r.changes) step(`refresh-${a}`, true, `${tilde(c.file)} · ${c.detail}`);
    if (r.codexTrust) human.push({ id: 'codex-hooks-trust', message: t('The mydash hooks for Codex changed, so the user has to trust them once: open Codex in a terminal, type /hooks, and trust the mydash ones (their command runs ~/.mydash/app/bin/agent-ask.mjs or agent-state.mjs). Until then Codex works as before, without mydash.') });
  }
  const integ = { claude: integrationStatus('claude'), codex: integrationStatus('codex') };
  const next = [];
  for (const a of ['claude', 'codex']) if (integ[a].present && !integ[a].integrated) next.push(t('Ask the user, then run: mydash integrate {a} (preview the changes first with --dry-run)', { a }));
  const ok = steps.every(s => s.ok);
  return { ok, url: cfg.baseUrl + '/', access: o.access, lang: o.lang, timezone: o.timezone, ...(o.lan ? { lan: { urls: lanUrls(o.port), code: prettyCode(accessCode()) } } : {}), steps, human, next, integrations: integ };
}
// 开局域网访问时，系统防火墙可能要用户点一下"允许"
function firewallNotes() {
  const node = which('node') || process.execPath;
  if (process.platform === 'darwin') {
    const st = sh('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']).out;
    if (/enabled|State = [12]/i.test(st)) return [{ id: 'firewall', command: `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${node}" --unblockapp "${node}"`, message: t('The macOS firewall is on. If it asks whether node may accept incoming connections, choose Allow; or the user runs this command once.') }];
  }
  if (IS_WIN) return [{ id: 'firewall', message: t('Windows may ask whether Node.js may communicate on private networks. Choose Allow (it needs an administrator once).') }];
  return [];
}

// 改了监听方式（局域网开关）后重启服务
export async function restartServer() {
  const cfg = readConfig(); const mgr = cfg.service || serviceManager();
  const r = await installService('server', [which('node') || process.execPath, path.join(APP, 'server.mjs')], { MYDASH_HOME: HOME }, mgr);
  if (!r.ok || !await waitHealthy(Number(cfg.port || 4870))) return false;
  await sleep(1500);
  return waitHealthy(Number(cfg.port || 4870), 3000);
}

// mydash lan [on|off|reset] [--json]
export async function cmdLan(pos, opts) {
  const sub = pos[0] || 'status';
  if (!fs.existsSync(CONFIG_PATH)) { process.stderr.write(t('no config: mydash is not installed') + '\n'); process.exitCode = 1; return; }
  const cfg = readConfig(); let restarted = null; const human = [];
  if (sub === 'on' || sub === 'off') {
    const want = sub === 'on';
    if (cfg.lan !== want) { writeConfig({ ...cfg, lan: want }); restarted = await restartServer(); }
    if (want) { accessCode(); human.push(...firewallNotes()); }
  } else if (sub === 'reset') resetAccess();
  else if (sub !== 'status') { process.stderr.write(t('Usage: mydash lan [on|off|reset] [--json]') + '\n'); process.exitCode = 1; return; }
  const now = readConfig();
  const urls = now.lan ? lanUrls(Number(now.port || 4870)) : [];
  const r = { ok: restarted !== false, lan: now.lan === true, urls, code: now.lan ? prettyCode(accessCode()) : null, loginUrl: urls.length ? loginUrl(urls[urls.length - 1]) : null, devices: now.lan ? deviceCount() : 0, human };
  if (opts.json) { process.stdout.write(JSON.stringify(r) + '\n'); return; }
  if (!r.lan) { process.stdout.write(t('LAN access is off. Turn it on with: mydash lan on') + '\n'); return; }
  process.stdout.write(t('Devices on the same Wi-Fi can open:') + '\n' + urls.map(u => '  ' + u).join('\n') + '\n' + t('Access code: {code} (each device enters it once)', { code: r.code }) + '\n' + t('{n} device logged in.|{n} devices logged in.', { n: r.devices }) + '\n');
  if (r.loginUrl && process.stdout.isTTY) process.stdout.write('\n' + t('Scan to open and log in:') + '\n' + qrAscii(r.loginUrl) + '\n');
  for (const h of human) process.stdout.write(`→ ${h.message}${h.command ? `\n  ${h.command}` : ''}\n`);
  if (restarted === false) process.stdout.write(t('the service did not come up; see {log}', { log: tilde(path.join(HOME, 'logs')) }) + '\n');
}

function SERVICES_LABEL(key, mgr) { return `${mgr} ${mgr === 'systemd' ? SERVICES[key].systemd : SERVICES[key].launchd}`; }

export async function uninstall({ purge = false } = {}) {
  const cfg = readConfig(); const mgr = cfg.service || serviceManager(); const done = [];
  // 开机就启动的系统服务要管理员才能删：先让用户删掉，再卸载（不然它会对着删掉的程序一直重启）
  if (process.platform === 'darwin' && ['server', 'tailscaled'].some(k => serviceInstalled(k, 'launchd-boot'))) {
    const shim = path.join(cfg.binDir || DEFAULT_BIN_DIR, 'mydash');
    return { ok: false, error: 'boot-service', done, human: [{ id: 'boot-service-off', command: `sudo ${shim} service login`, message: t('mydash starts at boot as a system service. The user runs this once to remove it (it asks for their password); then run uninstall again.') }] };
  }
  for (const a of ['claude', 'codex']) { const plan = integrate(a, { remove: true }); if (plan.length) done.push(`integrate ${a} --remove: ${plan.map(p => p.action).join(', ')}`); }
  // 系统 Tailscale 上指向这一套端口的转发都关掉（不管现在是哪种访问方式：以前换过方式、或手动加的备用地址，卸载后都只会指向空端口）
  { const cli = TS.systemCli();
    if (cli) for (const [p, tgt] of Object.entries(TS.serveMap({ cli }))) {
      if (tgt === `http://127.0.0.1:${cfg.port || 4870}` || tgt === `http://127.0.0.1:${cfg.contentPort || 4871}`) { TS.serveOff({ cli }, Number(p)); done.push(`tailscale serve :${p} off`); }
    } }
  if (cfg.access === 'tailscale-node' && fs.existsSync(TS.NODE_BIN.cli) && purge) { sh(TS.NODE_BIN.cli, [`--socket=${TS.NODE_SOCKET}`, 'logout']); done.push('tailscale-node logout'); }
  for (const k of ['server', 'tailscaled']) if (removeService(k, mgr)) done.push(`${k} service removed`);
  for (const name of ['mydash', 'mydash.cmd']) {
    const shim = path.join(cfg.binDir || DEFAULT_BIN_DIR, name);
    const body = fs.existsSync(shim) ? fs.readFileSync(shim, 'utf8') : '';
    if (body.includes('mydash.mjs') && (body.includes(path.join(APP, 'bin', 'mydash.mjs')) || body.includes(path.join(APP, 'bin', 'mydash.mjs').replace(/\\/g, '/')))) { fs.rmSync(shim); done.push(tilde(shim) + ' removed'); }
  }
  if (purge) { fs.rmSync(HOME, { recursive: true, force: true }); done.push(tilde(HOME) + ' deleted (data included)'); }
  else { if (!fs.existsSync(path.join(APP, '.git'))) fs.rmSync(APP, { recursive: true, force: true }); done.push(t('kept your data in {dir}; delete it with --purge', { dir: tilde(DATA_DIR) })); }
  return { ok: true, done };
}

export async function update() {
  const cfg = readConfig();
  const src = cfg.source;
  if (!src || !fs.existsSync(path.join(src, '.git'))) return { ok: false, error: t('No source checkout recorded. Clone the repository again and run ./setup.sh install from it.') };
  const before = sh('git', ['-C', src, 'rev-parse', 'HEAD']).out.trim();
  const pull = sh('git', ['-C', src, 'pull', '--ff-only'], { timeout: 300_000 });
  if (!pull.ok) return { ok: false, error: pull.out };
  const after = sh('git', ['-C', src, 'rev-parse', 'HEAD']).out.trim();
  const log = before !== after ? sh('git', ['-C', src, 'log', '--oneline', `${before}..${after}`]).out.trim().split('\n') : [];
  const ci = npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: src, timeout: 600_000 });
  if (!ci.ok) return { ok: false, error: t('npm ci failed (no network?); the code was pulled but not installed. Fix it, then run ./setup.sh install in {dir}.', { dir: src }) + '\n' + String(ci.out).slice(-800), updated: before !== after, changes: log };
  const r = spawnSync(process.execPath, [path.join(src, 'bin', 'mydash.mjs'), 'setup', 'install', '--json'], { encoding: 'utf8', timeout: 1_800_000 });
  let res; try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { res = { ok: false, error: (r.stderr || r.stdout).slice(-800) }; }
  return { ...res, updated: before !== after, changes: log };
}

// ---------- 命令行 ----------
export function printUninstall(r) {
  for (const d of r.done || []) process.stdout.write(`✓ ${d}\n`);
  for (const h of r.human || []) process.stdout.write(`→ ${t('(needs the user) ')}${h.message}${h.command ? `\n  ${h.command}` : ''}\n`);
}
function printInstall(r) {
  if (r.error === 'requirements') { process.stdout.write(t('Requirements are missing:') + '\n'); printChecks(r.checks); return; }
  for (const s of r.steps) process.stdout.write(`${s.ok ? '✓' : '✗'} ${s.id.padEnd(18)} ${s.detail}\n`);
  for (const h of r.human) process.stdout.write(`→ ${h.agent ? '' : t('(needs the user) ')}${h.message}${h.url ? `\n  ${h.url}` : ''}${h.command ? `\n  ${h.command}` : ''}\n`);
  for (const n of r.next) process.stdout.write(`· ${n}\n`);
  process.stdout.write(`\n${r.url}\n`);
}

export async function cmdSetup(pos, opts) {
  const sub = pos[0];
  if (opts.help || !['check', 'install', 'uninstall'].includes(sub)) { process.stdout.write(lang() === 'zh' ? SETUP_HELP_ZH : SETUP_HELP); return; }
  const out = (r, pretty) => { if (opts.json) process.stdout.write(JSON.stringify(r) + '\n'); else pretty(r); if (r.ok === false) process.exitCode = 1; };
  if (sub === 'check') {
    const env = await environment(opts);
    const r = { ok: allRequiredOk(env.checks), checks: env.checks, recommend: env.recommend, questions: questions(env) };
    return out(r, x => { printChecks(x.checks); process.stdout.write('\n' + t('Recommended: {r}', { r: JSON.stringify(x.recommend) }) + '\n'); });
  }
  if (sub === 'install') {
    let r; try { r = await install(opts); } catch (e) { r = { ok: false, error: e.message, steps: [], human: [], next: [] }; }
    return out(r, x => (x.steps ? printInstall(x) : process.stdout.write(x.error + '\n')));
  }
  if (sub === 'uninstall') return out(await uninstall({ purge: Boolean(opts.purge) }), printUninstall);
  process.stdout.write(lang() === 'zh' ? SETUP_HELP_ZH : SETUP_HELP);
}

function questions(env) {
  const q = [{
    id: 'access', recommended: env.recommend.access, ask: t('Where should mydash be reachable?'),
    options: [
      { value: 'local', label: t('Only on this computer') },
      ...(env.tailscale.cli ? [{ value: 'tailscale', label: t('From the user’s other devices (phone included) over Tailscale, at http://{name}/', { name: env.tailscale.short || '<this-machine>' }) }] : []),
      { value: 'tailscale-node', label: t('Over Tailscale under its own name, at http://mydash/ (adds a device to the tailnet; needs one approval)') },
    ],
  }, {
    id: 'lan', recommended: 'off', ask: t('Also open it from other devices on the same Wi-Fi? They need an access code the first time.'),
    options: [{ value: 'off', label: t('No') }, { value: 'on', label: t('Yes (--lan on)') }],
  }, {
    id: 'lang', recommended: env.recommend.lang, ask: t('Which language should the pages use?'), options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }],
  }];
  if (!findSoffice()) q.push({ id: 'office', recommended: 'no', ask: t('Install LibreOffice so Word and PowerPoint files get previews? (large download)'), options: [{ value: 'yes', label: t('Yes') }, { value: 'no', label: t('No') }] });
  if (/^(UTC|Etc\/)/.test(env.recommend.timezone)) q.push({ id: 'timezone', recommended: env.recommend.timezone, ask: t('Which timezone is the user in? (the server clock is UTC)'), options: [] });
  return q;
}

const SETUP_HELP = `mydash setup: install and maintain mydash (meant to be run by a coding agent; see INSTALL.md)

  ./setup.sh check [--json]                 look at this machine and recommend options
  ./setup.sh install [options] [--json]     install or update in place (safe to re-run)
  ./setup.sh uninstall [--purge] [--json]   remove services and integrations (--purge also deletes data)
  (Windows: setup.cmd instead of ./setup.sh)

install options
  --access local|tailscale|tailscale-node   where it can be opened (default: tailscale if logged in, else local)
  --lang en|zh                              page language
  --timezone <IANA name>                    e.g. Europe/London (default: the system timezone)
  --hostname <name>                         device name for --access tailscale-node (default: mydash)
  --office auto|yes|no                      Word / PowerPoint previews with LibreOffice (default: auto)
  --port <n> --content-port <n>             default 4870 and 4871
  --bin-dir <dir>                           where to put the mydash command (default: ~/.local/bin)
  --service launchd|launchd-boot|systemd|startup|none    default: what this system has (startup = Windows Startup folder;
                                            launchd-boot = macOS, start at boot without logging in; then run sudo mydash service boot once)
  --lan on|off                              also open on the same Wi-Fi, with an access code (default: off)
  --remote <url> --token <token>            install only the command, and publish to the mydash at <url>
                                            (make the token there with: mydash remote token --name <this machine>)
  --machine <name>                          with --remote: how this machine is labelled on the pages
`;

const SETUP_HELP_ZH = `mydash setup：安装和维护 mydash（给编程 agent 运行，见 INSTALL.md）

  ./setup.sh check [--json]                 检查这台机器，给出推荐选项
  ./setup.sh install [选项] [--json]        安装，或原地更新（可以重复运行）
  ./setup.sh uninstall [--purge] [--json]   移除服务和集成（--purge 连数据一起删）
  （Windows 上用 setup.cmd 代替 ./setup.sh）

install 选项
  --access local|tailscale|tailscale-node   在哪里能打开（默认：Tailscale 已登录就用 tailscale，否则 local）
  --lang en|zh                              网页语言
  --timezone <IANA 时区>                    例如 Asia/Shanghai（默认用系统时区）
  --hostname <名字>                         --access tailscale-node 时的设备名（默认 mydash）
  --office auto|yes|no                      用 LibreOffice 生成 Word / PPT 预览（默认 auto）
  --port <n> --content-port <n>             默认 4870 和 4871
  --bin-dir <目录>                          mydash 命令放在哪里（默认 ~/.local/bin）
  --service launchd|launchd-boot|systemd|startup|none    默认用系统自带的（startup = Windows"启动"文件夹；
                                            launchd-boot = macOS 开机就启动、不用登录，之后运行一次 sudo mydash service boot）
  --lan on|off                              同一 WiFi 下的设备凭访问码也能打开（默认关）
  --remote <网址> --token <令牌>            只装命令行，发布时传到 <网址> 那台机器的 mydash
                                            （令牌在那台机器上生成：mydash remote token --name <这台机器>）
  --machine <名字>                          配合 --remote：网页上怎么称呼这台机器
`;

// mydash notify bark <url> [--name 名字] | ntfy <url> | … | remove <编号或名字> | daily <HH:MM|off> | test | off | （不带参数看状态）
// 同一种可以加好几个：目标一样就更新那一个，不一样就新加
// 渠道名（给人看的）
export const channelName = type => ({ bark: 'Bark', ntfy: 'ntfy', telegram: 'Telegram', pushover: 'Pushover', webhook: t('group bot'), email: t('email'), webpush: t('web push') })[type] || type;

export async function cmdNotify(pos, opts) {
  if (!fs.existsSync(CONFIG_PATH)) { process.stderr.write(t('no config: mydash is not installed') + '\n'); process.exitCode = 1; return; }
  const cfg = readConfig(); const [sub, arg, arg2] = pos;
  const out = r => { if (opts.json) process.stdout.write(JSON.stringify(r) + '\n'); else process.stdout.write(r.message + '\n'); if (!r.ok) process.exitCode = 1; };
  if (CHANNEL_TYPES.includes(sub)) {
    // 几个渠道可以同时开；mydash notify <渠道> off 去掉这一种的全部
    if (arg === 'off') { writeConfig({ ...cfg, notify: withChannel(cfg.notify, sub, null) }); return out({ ok: true, message: t('{svc} notifications are off.', { svc: channelName(sub) }) }); }
    const fields = sub === 'telegram' ? { token: arg, chat: arg2 } : sub === 'pushover' ? { user: arg, token: arg2 }
      : sub === 'email' ? { host: opts.host, port: opts.port, secure: opts.secure, user: opts.user, pass: opts.pass, from: opts.from, to: opts.to }
      : { url: arg, ...(sub === 'webhook' && opts.secret ? { secret: opts.secret } : {}) };
    const ch = { type: sub, ...fields }; const bad = badField(ch);
    if (bad) return out({ ok: false, field: bad, message: t('Missing or invalid “{field}”. Usage: {usage}', { field: bad, usage: NOTIFY_USAGE[sub] }) });
    writeConfig({ ...cfg, notify: withChannel(cfg.notify, sub, fields, { name: typeof opts.name === 'string' ? opts.name : '' }) });
    if (sub === 'email' || sub === 'telegram' || sub === 'pushover' || sub === 'webhook') chmodConfig();
    const r = await sendTo(ch, { title: 'mydash', body: t('Notifications are on.') });
    return out({ ok: r.ok, message: r.ok ? t('Notifications are on; a test was just sent. Only titles and project names go through {svc}; the content stays here.', { svc: channelName(sub) }) : t('Saved, but the test failed: {err}', { err: r.error || r.status }) });
  }
  if (sub === 'daily') {
    const n = notifySettings(cfg);
    if (arg === 'off') { writeConfig({ ...cfg, notify: { channels: n.channels } }); return out({ ok: true, message: t('Daily summary is off.') }); }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(arg || '')) return out({ ok: false, message: t('Use 24-hour time, e.g. mydash notify daily 21:00') });
    writeConfig({ ...cfg, notify: { channels: n.channels, daily: arg } });
    return out({ ok: true, message: t('A summary will be sent every day at {time} ({tz}).', { time: arg, tz: cfg.timezone || systemTimezone() }) });
  }
  if (sub === 'test') { const r = await sendPush({ title: 'mydash', body: t('Test notification') }); return out({ ok: r.ok, results: r.results, message: r.ok ? t('Sent.') + (r.error ? ` (${r.error})` : '') : t('Failed: {err}', { err: r.error || r.status || t('notifications are not set up') }) }); }
  if (sub === 'off') { const c = { ...cfg }; delete c.notify; writeConfig(c); return out({ ok: true, message: t('Notifications are off.') }); }
  if (sub === 'remove') {
    const n = notifySettings(cfg); const hit = n.channels.find(c => c.id === arg || (arg && c.name === arg));
    if (!hit) return out({ ok: false, message: t('No such notification service: {id}. Run mydash notify to see the list.', { id: arg || '' }) });
    writeConfig({ ...cfg, notify: withChannels(n, n.channels.filter(c => c.id !== hit.id)) });
    return out({ ok: true, message: t('Removed {name}.', { name: hit.name || channelName(hit.type) }) });
  }
  const all = notifySettings(cfg).channels; const n = notifyConfig();
  const line = c => `  ${c.id}  ${channelName(c.type).padEnd(9)} ${c.name ? `${c.name}  ` : ''}${maskValue(c[CHANNELS[c.type].main]) && CHANNELS[c.type].hide ? maskValue(c[CHANNELS[c.type].main]) : c[CHANNELS[c.type].main]}${c.off ? `  (${t('off')})` : ''}`;
  if (opts.json) return out({ ok: true, notify: n && { ...n, channels: all.map(c => ({ id: c.id, type: c.type, name: c.name || '', off: Boolean(c.off) })) } });
  return out({ ok: true, message: all.length ? [t('Notifications · daily summary {daily}', { daily: n?.daily || t('off') }), ...all.map(line)].join('\n') : t('Notifications are off. Set them up on the settings page, or with: mydash notify bark <url>') });
}
const NOTIFY_USAGE = {
  bark: 'mydash notify bark https://api.day.app/<key>', ntfy: 'mydash notify ntfy https://ntfy.sh/<topic>',
  telegram: 'mydash notify telegram <bot token> <chat id>', pushover: 'mydash notify pushover <user key> <app token>',
  webhook: 'mydash notify webhook <url> [--secret <signing secret>]',
  email: 'mydash notify email --host smtp.example.com --port 465 --secure tls --user me@example.com --pass <password> --to me@example.com',
};
// 推送渠道里有密码、令牌时，配置文件只给自己读
function chmodConfig() { if (process.platform !== 'win32') { try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {} } }
