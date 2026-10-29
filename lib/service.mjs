// 后台服务：macOS 用 launchd（用户级 LaunchAgents，登录后运行；或 launchd-boot：系统级 LaunchDaemons，
// 开机就以本人身份运行，没人登录也在——停电重启后不用登录就能从手机连上。装这个要一次管理员权限：sudo mydash service boot），
// Linux 用 systemd --user，
// Windows 用"启动"文件夹（登录时隐藏运行 lib/supervise.mjs，崩了自动重启，不需要管理员），
// 都没有（比如容器里）就直接起一个后台进程：能用，但机器重启后不会自己起来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './store.mjs';
import { IS_WIN } from './sys.mjs';

// 装在本人家目录的 ~/.mydash 时服务名是 mydash.server；装在别处（测试、第二套）时加上路径哈希，互不冲突。
// 用 userInfo().homedir（来自系统账户，不受 $HOME 影响）判断，换了 $HOME 跑的测试也不会撞名。
export const IS_DEFAULT_HOME = path.resolve(HOME) === path.join(os.userInfo().homedir, '.mydash');
const SUFFIX = IS_DEFAULT_HOME ? '' : '-' + crypto.createHash('sha1').update(path.resolve(HOME)).digest('hex').slice(0, 6);
export const SERVICES = {
  server: { launchd: `mydash.server${SUFFIX}`, systemd: `mydash${SUFFIX}.service`, desc: 'mydash web server' },
  tailscaled: { launchd: `mydash.tailscaled${SUFFIX}`, systemd: `mydash-tailscaled${SUFFIX}.service`, desc: 'mydash dedicated Tailscale node' },
};

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, ...opts }).toString();
const tryRun = (cmd, args, opts) => { try { return { ok: true, out: run(cmd, args, opts) }; } catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message) }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const logFile = name => path.join(HOME, 'logs', `${name}.log`);

export function serviceManager() {
  if (process.platform === 'darwin') return 'launchd';
  if (IS_WIN) return 'startup';
  if (process.platform === 'linux' && tryRun('systemctl', ['--user', 'show-environment']).ok) return 'systemd';
  return 'none';
}

// ---------- launchd ----------
const uid = () => process.getuid();
const plistPath = label => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const xmlEsc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function plistXml(label, args, env) {
  const envXml = Object.keys(env).length ? `\n  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xmlEsc(k)}</key><string>${xmlEsc(v)}</string>`).join('')}</dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xmlEsc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xmlEsc(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>${envXml}
  <key>StandardOutPath</key><string>${xmlEsc(logFile(label))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(logFile(label))}</string>
</dict></plist>
`;
}
async function launchdInstall(label, args, env) {
  fs.mkdirSync(path.dirname(plistPath(label)), { recursive: true });
  fs.writeFileSync(plistPath(label), plistXml(label, args, env));
  tryRun('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  for (let i = 0; i < 20 && tryRun('launchctl', ['print', `gui/${uid()}/${label}`]).ok; i++) await sleep(250);
  let last;
  for (let i = 0; i < 4; i++) { last = tryRun('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(label)]); if (last.ok) return { ok: true }; await sleep(1000); }
  return { ok: false, error: last.out.trim() };
}
// ---------- launchd-boot：开机就跑（/Library/LaunchDaemons，UserName 是本人，绝不以 root 运行）----------
// 写 /Library/LaunchDaemons 要 root：安装程序（以本人身份）把要装的 plist 放在 state/boot/，
// 再由用户跑一次 sudo mydash service boot 装进去。之后更新代码不用 root：服务器看到 app/.restart 变了就自己退出，launchd 再拉起来
export const DAEMON_DIR = '/Library/LaunchDaemons';
const daemonPath = label => path.join(DAEMON_DIR, `${label}.plist`);
const stagePath = label => path.join(HOME, 'state', 'boot', `${label}.plist`);
function daemonXml(label, args, env) {
  const u = os.userInfo();
  return plistXml(label, args, { HOME: u.homedir, USER: u.username, ...env })
    .replace('<key>RunAtLoad</key>', `<key>UserName</key><string>${xmlEsc(u.username)}</string>\n  <key>GroupName</key><string>staff</string>\n  <key>RunAtLoad</key>`);
}
async function bootInstall(key, label, args, env) {
  const want = daemonXml(label, args, env);
  let have = null; try { have = fs.readFileSync(daemonPath(label), 'utf8'); } catch {}
  if (have === want) {
    // 已经装好、内容没变：服务器靠 app/.restart 自己重启换上新代码；Tailscale 节点不用动
    if (key === 'server') { fs.writeFileSync(path.join(HOME, 'app', '.restart'), String(Date.now())); await sleep(3000); }
    return { ok: true };
  }
  fs.mkdirSync(path.dirname(stagePath(label)), { recursive: true });
  fs.writeFileSync(stagePath(label), want);
  // 管理员那一步做完之前，原来那个照常跑：服务器重启一下换上新代码（登录后启动的用 kickstart；已经是系统级的，靠 app/.restart）
  if (key === 'server' && fs.existsSync(plistPath(label))) { tryRun('launchctl', ['kickstart', '-k', `gui/${uid()}/${label}`]); await sleep(1500); }
  else if (key === 'server' && have != null) { fs.writeFileSync(path.join(HOME, 'app', '.restart'), String(Date.now())); await sleep(3000); }
  return { ok: false, needsRoot: true, error: 'run once as administrator: sudo mydash service boot' };
}

function launchdRemove(label) {
  tryRun('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  const p = plistPath(label); const existed = fs.existsSync(p);
  fs.rmSync(p, { force: true });
  return existed;
}

// ---------- systemd --user ----------
const unitPath = unit => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', unit);
const sdq = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
function unitText(desc, args, env, name) {
  return `[Unit]
Description=${desc}
After=network-online.target

[Service]
ExecStart=${args.map(sdq).join(' ')}
WorkingDirectory=${HOME}
${Object.entries(env).map(([k, v]) => `Environment=${sdq(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=2
StandardOutput=append:${logFile(name)}
StandardError=append:${logFile(name)}

[Install]
WantedBy=default.target
`;
}
function systemdInstall(unit, desc, args, env, name) {
  fs.mkdirSync(path.dirname(unitPath(unit)), { recursive: true });
  fs.writeFileSync(unitPath(unit), unitText(desc, args, env, name));
  tryRun('systemctl', ['--user', 'daemon-reload']);
  const r = tryRun('systemctl', ['--user', 'enable', unit]);
  const s = tryRun('systemctl', ['--user', 'restart', unit]);
  return r.ok && s.ok ? { ok: true } : { ok: false, error: (r.ok ? s.out : r.out).trim() };
}
function systemdRemove(unit) {
  tryRun('systemctl', ['--user', 'disable', '--now', unit]);
  const existed = fs.existsSync(unitPath(unit));
  fs.rmSync(unitPath(unit), { force: true });
  tryRun('systemctl', ['--user', 'daemon-reload']);
  return existed;
}
// 没开 linger 时，用户退出登录（比如 SSH 断开）后 systemd --user 的服务会被停掉
export function lingerEnabled() {
  const r = tryRun('loginctl', ['show-user', os.userInfo().username, '--property=Linger']);
  return r.ok ? /Linger=yes/.test(r.out) : null;
}

// ---------- Windows："启动"文件夹里的 .vbs ----------
const startupDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = name => path.join(startupDir(), `${name}.vbs`);
const vbq = s => `"${String(s).replace(/"/g, '""')}"`;
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }); } catch {} }
function startupStop(name) {
  let pid; try { pid = Number(fs.readFileSync(pidFile(name), 'utf8')); } catch {}
  if (pid && pidIsOurs(pid)) killTree(pid);
  fs.rmSync(pidFile(name), { force: true });
}
function startupInstall(name, args, env) {
  startupStop(name);
  const sup = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervise.mjs');
  const cmdline = [process.execPath, sup, name, '--', ...args].map(a => vbq(a).replace(/^"|"$/g, '""')).join(' ');
  const text = `' mydash: starts ${name} hidden when you sign in. Written by mydash setup; removed by mydash uninstall.\r\n` +
    `Set sh = CreateObject("WScript.Shell")\r\n` +
    Object.entries(env).map(([k, v]) => `sh.Environment("Process")(${vbq(k)}) = ${vbq(v)}\r\n`).join('') +
    `sh.Run "${cmdline}", 0, False\r\n`;
  fs.mkdirSync(startupDir(), { recursive: true });
  // UTF-16LE 带 BOM：路径里有中文用户名时 wscript 也能读对
  fs.writeFileSync(vbsPath(name), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
  spawn('wscript.exe', [vbsPath(name)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { ok: true };
}
function startupRemove(name) {
  startupStop(name);
  const existed = fs.existsSync(vbsPath(name));
  fs.rmSync(vbsPath(name), { force: true });
  return existed;
}

// ---------- 无服务管理器：直接起后台进程 ----------
const pidFile = name => path.join(HOME, 'run', `${name}.pid`);
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
// pid 文件里记的进程还是不是我们起的：重启以后进程号可能被别的程序用了，不能照着杀
function pidIsOurs(pid) {
  if (!pidAlive(pid)) return false;
  if (IS_WIN) { const r = tryRun('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']); return r.ok && /"(node|tailscaled)\.exe"/i.test(r.out); }
  // Linux 读 /proc（精简系统里可能没有 ps），macOS 用 ps；两样都没有就只能照旧当成是
  let cmd = null;
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {}
  if (cmd == null) { const r = tryRun('ps', ['-o', 'command=', '-p', String(pid)]); if (r.ok) cmd = r.out; else if (/ENOENT/.test(r.out)) return true; }
  return cmd != null && (cmd.includes(HOME) || /server\.mjs|supervise\.mjs|tailscaled/.test(cmd));
}
function plainStop(name) {
  let pid; try { pid = Number(fs.readFileSync(pidFile(name), 'utf8')); } catch { return false; }
  if (pid && pidIsOurs(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  fs.rmSync(pidFile(name), { force: true });
  return true;
}
function plainStart(name, args, env) {
  plainStop(name);
  fs.mkdirSync(path.dirname(pidFile(name)), { recursive: true });
  const fd = fs.openSync(logFile(name), 'a');
  const child = spawn(args[0], args.slice(1), { cwd: HOME, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env }, windowsHide: true });
  child.unref();
  fs.writeFileSync(pidFile(name), String(child.pid));
  return { ok: true };
}

// ---------- 对外 ----------
export async function installService(key, args, env = {}, manager = serviceManager()) {
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  const s = SERVICES[key];
  if (manager === 'launchd-boot') return bootInstall(key, s.launchd, args, env);
  if (manager === 'launchd') return launchdInstall(s.launchd, args, env);
  if (manager === 'systemd') return systemdInstall(s.systemd, s.desc, args, env, s.launchd);
  if (manager === 'startup') return startupInstall(s.launchd, args, env);
  return plainStart(s.launchd, args, env);
}

export function removeService(key, manager = serviceManager()) {
  const s = SERVICES[key];
  if (manager === 'launchd-boot') { fs.rmSync(stagePath(s.launchd), { force: true }); return false; } // 系统级的要 root 才能删：sudo mydash service login
  if (manager === 'launchd') return launchdRemove(s.launchd);
  if (manager === 'systemd') return systemdRemove(s.systemd);
  if (manager === 'startup') return startupRemove(s.launchd);
  return plainStop(s.launchd);
}

export function restartService(key, manager = serviceManager()) {
  const s = SERVICES[key];
  if (manager === 'launchd-boot') { if (key !== 'server') return false; fs.writeFileSync(path.join(HOME, 'app', '.restart'), String(Date.now())); return true; }
  if (manager === 'launchd') return tryRun('launchctl', ['kickstart', '-k', `gui/${uid()}/${s.launchd}`]).ok;
  if (manager === 'systemd') return tryRun('systemctl', ['--user', 'restart', s.systemd]).ok;
  if (manager === 'startup') { startupStop(s.launchd); spawn('wscript.exe', [vbsPath(s.launchd)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; }
  return false;
}

export function serviceInstalled(key, manager = serviceManager()) {
  const s = SERVICES[key];
  if (manager === 'launchd-boot') return fs.existsSync(daemonPath(s.launchd));
  if (manager === 'launchd') return fs.existsSync(plistPath(s.launchd));
  if (manager === 'systemd') return fs.existsSync(unitPath(s.systemd));
  if (manager === 'startup') return fs.existsSync(vbsPath(s.launchd));
  try { return pidAlive(Number(fs.readFileSync(pidFile(s.launchd), 'utf8'))); } catch { return false; }
}

// ---------- sudo mydash service boot | login ----------
// boot：把 state/boot/ 里放好的 plist 装进 /Library/LaunchDaemons（只认 mydash 自己的服务名，UserName 必须是执行 sudo 的本人），
//       卸掉同名的用户级 LaunchAgent，启动。login：反过来，删掉系统级的（之后以本人身份跑 setup install --service launchd 装回登录后启动）
// 以 root 运行，但不写 ~/.mydash 里的任何文件（免得变成 root 的）
export function bootServices(action) {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
  if (process.getuid() !== 0) return { ok: false, error: 'needs root', fix: 'sudo mydash service ' + action };
  const user = process.env.SUDO_USER || '';
  if (!user || user === 'root') return { ok: false, error: 'run it with sudo from your own account, not as root' };
  const home = tryRun('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory']).out.split(':').pop().trim();
  const uidOf = tryRun('/usr/bin/id', ['-u', user]).out.trim();
  const mdHome = path.resolve(process.env.MYDASH_HOME || path.join(home, '.mydash'));
  // 这一套的服务名：装在本人的 ~/.mydash 时不带后缀，别处带路径哈希（和 SERVICES 的算法一样，只是按 sudo 的那个人来算）
  const sfx = mdHome === path.join(home, '.mydash') ? '' : '-' + crypto.createHash('sha1').update(mdHome).digest('hex').slice(0, 6);
  const LABEL = new RegExp(`^mydash\\.(server|tailscaled)${sfx}$`);
  // 用系统的 plutil 解析（不能靠在文字里找：注释里也能写出一段 UserName）
  const parse = f => { const r = tryRun('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f]); try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } };
  const ALLOWED = new Set(['Label', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive', 'ProcessType', 'EnvironmentVariables', 'StandardOutPath', 'StandardErrorPath', 'UserName', 'GroupName']);
  const mine = f => { const j = parse(f); return j && j.UserName === user ? j : null; };
  const installed = () => (fs.existsSync(DAEMON_DIR) ? fs.readdirSync(DAEMON_DIR) : []).map(f => f.replace(/\.plist$/, '')).filter(l => LABEL.test(l));
  const done = [];
  const drop = label => { tryRun('launchctl', ['bootout', `system/${label}`]); fs.rmSync(daemonPath(label), { force: true }); done.push(`removed ${label}`); };
  if (action === 'login') {
    // 只删这个人的（别的账户也可能开着开机启动）
    for (const label of installed()) if (mine(daemonPath(label))) drop(label);
    return { ok: true, done, next: 'Then, as yourself: ./setup.sh install --service launchd' };
  }
  const dir = path.join(mdHome, 'state', 'boot');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.plist')) : [];
  if (!files.length) return { ok: false, error: 'nothing to install', fix: 'First, as yourself: ./setup.sh install --service launchd-boot' };
  const staged = new Set();
  for (const f of files) {
    const label = f.replace(/\.plist$/, ''); const src = path.join(dir, f);
    const st = fs.lstatSync(src);
    const j = st.isFile() ? parse(src) : null;
    const okPlist = j && LABEL.test(label) && j.Label === label && j.UserName === user && (j.GroupName == null || j.GroupName === 'staff')
      && Object.keys(j).every(k => ALLOWED.has(k)) && Array.isArray(j.ProgramArguments) && j.ProgramArguments.every(a => typeof a === 'string');
    if (!okPlist) { done.push(`skipped ${f}: not a mydash service for ${user}`); continue; }
    staged.add(label);
    const dst = daemonPath(label);
    if (fs.existsSync(dst) && !mine(dst)) { done.push(`skipped ${label}: already used by another account`); continue; }
    const xml = fs.readFileSync(src, 'utf8');
    // 卸掉登录后启动的那个（同一个服务不能跑两份）
    if (uidOf) tryRun('launchctl', ['bootout', `gui/${uidOf}/${label}`]);
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`), { force: true });
    tryRun('launchctl', ['bootout', `system/${label}`]);
    fs.writeFileSync(dst, xml, { mode: 0o644 }); fs.chownSync(dst, 0, 0); fs.chmodSync(dst, 0o644);
    const r = tryRun('launchctl', ['bootstrap', 'system', dst]);
    done.push(r.ok ? `${label}: starts at boot` : `${label}: ${r.out.trim()}`);
  }
  // 已经不要的（比如换掉了独立的 Tailscale 节点）：这一套、这个人的、没再放进 state/boot/ 的，删掉
  for (const label of installed()) if (!staged.has(label) && mine(daemonPath(label))) drop(label);
  return { ok: done.every(d => d.endsWith('starts at boot') || d.startsWith('removed ')), done };
}
