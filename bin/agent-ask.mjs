#!/usr/bin/env node
// 钩子用：Claude Code / Codex 弹出选择题、计划确认、权限确认（命令审批）之前，先把它交给 mydash，
// 等用户在网页上答完，再把答案按各自的格式交回去（见 lib/prompts.mjs）。
//   Claude Code：PreToolUse（AskUserQuestion、ExitPlanMode）和 PermissionRequest
//   Codex（命令行和 ChatGPT 桌面版里的 Codex 都走这里）：PreToolUse（request_user_input；桌面版用 request_user_input_async）和 PermissionRequest
//   没人看着的会话（claude -p、SDK）不接：那里的权限请求本来就该马上被拒，不能等一天
//   用法：node agent-ask.mjs claude | codex（钩子的超时要设得很长，用户可能过很久才答）
//   Codex 默认「软件里先问」：钩子不拦，题目马上在 Codex 里弹出；mydash 只记一份、没人答时推送提醒。
//   Codex 不让外面替已经弹出的题作答，所以这份只能看、不能答；后台起一个小进程（watch）盯着会话记录，答了就关掉它。
// 任何一步不顺（mydash 没开、总开关关了、用户点了「回 … 里答」、看不懂这次的输入）都什么也不输出、正常退出：那边照常问。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const agent = process.argv[2] === 'codex' ? 'codex' : 'claude';
const watching = process.argv[2] === 'watch';
if (!watching && agent === 'claude' && /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) process.exit(0);
const HOME = path.resolve(process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash'));
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch {}
if (cfg.prompts?.enabled === false) process.exit(0);
const BASE = `http://127.0.0.1:${process.env.MYDASH_PORT || cfg.port || 4870}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(b), signal: AbortSignal.timeout(5000) })
  .then(r => (r.ok ? r.json() : null)).catch(() => null);

// 会话记录里新写进来的部分：从 pos 读到末尾（每次最多 8 MB），前后接上一小段，免得要找的字样正好被切开
function reader(file, pos) {
  let carry = '';
  return () => {
    try {
      const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
      if (size < pos) pos = 0;
      const len = Math.min(size - pos, 8 * 1024 * 1024); const b = Buffer.alloc(Math.max(0, len));
      if (len > 0) fs.readSync(fd, b, 0, len, pos); fs.closeSync(fd); pos += Math.max(0, len);
      const s = carry + b.toString('utf8'); carry = s.slice(-300); return s;
    } catch { return ''; }
  };
}
const alive = pid => { if (!(pid > 1)) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// 终端（或 Codex 软件）里批准了一条要跑很久的命令：结果要等它跑完才写进会话记录，可批准的那一刻就会起一个子进程来跑它。
// 所以看 Claude Code / Codex 进程底下新起的子进程里有没有这条命令：
//   Claude Code：<shell> -c "source … && eval '<命令>' < /dev/null && pwd -P >| …"（单引号写成 '"'"'，ps 里换行显示成 \012）
//   Codex：<shell> -lc <命令>
// 比的时候去掉引号、反斜杠和空白；只认钩子开始之后才出现的进程，同一条命令早就在跑的不算。Windows 上不看（只靠会话记录）
const squash = s => String(s).replace(/\\0[0-7]{2}/g, ' ').replace(/[\s'"\\]/g, '');
function procList() {
  const out = [];
  if (process.platform === 'linux') {
    let ids = []; try { ids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch {}
    for (const d of ids) {
      try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); out.push({ pid: Number(d), ppid: Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]), cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ') }); } catch {}
    }
    return out;
  }
  if (process.platform === 'win32') return out;
  try { for (const l of execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 * 1024 }).split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }); } } catch {}
  return out;
}
const runsCommand = (cmd, want) => {
  const i = cmd.lastIndexOf(' eval ');
  if (i >= 0) { const j = cmd.indexOf(' < /dev/null', i); return squash(cmd.slice(i + 6, j > 0 ? j : undefined)) === want; }
  return squash(cmd).endsWith(want);
};
// owners：这些进程底下起的才算（Claude Code 本身；钩子可能隔着一层 shell，所以连父进程的父进程也算上）
function commandStarted(command, owners) {
  if (process.platform === 'win32' || typeof command !== 'string') return null;
  const want = squash(command); if (!want) return null;
  const list0 = procList(); if (!list0.length) return null;
  if (!owners) { const pp = list0.find(p => p.pid === process.ppid)?.ppid; owners = new Set([process.ppid, ...(pp > 1 ? [pp] : [])]); }
  const before = new Set(list0.map(p => p.pid));
  return () => procList().some(p => owners.has(p.ppid) && !before.has(p.pid) && runsCommand(p.cmd, want));
}

// watch <id> <会话记录> <call_id> <起始位置> <工具名> <Codex 的进程号>：Codex 软件里那道题答了，就把 mydash 上那份标成「在 Codex 里答了」。
//   request_user_input：记录里出现这道题的输出，或者这一轮结束、被打断了
//   request_user_input_async（桌面版）：工具马上就返回，答案是之后用户发来的一条消息（send_user_message_question_reply，带着 call_id）；
//     用户没答题、直接发了别的消息，也算这道题过去了
//   Codex 进程没了（软件崩了、退出了），题也就没了。同时每 25 秒来问一次，免得被当成没人等了收掉。最多等一天
if (watching) {
  const [, , , id, file, callId, from, toolName, ownerPid] = process.argv; const t0 = Date.now();
  const isAsync = toolName === 'request_user_input_async';
  const next = reader(file, Number(from) || 0); let seen = '';
  const started = process.env.MYDASH_WATCH_CMD ? commandStarted(process.env.MYDASH_WATCH_CMD, new Set([Number(ownerPid)])) : null;
  const done = () => {
    if (started?.()) return true;
    seen = (seen + next()).slice(-2 * 1024 * 1024);
    if (isAsync) return (callId && seen.includes(callId) && seen.includes('send_user_message_question_reply')) || seen.includes('"type":"user_message"');
    return (callId ? seen.includes(`"call_id":"${callId}"`) : /"type":"(function_call_output|custom_tool_call_output)"/.test(seen)) || /"type":"(task_complete|turn_aborted)"/.test(seen);
  };
  setInterval(async () => {
    if (done() || Date.now() - t0 > 86400_000) { await post(`/api/prompts/${id}/cancel`, { reason: 'terminal' }); process.exit(0); }
    if (!alive(Number(ownerPid))) { await post(`/api/prompts/${id}/cancel`, {}); process.exit(0); }
  }, 2000);
  for (;;) {
    let r = null; try { const res = await fetch(`${BASE}/api/prompts/${id}/wait`, { signal: AbortSignal.timeout(40_000) }); r = res.ok ? await res.json() : null; } catch {}
    if (r && r.status !== 'pending') process.exit(0);
    if (!r) await sleep(3000);
  }
}

let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch { process.exit(0); }
const event = input.hook_event_name; const tool = String(input.tool_name || ''); const ti = input.tool_input || {};
// Claude Code 的选择题、计划确认有两种接法：
//   parallel（默认）：终端照常马上弹出，mydash 上同时出一份，哪边先答算哪边（走 PermissionRequest，和终端的对话框同时开着）
//   hold：PreToolUse 先拦下，终端什么都不显示，等 mydash 答了或点「交回」才在终端问（config.prompts.mode = 'hold'）
const parallel = agent === 'claude' && (process.env.MYDASH_PROMPT_MODE || cfg.prompts?.mode || 'parallel') !== 'hold';
// Codex：app（默认，软件里先问、mydash 只提醒）· hold（先在 mydash 答，Codex 等着；config.prompts.codexMode = 'hold'）
const codexApp = agent === 'codex' && (process.env.MYDASH_PROMPT_MODE || cfg.prompts?.codexMode || 'app') !== 'hold';

let kind, payload;
if (event === 'PreToolUse' && (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') && parallel) process.exit(0);
if (event === 'PreToolUse' && tool === 'AskUserQuestion') { kind = 'question'; payload = { questions: ti.questions }; }
// Codex 的选择题：每道题有 id、header、question、options（label、description），都是单选，它自己会加「以上都不是」。
// 桌面版的 request_user_input_async：每道题是 { title, options: [文字] }，没有选项的是让用户自己写
else if (event === 'PreToolUse' && tool === 'request_user_input' && agent === 'codex') { kind = 'question'; payload = { questions: ti.questions }; }
else if (event === 'PreToolUse' && tool === 'request_user_input_async' && agent === 'codex') {
  kind = 'question';
  payload = { questions: (Array.isArray(ti.questions) ? ti.questions : []).map((q, i) => ({ id: q.id || `q${i + 1}`, header: q.header || '', question: q.question || q.title || '', options: (Array.isArray(q.options) ? q.options : []).map(o => (typeof o === 'string' ? { label: o, description: '' } : o)) })) };
}
else if (event === 'PreToolUse' && tool === 'ExitPlanMode') { kind = 'plan'; payload = { plan: ti.plan }; }
// 选择题、计划确认的「权限」那一步：hold 时它们已经在 PreToolUse 交给过 mydash（或者用户点了交回），不管；parallel 时就在这一步接
else if (event === 'PermissionRequest' && tool === 'AskUserQuestion') { if (!parallel) process.exit(0); kind = 'question'; payload = { questions: ti.questions }; }
else if (event === 'PermissionRequest' && tool === 'ExitPlanMode') { if (!parallel) process.exit(0); kind = 'plan'; payload = { plan: ti.plan }; }
else if (event === 'PermissionRequest') {
  kind = 'permission';
  payload = { toolName: tool, description: String(ti.description || ''), input: typeof ti.command === 'string' ? ti.command : JSON.stringify(ti, null, 2), suggestions: agent === 'claude' ? input.permission_suggestions || [] : [] };
} else process.exit(0);

const print = o => process.stdout.write(JSON.stringify(o));

const transcript0 = typeof input.transcript_path === 'string' ? input.transcript_path : '';
if (codexApp && !transcript0) process.exit(0); // 没有会话记录就没法知道答没答，干脆只在软件里问
const created = await post('/api/prompts', { tool: agent, kind, session: input.session_id || '', cwd: input.cwd || '', payload, both: agent === 'claude' && event === 'PermissionRequest', appOnly: codexApp });
if (!created?.id) process.exit(0);
if (codexApp) {
  let size = 0; try { size = fs.statSync(transcript0).size; } catch {}
  const env = { ...process.env, ...(kind === 'permission' && typeof ti.command === 'string' ? { MYDASH_WATCH_CMD: ti.command } : {}) };
  spawn(process.execPath, [process.argv[1], 'watch', created.id, transcript0, String(input.tool_use_id || ''), String(size), tool, String(process.ppid)], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
  process.exit(0); // 不输出：Codex 照常在软件里弹出
}

// 终端那边先答了：权限确认的对话框和这个钩子是同时开着的，用户在终端答完，Claude Code 不会结束钩子。
// 所以盯着会话记录：开始时找到这次工具调用的 id，之后记录里出现它的结果，就是终端那边已经答了。
//   子 agent 里的请求看子 agent 自己的记录（subagents/agent-<id>.jsonl）；
//   同名的调用按输入对上（同一条消息里并行的两个 Bash 靠命令区分），已经有结果的不算
function tail(file, bytes) {
  try { const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const len = Math.min(size, bytes); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; }
}
const canon = x => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v));
function findToolUse(file) {
  const lines = tail(file, 4 * 1024 * 1024).split('\n');
  const answered = new Set(); for (const l of lines) for (const m of l.matchAll(/"tool_use_id":"([^"]+)"/g)) answered.add(m[1]);
  const open = [];
  for (const l of lines) {
    if (!l.includes('"tool_use"')) continue;
    try { for (const c of JSON.parse(l).message?.content || []) if (c.type === 'tool_use' && c.name === tool && !answered.has(c.id)) open.push(c); } catch {}
  }
  const want = canon(ti);
  return (open.filter(c => canon(c.input) === want).pop() || (open.length === 1 ? open[0] : null))?.id || null;
}
const main = typeof input.transcript_path === 'string' ? input.transcript_path : '';
const sub = input.agent_transcript_path || (input.agent_id && main ? path.join(path.dirname(main), String(input.session_id || ''), 'subagents', `agent-${input.agent_id}.jsonl`) : '');
const transcript = sub && fs.existsSync(sub) ? sub : input.agent_id ? '' : main;
const toolUseId = transcript ? findToolUse(transcript) : null;
if (toolUseId) {
  let size = 0; try { size = fs.statSync(transcript).size; } catch {}
  const next = reader(transcript, size); const needle = `"tool_use_id":"${toolUseId}"`;
  setInterval(async () => {
    if (!next().includes(needle)) return;
    await post(`/api/prompts/${created.id}/cancel`, { reason: 'terminal' }); process.exit(0);
  }, 2000).unref();
}
// 命令已经开始跑了（终端那边批准了）：不用等它跑完、结果写进记录
const started = kind === 'permission' ? commandStarted(ti.command) : null;
if (started) setInterval(async () => {
  if (!started()) return;
  await post(`/api/prompts/${created.id}/cancel`, { reason: 'terminal' }); process.exit(0);
}, 2000).unref();
// Claude Code 退出了却没结束这个钩子（父进程没了）：作废这道题，别一直挂着
const parent = process.ppid;
setInterval(async () => { if (process.platform !== 'win32' && (process.ppid !== parent || !alive(parent))) { await post(`/api/prompts/${created.id}/cancel`, {}); process.exit(0); } }, 5000).unref();

// 终端那边取消了（Esc、Ctrl+C）或钩子超时：告诉 mydash 这道题作废了
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, async () => { if (stopping) return; stopping = true; await post(`/api/prompts/${created.id}/cancel`, {}); process.exit(0); });

let answer = null;
for (let fails = 0; ;) {
  let r = null;
  try { const res = await fetch(`${BASE}/api/prompts/${created.id}/wait`, { signal: AbortSignal.timeout(40_000) }); r = res.ok ? await res.json() : null; } catch {}
  if (!r) { if (++fails > 40) process.exit(0); await sleep(3000); continue; }  // mydash 在重启：等一会儿；一直连不上就交回终端
  fails = 0;
  if (r.status === 'pending') continue;
  if (r.status !== 'answered') process.exit(0);  // 回终端答 / 取消了
  answer = r.answer; break;
}

if (kind === 'question' && agent === 'codex') {
  // Codex 的钩子没法替 request_user_input 填答案，只能拦下这次调用、把答案写进理由里：模型看得到理由，界面上显示「Blocked by hook」和答案
  const lines = (payload.questions || []).map(q => {
    const v = answer.answers?.[q.question];
    return `- ${q.question}${q.id ? ` (id: ${q.id})` : ''}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}`;
  });
  print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The user already answered these questions in mydash, so they were not shown here. Their answers:\n${lines.join('\n')}\nTreat these as the user's answers to request_user_input and continue. Do not ask them again.` } });
} else if (kind === 'question') {
  const answers = Object.fromEntries(Object.entries(answer.answers || {}).map(([q, v]) => [q, Array.isArray(v) ? v.join(', ') : String(v)]));
  print(event === 'PermissionRequest'
    ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ti, answers } } } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Answered in mydash', updatedInput: { ...ti, answers } } });
} else if (kind === 'plan' && event === 'PermissionRequest') {
  print({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer.approve ? { behavior: 'allow', updatedInput: ti } : { behavior: 'deny', message: `The user reviewed this plan in mydash and wants changes before you go ahead: ${answer.feedback || '(no details given; ask what to change)'}` } } });
} else if (kind === 'plan') {
  print(answer.approve
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Plan approved in mydash', updatedInput: ti } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The user reviewed this plan in mydash and wants changes before you go ahead: ${answer.feedback || '(no details given; ask what to change)'}` } });
} else {
  const d = answer.decision;
  const decision = d === 'deny' ? { behavior: 'deny', message: answer.message || 'The user denied this in mydash.' }
    : { behavior: 'allow', ...(d === 'always' && agent === 'claude' && payload.suggestions.length ? { updatedPermissions: payload.suggestions } : {}) };
  print({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}
process.exit(0);
