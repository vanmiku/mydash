// 待办的自动检测：agent 在某一项末尾写 <!-- check: 命令 -->，命令成功（退出码 0）就算做完了，mydash 替用户勾上。
//   · 只跑这台机器上发布的；别的机器用令牌传来的不跑（不能让远程借这个在本机执行命令）
//   · 只跑明确的待办里的（--type todo 发布的，或 ```todo 块里的；versionTodos 已经筛过）
//   · 15 秒超时，连同它起的子进程一起杀掉；同一项同时只跑一份
//   · 用户手动取消过勾的，不再自动勾回去；自动勾上的也不会自动取消
//   · 服务每两分钟查一次，用户打开那份待办时也会马上查一次（server.mjs）；mydash todos check 手动查
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { latest, readConfig } from './store.mjs';
import { readResponses, setTodo } from './responses.mjs';
import { versionTodos } from './todo.mjs';
import { syncOpen } from './waiting.mjs';

// 服务在 launchd / systemd 下跑时 PATH 很短，补上常见的位置和 mydash 自己的命令目录
function checkEnv() {
  const extra = [readConfig().binDir, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean);
  return { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) };
}
// 自己一个进程组（Windows 上用 taskkill /T），超时时整组杀掉：管道和后台里的子进程不会留下来
function killTree(child) {
  if (process.platform === 'win32') { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
const passes = cmd => new Promise(resolve => {
  let child;
  try { child = spawn(cmd, { shell: true, cwd: os.homedir(), env: checkEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' }); } catch { return resolve(false); }
  const timer = setTimeout(() => killTree(child), 15_000);
  child.on('error', () => { clearTimeout(timer); resolve(false); });
  child.on('exit', code => { clearTimeout(timer); resolve(code === 0); });
});
const running = new Set();

// 还该不该检测：没做完、用户也没手动取消过
function due(x, s) {
  if (s?.done || (!s && x.done)) return false;
  return !(s && s.from !== 'auto');
}

// items：条目列表；only：只查这一个（"项目/slug"）。返回勾上了东西的条目 ID
export async function runChecks(items, { only = null, log = () => {} } = {}) {
  const changed = [];
  for (const m of items) {
    const id = `${m.project}/${m.slug}`;
    if (only && id !== only) continue;
    const l = latest(m); if (l.remote) continue;
    const list = versionTodos(m.project, m.slug, l).filter(x => x.check);
    if (!list.length) continue;
    const st = readResponses(m.project, m.slug).todos; let any = false;
    for (const x of list) {
      const rk = `${id}:${x.key}`;
      if (!due(x, st[x.key]) || running.has(rk)) continue;
      running.add(rk); let ok; try { ok = await passes(x.check); } finally { running.delete(rk); }
      if (!ok) continue;
      await setTodo(m.project, m.slug, x.key, { done: true, text: x.text, v: l.v, from: 'auto' });
      any = true; log(`to-do done (auto-check): ${id} · ${x.text.slice(0, 60)}`);
    }
    if (any) { await syncOpen(m.project, m.slug); changed.push(id); }
  }
  return changed;
}
