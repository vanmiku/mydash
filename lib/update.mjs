// 更新：只跟正式版本（源码仓库里的 git 标签 vX.Y.Z），main 上平时的提交不算。
// 服务每天问一次源码仓库的远端有没有更新的标签；默认只提醒（网页上点一下或运行 mydash update 才装），
// 设置里可以改成夜里自动装，也可以关掉。更新进程要在服务重启后活下来，所以和服务脱开启动（见 startUpdate）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, readConfig } from './store.mjs';
import { which } from './sys.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(HOME, 'state', 'update.json');
export const UPDATE_LOG = path.join(HOME, 'logs', 'update.log');
export const CHECK_EVERY = 20 * 3600_000;

export function readUpdate() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
export function writeUpdate(fn) {
  const next = fn(readUpdate());
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, STATE);
  return next;
}

// 版本号：只认 vX.Y.Z（不带预发布后缀，那种不推给用户）
export function parseVer(s) { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s || '').trim()); return m ? m.slice(1).map(Number) : null; }
export function cmpVer(a, b) {
  const x = parseVer(a) || [0, 0, 0], y = parseVer(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
export function latestTag(tags) { return tags.map(s => String(s).trim()).filter(s => /^v\d+\.\d+\.\d+$/.test(s)).sort(cmpVer).pop() || null; }
// 正在跑的这份代码的版本（服务和命令行都从 ~/.mydash/app 运行，就是装着的版本）
export function installedVersion() { try { return JSON.parse(fs.readFileSync(path.join(CODE, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } }

// 服务（launchd / systemd）里的 PATH 很短，找不到 Homebrew 的 git 和 npm：加上安装时记下的 PATH 和 node 所在的目录
export function toolEnv(cfg = readConfig()) {
  const parts = [path.dirname(process.execPath), cfg.toolPath, process.env.PATH].filter(Boolean).join(path.delimiter).split(path.delimiter);
  return { ...process.env, PATH: [...new Set(parts.filter(Boolean))].join(path.delimiter), GIT_TERMINAL_PROMPT: '0', MYDASH_HOME: HOME };
}

export function releaseUrl(remote, tag) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(String(remote || ''));
  return m && tag ? `https://github.com/${m[1]}/${m[2]}/releases/tag/${tag}` : null;
}

function remoteTags(remote, env) {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', '--tags', '--refs', remote], { env, cwd: HOME, timeout: 30_000, windowsHide: true }, (err, out, errOut) => {
      if (err) return reject(new Error(String(errOut || err.message).trim().split('\n').pop()));
      resolve(String(out).split('\n').map(l => l.split('\t')[1] || '').filter(r => r.startsWith('refs/tags/')).map(r => r.slice(10)));
    });
  });
}

// 问远端有没有新版本；没到时间（20 小时内查过）就用上次的结果
export async function checkForUpdate({ force = false } = {}) {
  const cfg = readConfig(); const s = readUpdate();
  if (!cfg.sourceRemote) return status();
  if (!force && s.checkedAt && Date.now() - Date.parse(s.checkedAt) < CHECK_EVERY) return status();
  try {
    const tag = latestTag(await remoteTags(cfg.sourceRemote, toolEnv(cfg)));
    writeUpdate(x => ({ ...x, checkedAt: new Date().toISOString(), error: null, latest: tag ? { version: tag.slice(1), tag, url: releaseUrl(cfg.sourceRemote, tag) } : null }));
  } catch (e) {
    writeUpdate(x => ({ ...x, checkedAt: new Date().toISOString(), error: e.message.slice(0, 300) }));
  }
  return status();
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// 更新进程还在不在：它自己记了 pid；刚点完、它还没起来时只有时间（两分钟没起来就当失败了）
function runningNow(r) {
  if (!r) return null;
  if (r.pid) return pidAlive(r.pid) ? r : null;
  return Date.now() - Date.parse(r.startedAt || 0) < 120_000 ? r : null;
}

export function status() {
  const cfg = readConfig(); const s = readUpdate(); const current = installedVersion();
  const latest = s.latest && parseVer(s.latest.version) ? s.latest : null;
  return {
    current, latest, available: Boolean(latest && cmpVer(latest.version, current) > 0),
    mode: ['off', 'auto'].includes(cfg.update?.mode) ? cfg.update.mode : 'notify',
    canCheck: Boolean(cfg.sourceRemote), canUpdate: Boolean(cfg.source && cfg.sourceRemote && !cfg.client),
    checkedAt: s.checkedAt || null, error: s.error || null,
    running: runningNow(s.running), last: s.last || null,
  };
}

// 从网页（或夜里自动）开始更新：更新会重启服务，所以更新进程要和服务脱开，服务被停掉时不能连它一起杀掉。
// systemd 会杀掉整个 cgroup，要用 systemd-run 另起一个；其他情况经一个马上退出的中间进程启动
// （setsid 脱离进程组；Windows 上 taskkill /T 按父进程找，父进程不在了就找不到它）
export function startUpdate({ auto = false } = {}) {
  const st = status();
  if (st.running) return { ok: false, error: 'running' };
  if (!st.canUpdate) return { ok: false, error: 'cannot' };
  const cfg = readConfig(); const env = toolEnv(cfg);
  const args = [path.join(CODE, 'bin', 'mydash.mjs'), 'update', '--json', ...(auto ? ['--auto'] : [])];
  fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
  fs.appendFileSync(UPDATE_LOG, `${new Date().toISOString()} starting update${auto ? ' (automatic)' : ''}\n`);
  writeUpdate(x => ({ ...x, running: { pid: null, startedAt: new Date().toISOString(), auto } }));
  try {
    if (cfg.service === 'systemd' && which('systemd-run')) {
      const r = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=mydash-update-${Date.now()}`, `--setenv=PATH=${env.PATH}`, `--setenv=MYDASH_HOME=${HOME}`,
        '-p', `StandardOutput=append:${UPDATE_LOG}`, '-p', `StandardError=append:${UPDATE_LOG}`, process.execPath, ...args], { stdio: 'ignore', env, detached: true });
      r.unref();
    } else {
      const launcher = 'const{spawn}=require("child_process"),fs=require("fs");const[log,...a]=process.argv.slice(1);const fd=fs.openSync(log,"a");spawn(process.execPath,a,{detached:true,stdio:["ignore",fd,fd],windowsHide:true}).unref();';
      spawn(process.execPath, ['-e', launcher, UPDATE_LOG, ...args], { detached: true, stdio: 'ignore', env, cwd: HOME, windowsHide: true }).unref();
    }
  } catch (e) {
    writeUpdate(x => ({ ...x, running: null, last: { ok: false, at: new Date().toISOString(), error: e.message, seen: false, auto } }));
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// 源码目录怎么挪到新版本：在分支上就快进合并（还留在分支上），已经是分离的就直接切过去。
// 目录里有不在这个版本里的提交（比如自己在改代码）时不动，免得把它们丢掉
export function planMove(git, tag) {
  const before = git('rev-parse', 'HEAD'); const target = git('rev-parse', `${tag}^{commit}`);
  if (!before.ok || !target.ok) return { ok: false, error: (before.ok ? target : before).out };
  if (!git('merge-base', '--is-ancestor', 'HEAD', target.out.trim()).ok) return { ok: false, error: 'diverged' };
  const onBranch = git('symbolic-ref', '-q', 'HEAD').ok;
  const b = before.out.trim(), to = target.out.trim();
  return {
    ok: true, before: b, target: to, onBranch,
    forward: () => (onBranch ? git('merge', '--ff-only', '--quiet', to) : git('checkout', '--quiet', '--detach', to)),
    back: () => (onBranch ? git('reset', '--quiet', '--keep', b) : git('checkout', '--quiet', '--detach', b)),
  };
}
