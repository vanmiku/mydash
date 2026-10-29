// 把 mydash 接进 Claude Code / Codex，让以后的会话自己会发布：
//   1. 全局说明（~/.claude/CLAUDE.md、~/.codex/AGENTS.md）里加两小段规则：发布（mydash:begin/end）和
//      要用户拍板、动手的事交给 mydash（mydash:decide:begin/end：选择题、审批单、待办、提问）。用户自己写过的就不加
//   2. skill：链接到安装目录里的 skills/mydash
//   3. 权限：Claude Code 的 settings.json 放行 mydash 的几条只读/发布命令；Codex 用 rules 让它们在沙盒外运行
//      （Codex 默认沙盒不让写 ~/.mydash、也不让连 127.0.0.1，不放行的话每次发布都会失败）
//   4. 钩子（默认装，--no-hooks 不装）：记下 agent 忙不忙、回复末尾用文字提问时让它改用选择题（bin/agent-state.mjs），
//      选择题、计划确认、权限确认交给 mydash（bin/agent-ask.mjs）
// 全部可撤销：--remove 只删自己加的东西（settings.json 里加了哪几条记在 state/integrations.json）。
// 更新（setup install）时 refresh() 把以前装过的这些刷新到当前版本；doctor 用 hookHealth() 查钩子齐不齐、Codex 信任了没有。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from './store.mjs';
import { t, lang } from './i18n.mjs';
import { which } from './sys.mjs';

export const APP = path.join(HOME, 'app');
const BEGIN = '<!-- mydash:begin -->', END = '<!-- mydash:end -->';
const DBEGIN = '<!-- mydash:decide:begin -->', DEND = '<!-- mydash:decide:end -->';
const STATE = path.join(HOME, 'state', 'integrations.json');
const CLAUDE_PERMS = ['Bash(mydash publish:*)', 'Bash(mydash ls:*)', 'Bash(mydash url:*)', 'Bash(mydash doctor:*)', 'Bash(mydash feedback:*)'];
// 另外放行：等审批答复、关单、勾待办、问用户（agent 在后台等答复时不能卡在权限确认上）
const HOOK_PERMS = ['Bash(mydash approvals:*)', 'Bash(mydash todos:*)', 'Bash(mydash asks:*)', 'Bash(mydash ask:*)'];
// Codex 沙盒不让连 127.0.0.1：另外放行这几条（等审批答复、问用户、回答提问、勾待办）
const CODEX_HOOK_RULES = `# Written by \`mydash integrate codex\`; removed with \`mydash integrate codex --remove\`.\nprefix_rule(pattern=["mydash", ["ask", "asks", "approvals", "todos"]], decision="allow")\n`;
// 钩子（--hooks）：
//   agent-state.mjs：用户发消息时记 busy、答完一轮记 idle、会话关了记 ended（审批答复等 agent 答完这一轮再交给它）
//   agent-ask.mjs：选择题、计划确认、权限确认先交给 mydash 答（lib/prompts.mjs）；超时设得很长，用户可能过很久才答
// node 用 PATH 里的（Homebrew 的 /opt/homebrew/bin/node 升级后路径不变），找不到才用当前进程的
const nodeBin = () => which('node') || process.execPath;
const stateCmd = (st, agent) => `"${nodeBin()}" "${path.join(APP, 'bin', 'agent-state.mjs')}" ${st}${agent ? ' ' + agent : ''}`;
const askCmd = agent => `"${nodeBin()}" "${path.join(APP, 'bin', 'agent-ask.mjs')}" ${agent}`;
const ASK_TIMEOUT = 86400;
const CLAUDE_HOOKS = () => [
  { event: 'UserPromptSubmit', command: stateCmd('busy'), timeout: 5 },
  { event: 'Stop', command: stateCmd('idle'), timeout: 5 },
  // 这一轮因为 API 出错、额度用完而结束时，不走 Stop：不记 idle 的话会话会一直显示在忙，审批答复交不过去
  { event: 'StopFailure', command: stateCmd('idle'), timeout: 5 },
  { event: 'SessionEnd', command: stateCmd('ended'), timeout: 5 },
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode', command: askCmd('claude'), timeout: ASK_TIMEOUT },
  { event: 'PermissionRequest', command: askCmd('claude'), timeout: ASK_TIMEOUT },
];
const CODEX_HOOKS = () => [
  { event: 'UserPromptSubmit', command: stateCmd('busy', 'codex'), timeout: 5 },
  { event: 'Stop', command: stateCmd('idle', 'codex'), timeout: 5 },
  // 命令行版用 request_user_input，ChatGPT 桌面版用 request_user_input_async
  { event: 'PreToolUse', matcher: '^request_user_input(_async)?$', command: askCmd('codex'), timeout: ASK_TIMEOUT, statusMessage: 'Waiting for your answer in mydash…' },
  { event: 'PermissionRequest', matcher: '.*', command: askCmd('codex'), timeout: ASK_TIMEOUT, statusMessage: 'Waiting for your answer in mydash…' },
];
// 只认这一份安装的钩子（命令里是这份安装的 app 目录）：另一份安装（比如试装）卸载时，不会把主安装的钩子一起删掉
const isOurHook = h => /agent-(state|ask)\.mjs"? (busy|idle|ended|claude|codex)( (claude|codex))?$/.test(h?.command || '') && String(h.command).includes(path.join(APP, 'bin') + path.sep);
// 匹配规则、命令（含 node 路径）、超时、提示语都对得上才算装好了：换了版本或换了 node 的位置，就重新写
const sameHook = (g, x) => (g.matcher || undefined) === (x.matcher || undefined)
  && (g.hooks || []).some(h => h.command === x.command && h.timeout === x.timeout && (h.statusMessage || undefined) === (x.statusMessage || undefined));
const hasOurHooks = (j, list) => list.every(x => (j.hooks?.[x.event] || []).some(g => sameHook(g, x)));
// 删掉我们的钩子。只删因此变空的组和事件：用户自己原来就空着的组、hooks: {} 都留着
function dropOurHooks(j, { removeEmptyKey = false } = {}) {
  for (const ev of Object.keys(j.hooks || {})) {
    if (!Array.isArray(j.hooks[ev])) continue;
    const had = j.hooks[ev].some(g => (g.hooks || []).some(isOurHook));
    if (!had) continue;
    j.hooks[ev] = j.hooks[ev].flatMap(g => { const ours = (g.hooks || []).some(isOurHook); const rest = (g.hooks || []).filter(h => !isOurHook(h)); return ours && !rest.length ? [] : [ours ? { ...g, hooks: rest } : g]; });
    if (!j.hooks[ev].length) delete j.hooks[ev];
  }
  if (j.hooks && !Object.keys(j.hooks).length && removeEmptyKey) delete j.hooks;
}
const hookEntry = x => ({ type: 'command', command: x.command, timeout: x.timeout, ...(x.statusMessage ? { statusMessage: x.statusMessage } : {}) });
const hookGroup = x => ({ ...(x.matcher ? { matcher: x.matcher } : {}), hooks: [hookEntry(x)] });
// 写进（或更新）我们的钩子：已经有的组原地替换，不挪位置。Codex 的信任是按「事件:组序号:钩子序号」记的，
// 先删后加会把用户排在后面的钩子挪到前一个位置，信任就对不上了。skip：不要再加回来的（用户自己删掉的）
function addOurHooks(j, list, { skip = new Set() } = {}) {
  j.hooks = j.hooks || {};
  const events = new Set([...Object.keys(j.hooks), ...list.map(x => x.event)]);
  for (const ev of events) {
    const groups = Array.isArray(j.hooks[ev]) ? j.hooks[ev] : [];
    const want = list.filter(x => x.event === ev && !skip.has(x.event));
    let wi = 0; const out = [];
    for (const g of groups) {
      const ours = (g.hooks || []).filter(isOurHook);
      if (!ours.length) { out.push(g); continue; }
      const rest = (g.hooks || []).filter(h => !isOurHook(h));
      if (!rest.length && wi < want.length) { out.push(hookGroup(want[wi++])); continue; }  // 只装着我们的那个组：原地换成新的
      if (rest.length) out.push({ ...g, hooks: rest });  // 和用户的钩子混在一个组里（很少见）：拿出来，下面单独加一组
    }
    for (; wi < want.length; wi++) out.push(hookGroup(want[wi]));
    if (out.length) j.hooks[ev] = out; else delete j.hooks[ev];
  }
}
// 改 JSON 文件时照原来的缩进和末尾换行写回，卸载后能和原文件一样
function writeJsonLike(file, obj, raw) {
  const indent = (/\n([ \t]+)"/.exec(raw || '') || [, '  '])[1];
  const tail = raw != null && !raw.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, JSON.stringify(obj, null, indent) + tail);
}
const CODEX_RULES = `# Written by \`mydash integrate codex\`; remove with \`mydash integrate codex --remove\`.
# Publishing writes to ~/.mydash and checks 127.0.0.1, which the Codex sandbox blocks, so these run outside it without asking.
prefix_rule(pattern=["mydash", "publish"], decision="allow")
prefix_rule(pattern=["mydash", ["ls", "url", "doctor", "feedback"]], decision="allow")
`;

const RULE = {
  en: `## Publish deliverables to mydash
When you produce something the user should look at (a plan, report, comparison, screenshots, charts, tables, PDFs, HTML previews, Word or Excel files), publish it with \`mydash publish\` and put the URL it prints in your reply, instead of only giving a local path. Details: the \`mydash\` skill, or \`mydash publish --help\`.
- Changed it and publishing again: reuse its \`--slug\` (it becomes v2, v3). Different things get different slugs.
- Do not pass \`--project\`: the project is the folder the session started in, detected automatically.
- Before revising something you published, run \`mydash feedback\` for the user's comments; publish the fix with \`--resolves <id>\`.`,
  zh: `## 中间产物发到 mydash
生成了需要用户看的东西（方案、报告、对比分析、截图、图表、表格、PDF、网页预览、Word / Excel 等），用 \`mydash publish\` 发布，汇报时附上它打印的网址，不要只给本地路径。详细用法见 mydash skill 或 \`mydash publish --help\`。
- 同一个东西改了再发，用同一个 \`--slug\`（会变成 v2、v3）；不同的东西用不同的 slug。
- 不要传 \`--project\`：项目 = 会话启动时所在的文件夹，会自动识别。
- 改已经发布过的东西之前，先运行 \`mydash feedback\` 看用户的批注；改完发布时加 \`--resolves <id>\`。`,
};

// 第二段：要用户拍板、动手的事交给 mydash。Codex 没有后台任务，也没有 AskUserQuestion，写法不一样
const DECIDE = {
  en: {
    claude: `## Decisions and to-dos for the user go to mydash
- When the user has to choose or decide, do not leave it as a question at the end of your reply. For a short, single choice, use the AskUserQuestion tool: it shows in the terminal and in the user's mydash at the same time, and reaches their phone if nobody answers. For a long write-up with several decisions, publish a mydash approval form (format: the \`mydash\` skill).
- After publishing an approval form, run \`mydash approvals wait <project/slug>\` in the background (Bash run_in_background). When the user submits, it wakes you once you finish the current turn. If they answer in the conversation instead, close the form: \`mydash approvals close <project/slug> --note "<what was decided>"\`. After handling an answer from the page: \`mydash approvals done <answer id>\`.
- Things only the user can do (type a password, log in, click approve in a console) go in a to-do: \`mydash publish … --type todo\` with a \`- [ ]\` list. If a command can tell whether an item is done, end it with \`<!-- check: <command> -->\` and it ticks itself. When the user says one is done: \`mydash todos done <project/slug> "<start of the item>"\`. Also run \`mydash todos wait <project/slug>\` in the background.
- The user can ask about an approval question or a to-do item on the page. When that wakes you, answer in one or two sentences: \`mydash asks reply <question id> "<answer>"\`.`,
    codex: `## Decisions and to-dos for the user go to mydash
- When the user has to choose or decide, do not leave it as a question at the end of your reply. Use the request_user_input tool when it is available: the question shows in Codex, and the user is reminded in mydash and on their phone if they do not answer. Otherwise run \`mydash ask "<question>" "<option 1>" "<option 2>" …\` (\`--multi\` for several answers): it asks in mydash, waits until the user answers and prints the answer; exit code 3 means they want to answer in the conversation. For a long write-up with several decisions, publish a mydash approval form (format: the \`mydash\` skill) and give the user its URL; once they answer on the page, you are reminded at the start of the next message to read it: \`mydash approvals <project/slug>\`.
- If the user answers an approval form in the conversation, close it: \`mydash approvals close <project/slug> --note "<what was decided>"\`. After handling an answer from the page: \`mydash approvals done <answer id>\`.
- Things only the user can do (type a password, log in, click approve in a console) go in a to-do: \`mydash publish … --type todo\` with a \`- [ ]\` list. If a command can tell whether an item is done, end it with \`<!-- check: <command> -->\` and it ticks itself. When the user says one is done: \`mydash todos done <project/slug> "<start of the item>"\`.
- The user can ask about an approval question or a to-do item on the page; you are reminded at the start of the next message. Answer in one or two sentences: \`mydash asks reply <question id> "<answer>"\`.`,
  },
  zh: {
    claude: `## 要用户拍板、动手的事，交给 mydash
- 要用户做选择或拍板时，不要只在回复末尾用文字问。简短的、单个的选择，用 AskUserQuestion 选择题问：它会同时出现在终端和用户的 mydash 上，没人答会推送到手机。先写了一大段内容、要连着拍好几个板的，发 mydash 审批单（写法见 mydash skill）。
- 发完审批单，用 Bash 的 run_in_background 在后台跑 \`mydash approvals wait <项目/slug>\`：用户提交后，它会等你答完手上这一轮再叫醒你。用户在对话里直接答了，就关掉网页上那张：\`mydash approvals close <项目/slug> --note "定了什么"\`；处理完网页上的答复：\`mydash approvals done <答复 id>\`。
- 只有用户自己能做的事（输密码、登录网站、在后台点批准），发待办：\`mydash publish … --type todo\`，内容写成 \`- [ ]\` 清单。能用命令判断做没做完的项，末尾加 \`<!-- check: 命令 -->\`，做完会自动勾上。用户说某项做完了：\`mydash todos done <项目/slug> "<那一项开头几个字>"\`。发完也在后台跑 \`mydash todos wait <项目/slug>\`。
- 用户会在审批题、待办项上「问一下」。被叫醒后用一两句话回答：\`mydash asks reply <问题 id> "回答"\`。`,
    codex: `## 要用户拍板、动手的事，交给 mydash
- 要用户做选择或拍板时，不要只在回复末尾用文字问。能用 request_user_input 工具时用它问：题目在 Codex 里弹出，用户没答的话 mydash 和手机上会提醒。用不了就运行 \`mydash ask "问题" "选项1" "选项2" …\`（可以多选加 \`--multi\`）：它在 mydash 上问，等用户答完才返回，输出就是答案，退出码 3 表示用户想在对话里答。先写了一大段内容、要连着拍好几个板的，发 mydash 审批单（写法见 mydash skill），把网址告诉用户；用户在网页上答了以后，下次对话开始时会提醒你去读：\`mydash approvals <项目/slug>\`。
- 用户在对话里直接答了审批单，就关掉网页上那张：\`mydash approvals close <项目/slug> --note "定了什么"\`；处理完网页上的答复：\`mydash approvals done <答复 id>\`。
- 只有用户自己能做的事（输密码、登录网站、在后台点批准），发待办：\`mydash publish … --type todo\`，内容写成 \`- [ ]\` 清单。能用命令判断做没做完的项，末尾加 \`<!-- check: 命令 -->\`，做完会自动勾上。用户说某项做完了：\`mydash todos done <项目/slug> "<那一项开头几个字>"\`。
- 用户会在审批题、待办项上「问一下」，下次对话开始时会提醒你。用一两句话回答：\`mydash asks reply <问题 id> "回答"\`。`,
  },
};

export function agentHomes() {
  return {
    claude: process.env.MYDASH_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codex: process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}
function targets(agent) {
  const base = agentHomes()[agent];
  return agent === 'claude'
    ? { base, doc: path.join(base, 'CLAUDE.md'), skill: path.join(base, 'skills', 'mydash'), settings: path.join(base, 'settings.json') }
    : { base, doc: path.join(base, 'AGENTS.md'), skill: path.join(base, 'skills', 'mydash'), rules: path.join(base, 'rules', 'mydash.rules'), hookRules: path.join(base, 'rules', 'mydash-ask.rules'), hooks: path.join(base, 'hooks.json') };
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const markRe = (b, e) => new RegExp(`\\n?${b}[\\s\\S]*?${e}\\n?`);
const blockRe = markRe(BEGIN, END), decideRe = markRe(DBEGIN, DEND);
// 两段规则：发布；要用户拍板、动手的事。用户自己写过的（own）就不再加
const BLOCKS = agent => [
  { id: 'publish', re: blockRe, own: /mydash publish/, text: () => `${BEGIN}\n${RULE[lang()] || RULE.en}\n${END}\n`,
    detail: () => t('a short rule: publish deliverables with mydash and report the URL'), ownDetail: () => t('already mentions mydash publish; left as is') },
  { id: 'decide', re: decideRe, own: /mydash (approvals|ask)\b/, text: () => `${DBEGIN}\n${(DECIDE[lang()] || DECIDE.en)[agent]}\n${DEND}\n`,
    detail: () => t('a short rule: choices, approval forms and to-dos for the user go through mydash'), ownDetail: () => t('already mentions mydash approvals or mydash ask; left as is') },
];
function blockState(text, b) {
  if (text == null) return 'missing-file';
  if (b.re.test(text)) return 'block';
  if (b.own.test(text.replace(blockRe, '').replace(decideRe, ''))) return 'own-rule'; // 用户自己写过：不再重复加
  return 'none';
}
const ALL_PERMS = [...CLAUDE_PERMS, ...HOOK_PERMS];
function linkState(link) {
  let st; try { st = fs.lstatSync(link); } catch { return 'none'; }
  if (!st.isSymbolicLink()) return 'other';
  const ours = path.join(APP, 'skills', 'mydash');
  // 先比链接本身写的目标：安装目录已经删了、链接断了，也认得出是我们的
  if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === ours) return 'ours';
  try { return fs.realpathSync(link) === fs.realpathSync(ours) ? 'ours' : 'other'; } catch { return 'other'; }
}

export function status(agent) {
  const tg = targets(agent); const rec = readState()[agent] || {};
  const present = fs.existsSync(tg.base);
  const text = readText(tg.doc); const [pb, db] = BLOCKS(agent);
  const out = { agent, present, doc: blockState(text, pb), decide: blockState(text, db), skill: linkState(tg.skill) };
  if (agent === 'claude') {
    let allow = []; try { allow = JSON.parse(readText(tg.settings) || '{}').permissions?.allow || []; } catch {}
    out.permissions = ALL_PERMS.every(p => allow.includes(p));
  } else out.rules = readText(tg.rules) === CODEX_RULES && readText(tg.hookRules) === CODEX_HOOK_RULES;
  let hj = {}; try { hj = JSON.parse(readText(agent === 'claude' ? tg.settings : tg.hooks) || '{}'); } catch {}
  out.hooks = rec.noHooks ? 'off' : hasOurHooks(hj, wantedHooks(agent, rec, hj)) ? 'ok' : 'missing';
  const has = s => s === 'block' || s === 'own-rule';
  out.missing = [!has(out.doc) && 'publish-rule', !has(out.decide) && 'decide-rule', out.skill !== 'ours' && 'skill', !(out.permissions ?? out.rules) && (agent === 'claude' ? 'permissions' : 'rules'), out.hooks === 'missing' && 'hooks'].filter(Boolean);
  out.integrated = !out.missing.length;
  return out;
}

function removeHooksStep(f, rec) {
  return { file: f, action: 'remove-hooks', apply: () => {
    try {
      const raw = readText(f); const j = JSON.parse(raw || '{}'); dropOurHooks(j, { removeEmptyKey: rec.createdHooksKey });
      if (!Object.keys(j).length && rec.createdHooksFile) fs.rmSync(f, { force: true }); // 文件是我们建的、删完只剩 {}：整个删掉
      else writeJsonLike(f, j, raw);
    } catch {}
    delete rec.hooksAdded; delete rec.createdHooksFile; delete rec.createdHooksKey;
  } };
}
// 文件里现在有我们的哪些钩子（按事件）
const ourEvents = j => new Set(Object.entries(j.hooks || {}).filter(([, gs]) => Array.isArray(gs) && gs.some(g => (g.hooks || []).some(isOurHook))).map(([ev]) => ev));
// 用户自己删掉的：以前装过（rec.hookIds）、现在文件里没有了。更新时不再加回来，doctor 也不算缺
const userRemoved = (rec, j) => { const have = ourEvents(j); return new Set((rec.hookIds || []).filter(ev => !have.has(ev))); };
const wantedHooks = (agent, rec, j) => { const skip = userRemoved(rec, j); return (agent === 'claude' ? CLAUDE_HOOKS() : CODEX_HOOKS()).filter(x => !skip.has(x.event)); };

// 返回计划要做的改动；dryRun 时只返回不执行
// hooks：钩子默认装；false（--no-hooks）不装，以前装过的也撤掉
// 只撤这一份安装装过的东西（state/integrations.json 里有记录的）：另一个 MYDASH_HOME 的试装卸载时，不会动主安装写进去的规则段和规则文件
export function integrate(agent, { remove = false, dryRun = false, hooks = true } = {}) {
  const tg = targets(agent); const plan = []; const state = readState();
  const known = Boolean(state[agent]);
  const rec = state[agent] || {};
  if (!remove) {
    const text0 = readText(tg.doc);
    for (const b of BLOCKS(agent)) {
      const ds = blockState(text0, b);
      if (ds === 'own-rule') { plan.push({ file: tg.doc, action: 'skip', detail: b.ownDetail() }); continue; }
      plan.push({ file: tg.doc, action: ds === 'block' ? 'update-block' : 'append-block', detail: b.detail(), apply: () => {
        if (ds === 'missing-file' && readText(tg.doc) == null) rec.createdDoc = true;
        const cur = readText(tg.doc) || ''; const block = b.text();
        if (cur && !cur.endsWith('\n') && !(rec.blocks || []).length) rec.docNoEol = true; // 原文件末尾没有换行：撤销时照样去掉
        const next = b.re.test(cur) ? cur.replace(b.re, `\n${block}`) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block}`;
        fs.mkdirSync(path.dirname(tg.doc), { recursive: true }); fs.writeFileSync(tg.doc, next);
        rec.blocks = [...new Set([...(rec.blocks || []), b.id])];
      } });
    }
    const ls = linkState(tg.skill);
    if (ls === 'other') plan.push({ file: tg.skill, action: 'skip', detail: t('a different mydash skill already exists there; left as is') });
    else plan.push({ file: tg.skill, action: 'link', detail: `→ ${path.join(APP, 'skills', 'mydash')}`, apply: () => {
      fs.mkdirSync(path.dirname(tg.skill), { recursive: true }); fs.rmSync(tg.skill, { force: true });
      fs.symlinkSync(path.join(APP, 'skills', 'mydash'), tg.skill, process.platform === 'win32' ? 'junction' : 'dir'); // Windows 上 junction 不需要管理员
    } });
    if (agent === 'claude') {
      const raw = readText(tg.settings);
      let j = {}; let bad = false;
      if (raw != null) { try { j = JSON.parse(raw); } catch { bad = true; } }
      if (bad) plan.push({ file: tg.settings, action: 'skip', detail: t('not valid JSON; add these to permissions.allow by hand: {list}', { list: CLAUDE_PERMS.join(', ') }) });
      else {
        const allow = j.permissions?.allow || [];
        const add = ALL_PERMS.filter(p => !allow.includes(p));
        if (add.length) plan.push({ file: tg.settings, action: 'add-permissions', detail: add.join(', '), apply: () => {
          const raw1 = readText(tg.settings);
          if (raw1 == null) rec.createdSettings = true;
          const cur = JSON.parse(raw1 || '{}');
          if (!rec.permissionsAdded?.length) { if (!cur.permissions) rec.createdPermissions = true; else if (!cur.permissions.allow) rec.createdAllow = true; }
          cur.permissions = cur.permissions || {}; cur.permissions.allow = [...(cur.permissions.allow || []), ...add];
          fs.mkdirSync(path.dirname(tg.settings), { recursive: true });
          writeJsonLike(tg.settings, cur, raw1);
          rec.permissionsAdded = [...new Set([...(rec.permissionsAdded || []), ...add])];
        } });
        if (!hooks && rec.hooksAdded) plan.push(removeHooksStep(tg.settings, rec));
        if (hooks && !hasOurHooks(j, CLAUDE_HOOKS())) plan.push({ file: tg.settings, action: 'add-hooks', detail: t('note whether the agent is busy or gone; bring its questions, plan approvals and permission prompts to mydash, and have it re-ask questions it puts in its reply text'), apply: () => {
          const raw1 = readText(tg.settings); const cur = JSON.parse(raw1 || '{}');
          if (!rec.hooksAdded && !cur.hooks) rec.createdHooksKey = true;
          addOurHooks(cur, CLAUDE_HOOKS());
          fs.mkdirSync(path.dirname(tg.settings), { recursive: true });
          writeJsonLike(tg.settings, cur, raw1);
          rec.hooksAdded = true; rec.hookIds = [...new Set([...(rec.hookIds || []), ...CLAUDE_HOOKS().map(x => x.event)])];
        } });
      }
    } else {
      if (!hooks && rec.hooksAdded) plan.push(removeHooksStep(tg.hooks, rec));
      if (hooks) {
        let hj = {}; let hbad = false; const hraw = readText(tg.hooks);
        if (hraw != null) { try { hj = JSON.parse(hraw); } catch { hbad = true; } }
        if (hbad) plan.push({ file: tg.hooks, action: 'skip', detail: t('not valid JSON; left as is') });
        else if (!hasOurHooks(hj, CODEX_HOOKS())) {
          plan.push({ file: tg.hooks, action: 'add-hooks', detail: t('bring Codex questions and approval prompts to mydash, and have it re-ask questions it puts in its reply text'), apply: () => {
            const raw1 = readText(tg.hooks);
            if (raw1 == null) rec.createdHooksFile = true;
            const cur = JSON.parse(raw1 || '{}');
            if (!rec.hooksAdded && !cur.hooks) rec.createdHooksKey = true;
            addOurHooks(cur, CODEX_HOOKS());
            fs.mkdirSync(path.dirname(tg.hooks), { recursive: true }); writeJsonLike(tg.hooks, cur, raw1);
            rec.hooksAdded = true; rec.hookIds = [...new Set([...(rec.hookIds || []), ...CODEX_HOOKS().map(x => x.event)])];
          } });
          // Codex 只运行用户信任过的钩子，这一步只能用户自己做
          plan.push({ file: tg.hooks, action: 'note', detail: t('Codex runs new hooks only after you trust them: open Codex in a terminal, type /hooks and trust the mydash ones') });
        }
      }
      if (readText(tg.hookRules) !== CODEX_HOOK_RULES) plan.push({ file: tg.hookRules, action: 'write', detail: t('let mydash ask / asks / approvals / todos reach mydash from the Codex sandbox'), apply: () => {
        fs.mkdirSync(path.dirname(tg.hookRules), { recursive: true }); fs.writeFileSync(tg.hookRules, CODEX_HOOK_RULES); rec.rulesWritten = true;
      } });
      plan.push({ file: tg.rules, action: 'write', detail: t('let mydash publish / ls / url / doctor / feedback run outside the Codex sandbox without asking'), apply: () => {
        fs.mkdirSync(path.dirname(tg.rules), { recursive: true }); fs.writeFileSync(tg.rules, CODEX_RULES); rec.rulesWritten = true;
      } });
    }
  } else {
    // 规则段：只撤这一份安装加过的（老记录里没写是哪几段，就当两段都是）
    const mine = known ? new Set(rec.blocks || ['publish', 'decide']) : new Set();
    const cur = readText(tg.doc);
    const res = BLOCKS(agent).filter(b => mine.has(b.id)).map(b => b.re);
    if (cur != null && res.some(re => re.test(cur))) plan.push({ file: tg.doc, action: 'remove-block', apply: () => {
      let next = res.reduce((x, re) => x.replace(re, '\n'), cur).replace(/\n+$/, '\n');
      if (rec.docNoEol) next = next.replace(/\n+$/, '');
      if (!next.trim() && rec.createdDoc) fs.rmSync(tg.doc, { force: true }); else fs.writeFileSync(tg.doc, next);
      delete rec.createdDoc; delete rec.blocks; delete rec.docNoEol;
    } });
    if (linkState(tg.skill) === 'ours') plan.push({ file: tg.skill, action: 'unlink', apply: () => fs.rmSync(tg.skill, { force: true }) });
    if (agent === 'claude' && rec.permissionsAdded?.length) plan.push({ file: tg.settings, action: 'remove-permissions', detail: rec.permissionsAdded.join(', '), apply: () => {
      try {
        const raw = readText(tg.settings); const j = JSON.parse(raw || '{}');
        if (j.permissions?.allow) {
          j.permissions.allow = j.permissions.allow.filter(p => !rec.permissionsAdded.includes(p));
          if (!j.permissions.allow.length && (rec.createdAllow || rec.createdPermissions)) delete j.permissions.allow;
          if (!Object.keys(j.permissions).length && rec.createdPermissions) delete j.permissions;
        }
        writeJsonLike(tg.settings, j, raw);
      } catch {}
      delete rec.permissionsAdded; delete rec.createdAllow; delete rec.createdPermissions;
    } });
    if (rec.hooksAdded) plan.push(removeHooksStep(agent === 'claude' ? tg.settings : tg.hooks, rec));
    // settings.json 是我们建的，删完只剩空壳：整个删掉
    if (agent === 'claude' && rec.createdSettings) plan.push({ file: tg.settings, action: 'tidy', apply: () => {
      try { const j = JSON.parse(readText(tg.settings) || '{}'); if (!j.permissions?.allow?.length) delete j.permissions; if (!Object.keys(j).length) fs.rmSync(tg.settings, { force: true }); } catch {}
      delete rec.createdSettings;
    } });
    delete rec.noHooks; delete rec.hookIds;
    if (agent === 'codex' && known && readText(tg.rules) === CODEX_RULES) plan.push({ file: tg.rules, action: 'delete', apply: () => fs.rmSync(tg.rules, { force: true }) });
    if (agent === 'codex' && known && readText(tg.hookRules) === CODEX_HOOK_RULES) plan.push({ file: tg.hookRules, action: 'delete', apply: () => fs.rmSync(tg.hookRules, { force: true }) });
    delete rec.rulesWritten;
  }
  // 撤销后 skills/、rules/ 空了就删掉（不删里面还有东西的）
  if (remove && plan.length) plan.push({ file: path.join(tg.base, 'skills'), action: 'tidy', apply: () => {
    for (const d of [path.dirname(tg.skill), tg.rules && path.dirname(tg.rules)].filter(Boolean)) { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {} }
  } });
  if (!remove) { if (hooks) delete rec.noHooks; else rec.noHooks = true; }
  if (!dryRun) {
    for (const step of plan) if (step.apply) step.apply();
    state[agent] = rec; if (remove && !Object.keys(rec).length) delete state[agent];
    writeState(state);
  }
  return plan.map(({ apply, ...x }) => x);
}

// 更新时调用：把以前装过的接入刷新到当前版本（规则段落的文字、放行规则、沙盒规则、钩子）。
// 只动这一份安装以前装过的东西：没接入过（比如试装）、用户自己写了规则、已经撤掉的、用户自己删掉的钩子和放行，都不加回来。
// 返回改了哪些，Codex 的钩子改了要用户重新信任（codexTrust）
export function refresh(agent) {
  const tg = targets(agent); const state = readState(); const done = [];
  if (!state[agent]) return { changes: done, codexTrust: false };
  const rec = state[agent];
  const mine = new Set(rec.blocks || ['publish', 'decide']);
  for (const b of BLOCKS(agent)) {
    if (!mine.has(b.id)) continue;
    const doc = readText(tg.doc); const block = b.text();
    if (doc != null && b.re.test(doc) && !doc.includes(block)) { fs.writeFileSync(tg.doc, doc.replace(b.re, `\n${block}`)); done.push({ file: tg.doc, detail: t('updated the mydash rule to this version') }); }
  }
  if (agent === 'claude' && rec.permissionsAdded?.length) {
    try {
      const raw = readText(tg.settings); const j = JSON.parse(raw || '{}'); const allow = j.permissions?.allow || [];
      // 只加这个版本新有的；以前加过、用户自己删掉的不加回来
      const add = ALL_PERMS.filter(p => !allow.includes(p) && !rec.permissionsAdded.includes(p));
      if (add.length) {
        j.permissions = { ...(j.permissions || {}), allow: [...allow, ...add] }; writeJsonLike(tg.settings, j, raw);
        rec.permissionsAdded = [...new Set([...rec.permissionsAdded, ...add])]; done.push({ file: tg.settings, detail: t('added the new allow rules: {list}', { list: add.join(', ') }) });
      }
    } catch {}
  }
  if (agent === 'codex') {
    const cur = readText(tg.rules);
    if (cur != null && cur !== CODEX_RULES && cur.startsWith('# Written by `mydash integrate codex`')) { fs.writeFileSync(tg.rules, CODEX_RULES); done.push({ file: tg.rules, detail: t('updated the sandbox rules') }); }
    if (cur != null && readText(tg.hookRules) !== CODEX_HOOK_RULES) { fs.mkdirSync(path.dirname(tg.hookRules), { recursive: true }); fs.writeFileSync(tg.hookRules, CODEX_HOOK_RULES); done.push({ file: tg.hookRules, detail: t('updated the sandbox rules') }); }
  }
  let codexTrust = false;
  if (rec.hooksAdded) {
    const f = agent === 'claude' ? tg.settings : tg.hooks; const all = agent === 'claude' ? CLAUDE_HOOKS() : CODEX_HOOKS();
    try {
      const raw = readText(f); const j = JSON.parse(raw || '{}');
      const skip = rec.hookIds ? userRemoved(rec, j) : new Set();
      const list = all.filter(x => !skip.has(x.event));
      if (!hasOurHooks(j, list)) { addOurHooks(j, all, { skip }); writeJsonLike(f, j, raw); done.push({ file: f, detail: t('brought the hooks up to date') }); codexTrust = agent === 'codex'; }
      const ids = [...new Set([...(rec.hookIds || []), ...all.map(x => x.event)])];
      if (JSON.stringify(ids) !== JSON.stringify(rec.hookIds)) { rec.hookIds = ids; if (!done.length) done.push({ file: STATE, detail: t('noted which hooks are installed') }); }
    } catch {}
  }
  if (done.length) { state[agent] = rec; writeState(state); }
  return { changes: done, codexTrust };
}

// doctor 用：装过钩子才查。钩子齐不齐、指向的 node 和脚本还在不在、Codex 里信任了几条（读 config.toml 的 hooks.state，只读）
export function hookHealth(agent) {
  const tg = targets(agent); const rec = readState()[agent] || {};
  if (!rec.hooksAdded) return null;
  const f = agent === 'claude' ? tg.settings : tg.hooks;
  let j = {}; try { j = JSON.parse(readText(f) || '{}'); } catch {}
  const complete = hasOurHooks(j, wantedHooks(agent, rec, j));
  const ours = Object.entries(j.hooks || {}).flatMap(([ev, groups]) => (Array.isArray(groups) ? groups : []).flatMap((g, gi) => (g.hooks || []).map((h, hi) => ({ ev, gi, hi, h })).filter(x => isOurHook(x.h))));
  const missing = [...new Set(ours.flatMap(x => [...x.h.command.matchAll(/"([^"]+)"/g)].map(m => m[1])).filter(p => !fs.existsSync(p)))];
  let untrusted = null;
  if (agent === 'codex') {
    const toml = readText(path.join(tg.base, 'config.toml')) || '';
    const snake = ev => ev.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    untrusted = ours.filter(x => {
      const head = `[hooks.state."${tg.hooks.replace(/\\/g, '\\\\')}:${snake(x.ev)}:${x.gi}:${x.hi}"]`;
      const at = toml.indexOf(head); if (at < 0) return true;
      const body = toml.slice(at + head.length).split(/\n\[/)[0];
      return !/trusted_hash\s*=/.test(body) || /enabled\s*=\s*false/.test(body);
    }).length;
  }
  return { complete, missing, untrusted };
}
