// 认出当前命令在哪个编程 agent 的会话里运行，以及那个会话的启动文件夹。
// 项目 = 会话启动时所在的文件夹：中途 cd 到子目录、进 worktree 都不会把产物分到别的项目。
//   Claude Code：CLAUDE_CODE_SESSION_ID → ~/.claude/projects/<编码后的目录>/<会话ID>.jsonl，第一条带 cwd 的记录
//   Codex：      CODEX_THREAD_ID → ~/.codex/sessions/YYYY/MM/DD/rollout-*-<ID>.jsonl，第一行 session_meta.payload.cwd
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { t } from './i18n.mjs';

const CLAUDE_PROJECTS = () => process.env.MYDASH_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const CODEX_HOME = () => process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// 认识的 agent：网页上按这里的名字和颜色区分（颜色在 app.css 的 --ag-<id>）。
// 别的工具可以设 MYDASH_AGENT=<名字>（如 cursor、gemini），显示成中性颜色的标签。
export const AGENTS = {
  claude: { name: 'Claude Code', short: 'Claude' },
  codex: { name: 'Codex', short: 'Codex' },
};
export const AGENT_NAME = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.name]));
export function agentInfo(id) {
  if (!id) return null;
  return AGENTS[id] ? { id, ...AGENTS[id], known: true } : { id, name: id, short: id, known: false };
}
const cleanAgent = s => String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 32);

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}

function claudeLaunchDir(sid) {
  if (!sid || !/^[\w-]+$/.test(sid)) return null;
  let dirs = []; try { dirs = fs.readdirSync(CLAUDE_PROJECTS()); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(CLAUDE_PROJECTS(), d, `${sid}.jsonl`);
    if (!fs.existsSync(f)) continue;
    try {
      for (const line of readHead(f).split('\n')) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o.cwd !== 'string' || !path.isAbsolute(o.cwd)) continue;
        // 校验：记录里的目录应当就是会话记录所在的项目目录（或它下面的子目录）
        for (let p = o.cwd; ; p = path.dirname(p)) {
          if (p.replace(/[^A-Za-z0-9]/g, '-') === d) return p;
          if (path.dirname(p) === p) break;
        }
        return o.cwd;
      }
    } catch {}
    // 记录里没读到 cwd：用目录名反推（编码规则是非字母数字都换成 -）
    for (let p = path.resolve(process.cwd()); ; p = path.dirname(p)) {
      if (p.replace(/[^A-Za-z0-9]/g, '-') === d) return p;
      if (path.dirname(p) === p) break;
    }
    return null;
  }
  return null;
}

function codexRollout(tid) {
  const suffix = `-${tid}.jsonl`;
  const root = path.join(CODEX_HOME(), 'sessions');
  const desc = dir => { try { return fs.readdirSync(dir).filter(x => /^\d+$/.test(x)).sort().reverse(); } catch { return []; } };
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    const day = path.join(root, y, m, d);
    let hit; try { hit = fs.readdirSync(day).find(f => f.endsWith(suffix)); } catch {}
    if (hit) return path.join(day, hit);
  }
  try { const arch = path.join(CODEX_HOME(), 'archived_sessions'); const hit = fs.readdirSync(arch).find(f => f.endsWith(suffix)); if (hit) return path.join(arch, hit); } catch {}
  return null;
}

function codexLaunchDir(tid) {
  if (!tid || !/^[\w-]+$/.test(tid)) return null;
  const f = codexRollout(tid); if (!f) return null;
  try {
    for (const line of readHead(f, 512 * 1024).split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const cwd = o?.type === 'session_meta' ? o.payload?.cwd : null;
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd;
    }
  } catch {}
  return null;
}

// 两家的环境变量都在时（比如从 Claude Code 里启动了 Codex），顺着父进程往上找最近的那个 agent
function nearestAgentProcess() {
  if (process.platform === 'win32') return null; // Windows 没有 ps；这种嵌套情况很少见，按 Codex 处理
  let pid = process.ppid;
  for (let i = 0; i < 24 && pid > 1; i++) {
    let out; try { out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); } catch { return null; }
    const m = out.match(/^(\d+)\s+(.+)$/); if (!m) return null;
    const comm = path.basename(m[2]).toLowerCase();
    if (comm.startsWith('codex')) return 'codex';
    if (comm.startsWith('claude')) return 'claude';
    pid = Number(m[1]);
  }
  return null;
}

export function currentAgent() {
  if (process.env.MYDASH_AGENT) return cleanAgent(process.env.MYDASH_AGENT) || null;
  const claude = Boolean(process.env.CLAUDE_CODE_SESSION_ID), codex = Boolean(process.env.CODEX_THREAD_ID);
  if (claude && codex) return nearestAgentProcess() || 'codex';
  return codex ? 'codex' : claude ? 'claude' : null;
}

// { agent, dir }：dir 是会话的启动文件夹（找不到记录时为 null）
// 当前会话的 ID（Claude Code 的 session、Codex 的 thread）：审批单、待办记下是哪个会话发的，钩子据此提醒它
export function currentSessionId() {
  const a = currentAgent();
  const id = a === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : a === 'codex' ? process.env.CODEX_THREAD_ID : '';
  return /^[\w-]{6,100}$/.test(id || '') ? id : null;
}

export function detectSession() {
  const agent = currentAgent();
  if (!agent) return null;
  const dir = agent === 'codex' ? codexLaunchDir(process.env.CODEX_THREAD_ID) : agent === 'claude' ? claudeLaunchDir(process.env.CLAUDE_CODE_SESSION_ID) : null;
  return { agent, dir };
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// worktree 归回主项目文件夹
export function mainFolder(dir) {
  for (const marker of [`${path.sep}.claude${path.sep}worktrees${path.sep}`]) {
    const i = dir.indexOf(marker);
    if (i > 0) return dir.slice(0, i);
  }
  try {
    const common = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const own = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
    if (common !== own && path.basename(common) === '.git') return path.dirname(common);
  } catch {}
  return dir;
}

function folderProject(dir) {
  if (path.resolve(dir) === os.homedir()) return 'home';
  return path.basename(path.resolve(dir)) || 'misc';
}
const tilde = p => path.resolve(p).replace(os.homedir(), '~');

// 返回 { name, source, agent, session }：session 为 true 表示按会话启动文件夹认的（--project 会被纠正）
// 钩子报上来的会话（Claude Code 的 session、Codex 的 thread）属于哪个项目：会话启动时所在的文件夹；找不到会话记录就按 cwd
export function projectForSession(agent, sessionId, cwd) {
  let dir = null;
  try { dir = agent === 'codex' ? codexLaunchDir(sessionId) : agent === 'claude' ? claudeLaunchDir(sessionId) : null; } catch {}
  dir = dir || cwd || process.cwd();
  try { return folderProject(mainFolder(dir)); } catch { return folderProject(dir); }
}

export function detectProject(cwd) {
  const s = detectSession();
  if (process.env.MYDASH_PROJECT) return { name: process.env.MYDASH_PROJECT, source: t('environment variable MYDASH_PROJECT'), agent: s?.agent || null, session: false };
  if (s?.dir) {
    const root = mainFolder(s.dir);
    return { name: folderProject(root), source: t('the folder this {agent} session started in: {dir}', { agent: agentInfo(s.agent).name, dir: tilde(root) }), agent: s.agent, session: true };
  }
  try {
    const common = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const root = path.basename(common) === '.git' ? path.dirname(common) : common;
    if (root && root !== os.homedir() && root !== '/') return { name: path.basename(root), source: t('git repository {dir}', { dir: tilde(root) }), agent: s?.agent || null, session: false };
  } catch {}
  return { name: folderProject(cwd), source: t('current directory {dir}', { dir: tilde(cwd) }), agent: s?.agent || null, session: false };
}

// ---------- 给旧条目补记来源 agent ----------
// 早期的条目没记 agent。到两家的会话记录里找当时那条 `mydash publish … --slug X` 命令（工具调用），
// 按 slug 和时间（命令在发布前 15 分钟内）对上，补进 meta。只读会话记录，不改它们。
function* jsonlFiles(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}
const PUBLISH_RE = /mydash (?:publish|pub)\b[^\n]{0,600}?(?:--slug|\s-s)(?:=|\s+)\\?["']?([\w.-]+)/g;
export function publishCalls() {
  const calls = [];
  const roots = [[CLAUDE_PROJECTS(), 'claude'], [path.join(CODEX_HOME(), 'sessions'), 'codex'], [path.join(CODEX_HOME(), 'archived_sessions'), 'codex']];
  for (const [root, agent] of roots) {
    for (const f of jsonlFiles(root)) {
      let buf; try { buf = fs.readFileSync(f); } catch { continue; }
      if (!buf.includes('mydash publish') && !buf.includes('mydash pub ')) continue;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('mydash pub')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const isCall = agent === 'claude' ? o.type === 'assistant' : o.type === 'response_item' && /call/.test(o.payload?.type || '');
        if (!isCall || !o.timestamp) continue;
        const ts = Date.parse(o.timestamp); if (!ts) continue;
        for (const m of line.matchAll(PUBLISH_RE)) calls.push({ agent, ts, slug: m[1] });
      }
    }
  }
  return calls;
}
export function matchAgent(calls, slug, timeIso) {
  const t0 = Date.parse(timeIso);
  let best = null;
  for (const c of calls) {
    if (c.slug !== slug || c.ts > t0 + 60_000 || c.ts < t0 - 15 * 60_000) continue;
    if (!best || Math.abs(t0 - c.ts) < Math.abs(t0 - best.ts)) best = c;
  }
  return best?.agent || null;
}
