#!/usr/bin/env node
// Claude Code / Codex 钩子用：记下 agent 现在忙不忙。UserPromptSubmit（用户发了消息，或后台任务把 agent 叫醒）记 busy，
// Stop（答完一轮）记 idle，SessionEnd（会话关了）记 ended。用法：agent-state.mjs busy|idle|ended [claude|codex]
// Stop 时如果回复最后是在用文字问用户（要不要…？选哪个？），拦一次，让 agent 改用选择题再问：选择题会经过钩子到 mydash
// （bin/agent-ask.mjs），文字里的问题哪个钩子都接不到。每个会话第一次发消息时提醒一句这条规则（老会话没读到过新规则）。
// mydash approvals wait 拿到审批答复后，等 agent 闲下来才退出，免得 agent 做到一半时把答复塞进去。
// 用户发消息时（busy），如果这个会话发的审批单、待办还开着、或者有人在上面提问（state/open-items.json，见 lib/waiting.mjs），
// 就输出几行提醒：UserPromptSubmit 钩子的输出会进 agent 的上下文，agent 就不会忘了关单、勾掉、回答。
// 发单的会话已经结束时，等 agent 处理的（答了的审批、提问）提醒给同一个项目（当前目录路径里有这个项目名）里的新会话接手。
// StopFailure（这一轮因为 API 出错、额度用完而结束）也记 idle。没人看着的会话（claude -p、SDK）什么都不做：不提醒、不拦，免得改了批量任务的输出。
// 故意写得很小、不引入别的模块（每次发消息都会跑一次）；没有要提醒的就什么都不输出；永远成功退出，出了错也不能挡住用户。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const event = ['idle', 'ended'].includes(process.argv[2]) ? process.argv[2] : 'busy';
let state = event;
const agent = process.argv[3] === 'codex' ? 'codex' : 'claude';
if (agent === 'claude' && /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) process.exit(0);
let input = {};
try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
const id = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '');
const HOME = path.resolve(process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash'));
const AGENTS = path.join(HOME, 'state', 'agents');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch {}
const lang = process.env.MYDASH_LANG ? (process.env.MYDASH_LANG === 'zh' ? 'zh' : 'en') : cfg.lang === 'zh' ? 'zh' : 'en';
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const valid = /^[\w-]{6,100}$/.test(id);
const file = path.join(AGENTS, `${id}.json`);
const prev = valid ? readJson(file) || {} : {};

// 回复最后在用文字问用户吗：去掉代码和网址，看最后几百个字里有没有问号
function asksInText(msg) {
  const s = String(msg || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();
  return /[?？]/.test(s.slice(-500));
}
// 这个会话有一张审批单在等用户答：回复里的问题多半就是在说它，不拦
const waitingForm = () => Object.values(readJson(path.join(HOME, 'state', 'open-items.json')) || {}).some(x => x.session === id && x.kind === 'approval' && x.state === 'pending');
const REASON = {
  claude: 'Your reply ends by asking the user something in plain text, which does not reach them in mydash. If it is a choice or decision for them, ask it again with the AskUserQuestion tool (2–4 options; they can also write their own answer) and do not repeat the rest of your reply. If it needs no decision from them (a rhetorical question, something only they can go and do, or a question you already asked with a tool and got the answer to), end your turn without replying to this note.',
  codex: 'Your reply ends by asking the user something in plain text, which does not reach them in mydash. If it is a choice or decision for them, ask it again: with the request_user_input tool if it is available, otherwise run `mydash ask "<question>" "<option 1>" "<option 2>"` and wait for the answer. Do not repeat the rest of your reply. If it needs no decision from them (a rhetorical question, something only they can go and do, or a question you already asked with a tool and got the answer to), end your turn without replying to this note.',
};
let block = null;
if (state === 'idle' && (input.hook_event_name || 'Stop') === 'Stop' && !input.stop_hook_active && cfg.prompts?.enabled !== false && cfg.prompts?.chat !== false
  && asksInText(input.last_assistant_message) && !waitingForm()) {
  block = REASON[agent]; state = 'busy'; // 还要接着问，不算闲下来
}

if (valid) {
  try {
    fs.mkdirSync(AGENTS, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // transcript：会话记录的位置。按 Esc 打断时不触发 Stop，状态会停在 busy；等答复的一方看记录多久没动了，判断是不是真的还在忙
    const tp = typeof input.transcript_path === 'string' ? input.transcript_path : prev.transcript;
    fs.writeFileSync(tmp, JSON.stringify({ state, at: new Date().toISOString(), ...(prev.told || event === 'busy' ? { told: true } : {}), ...(tp ? { transcript: tp } : {}) })); fs.renameSync(tmp, file);
    // 偶尔顺手清掉一周没动过的
    if (Math.random() < 0.05) for (const f of fs.readdirSync(AGENTS)) { try { const p = path.join(AGENTS, f); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400_000) fs.rmSync(p, { force: true }); } catch {} }
  } catch {}
}

const TEXT = {
  en: {
    head: 'mydash: things you published are still open on the user\'s page:',
    pickup: 'mydash: the session that published these has ended; they are waiting in this project for you to pick up:',
    pending: (x, k) => `- Approval form “${x.title}” (${k}) is waiting for the user. If their message answers it, close it: mydash approvals close ${k} --note "<what was decided>"`,
    submitted: (x, k) => `- The user answered approval form “${x.title}” (${k}) on the page. Read it: mydash approvals ${k}; when handled: mydash approvals done ${x.answer || '<id>'}`,
    todo: (x, k) => `- To-do list “${x.title}” (${k}) has unticked items. If the user says one is done: mydash todos done ${k} "<start of the item>"`,
    ask: (x, a) => `- On “${x.title}”, item “${a.label}”, the user asks: ${a.text} — answer in one or two sentences: mydash asks reply ${a.id} "<answer>"`,
  },
  zh: {
    head: 'mydash：你发的这些东西在用户的页面上还开着：',
    pickup: 'mydash：发这些东西的会话已经结束了，它们在这个项目里等你接手：',
    pending: (x, k) => `- 审批单「${x.title}」（${k}）在等用户答。如果用户这条消息答了它，就关掉它：mydash approvals close ${k} --note "<定了什么>"`,
    submitted: (x, k) => `- 用户已经在网页上答了审批单「${x.title}」（${k}）。读答复：mydash approvals ${k}；处理完：mydash approvals done ${x.answer || '<id>'}`,
    todo: (x, k) => `- 待办「${x.title}」（${k}）还有没勾的。用户说某项做完了，就替用户勾上：mydash todos done ${k} "<那一项开头几个字>"`,
    ask: (x, a) => `- 用户在「${x.title}」的「${a.label}」上问：${a.text}　用一两句话回答：mydash asks reply ${a.id} "<回答>"`,
  },
};
const RULE = {
  en: {
    claude: 'mydash: when the user has to choose or decide something, ask with the AskUserQuestion tool (it reaches them in mydash and on their phone); for a long write-up with several decisions, publish a mydash approval form. Do not leave the choice as a question at the end of your reply.',
    codex: 'mydash: when the user has to choose or decide something, ask with the request_user_input tool if it is available, otherwise with `mydash ask "<question>" "<option>" …` (both reach them in mydash and on their phone). Do not leave the choice as a question at the end of your reply.',
  },
  zh: {
    claude: 'mydash：要用户做选择或拍板时，用 AskUserQuestion 选择题问（会到用户的 mydash 和手机上）；内容多、要连着拍好几个板的，发 mydash 审批单。不要只在回复末尾用文字问。',
    codex: 'mydash：要用户做选择或拍板时，能用 request_user_input 工具就用它问，用不了就运行 `mydash ask "问题" "选项" …`（都会到用户的 mydash 和手机上）。不要只在回复末尾用文字问。',
  },
};
// 发单的会话结束了（或者一天没动静、或者根本没记会话）
function ended(session) {
  if (!session) return true;
  try {
    const f = path.join(AGENTS, `${session}.json`);
    if (JSON.parse(fs.readFileSync(f, 'utf8')).state === 'ended') return true;
    return Date.now() - fs.statSync(f).mtimeMs > 86400_000;
  } catch { return true; }
}
// Claude Code 用 additionalContext：照样接着做，但终端里不显示成「Stop hook error」；Codex 用 decision: block（它的理由会当成下一条提示）
if (block) process.stdout.write(JSON.stringify(agent === 'claude' ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: block } } : { decision: 'block', reason: block }));
const out = [];
// 每个会话第一次收到用户消息时提醒一次（开着很久的会话没读到过这条规则）
if (event === 'busy' && valid && !prev.told && cfg.prompts?.enabled !== false) out.push(RULE[lang][agent]);
if (event === 'busy' && id) {
  try {
    const all = Object.entries(JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'open-items.json'), 'utf8')));
    const segs = new Set(String(input.cwd || process.cwd()).split(/[\\/]+/).filter(Boolean));
    const mine = all.filter(([, x]) => x.session === id);
    const pick = all.filter(([, x]) => x.session !== id && segs.has(x.project) && (x.state === 'submitted' || x.asks?.length) && ended(x.session));
    if (mine.length || pick.length) {
      const T = TEXT[lang];
      const lines = (list, agentOnly) => list.flatMap(([k, x]) => [
        ...(x.state === 'submitted' ? [T.submitted(x, k)] : agentOnly ? [] : x.state === 'pending' ? [T.pending(x, k)] : x.kind === 'todo' && x.state !== 'asked' ? [T.todo(x, k)] : []),
        ...(x.asks || []).slice(0, 3).map(a => T.ask(x, a)),
      ]);
      if (mine.length) out.push(T.head, ...lines(mine, false));
      if (pick.length) out.push(T.pickup, ...lines(pick, true));
    }
  } catch {}
}
if (out.length) process.stdout.write(out.join('\n') + '\n');
