// mydash feedback：列出用户在网页上留的、还没处理的批注；agent 改完后标记已处理。
// mydash approvals：审批单的答复；mydash todos：待办勾到哪了（都是内部命令，暂不写进帮助和 agent 说明，交给 agent 的方式还没定）。
import fs from 'node:fs';
import path from 'node:path';
import { HOME, scanAll, latest, baseUrl, itemPath, readMeta, readConfig } from './store.mjs';
import { readResponses, openComments, resolveComments, markApprovalDone, latestApproval, setTodo, openAsks, replyAsk, REPLY_MAX } from './responses.mjs';
import { approvalStatus, closeApproval, syncOpen, OPEN_INDEX } from './waiting.mjs';
import { currentSessionId } from './agents.mjs';
import { detectProject } from './agents.mjs';
import { t } from './i18n.mjs';
import { remoteConfig, remoteGet, remotePost } from './remote.mjs';
import { versionTodos, todoProgress } from './todo.mjs';
import { runChecks } from './todocheck.mjs';

function pickItems(pos, opts) {
  if (opts.all) return scanAll();
  const target = pos[0] || detectProject(process.cwd()).name;
  const [p, s] = target.split('/');
  return scanAll().filter(m => m.project === p && (!s || m.slug === s));
}
const short = iso => { const d = new Date(iso); const z = n => String(n).padStart(2, '0'); return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };

export async function cmdFeedback(pos, opts) {
  const rc = remoteConfig(); // 发布到别的机器时，批注也在那边
  if (pos[0] === 'done') {
    const ids = pos.slice(1).join(',').split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.length) { process.stderr.write(t('Usage: mydash feedback done <id> [<id>…] [--note "…"]') + '\n'); process.exitCode = 1; return; }
    let n = 0;
    if (rc) n = (await remotePost(rc, '/api/remote/feedback/done', { ids, note: opts.note || '' })).resolved;
    else for (const m of scanAll()) {
      const r = readResponses(m.project, m.slug);
      if (!r.comments.some(c => ids.includes(c.id) && c.status === 'open')) continue;
      n += await resolveComments(m.project, m.slug, ids, { note: opts.note || '' });
    }
    if (opts.json) process.stdout.write(JSON.stringify({ ok: true, resolved: n }) + '\n');
    else process.stdout.write(t('Marked {n} comment as handled.|Marked {n} comments as handled.', { n }) + '\n');
    return;
  }
  let out = [];
  if (rc) {
    const target = pos[0] || detectProject(process.cwd()).name; const [p, s] = target.split('/');
    out = (await remoteGet(rc, `/api/remote/feedback?${opts.all ? 'all=1' : `project=${encodeURIComponent(p)}${s ? `&slug=${encodeURIComponent(s)}` : ''}`}`)).open;
  } else for (const m of pickItems(pos, opts)) {
    for (const c of openComments(readResponses(m.project, m.slug))) {
      out.push({ id: c.id, item: `${m.project}/${m.slug}`, title: m.title, url: baseUrl() + itemPath(m.project, m.slug), v: c.v, latest: latest(m).v, file: c.file, heading: c.heading, quote: c.quote, text: c.text, createdAt: c.createdAt });
    }
  }
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, open: out }) + '\n'); return; }
  if (!out.length) { process.stdout.write(t('No open comments.') + '\n'); return; }
  let cur = '';
  for (const c of out) {
    if (c.item !== cur) { cur = c.item; process.stdout.write(`\n${c.item} · ${c.title} (v${c.latest})\n  ${c.url}\n`); }
    process.stdout.write(`  [${c.id}] v${c.v} · ${short(c.createdAt)}${c.heading ? ` · ${c.heading}` : ''}\n`);
    if (c.quote) process.stdout.write(`    “${c.quote.replace(/\s+/g, ' ').slice(0, 200)}”\n`);
    process.stdout.write(`    → ${c.text.replace(/\n/g, '\n      ')}\n`);
  }
  process.stdout.write('\n' + t('When done, publish the new version with --resolves <id>, or run mydash feedback done <id>.') + '\n');
}

// 还没处理的答复：最新版本上的；最新版还没人答时，也看旧版本上答了没处理的（用户答了 v1、agent 没看到又发了 v2）
function submittedAnswers(items, { withDone = false } = {}) {
  const out = [];
  for (const m of items) {
    const r = readResponses(m.project, m.slug);
    const a = latestApproval(r, latest(m).v) || [...r.approvals].reverse().find(x => x.status === 'submitted') || null;
    if (!a || (a.status === 'done' && !withDone)) continue;
    out.push({ id: a.id, item: `${m.project}/${m.slug}`, title: m.title, v: a.v, status: a.status, submittedAt: a.submittedAt, answers: a.answers });
  }
  return out;
}
const LATER = () => t('If you are in the middle of something, finish it and reply first; then act on these answers.');
function printAnswers(out, opts, { woke = false } = {}) {
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, answers: out, ...(woke ? { note: LATER() } : {}) }) + '\n'); return; }
  if (!out.length) { process.stdout.write(t('No new answers.') + '\n'); return; }
  if (woke) process.stdout.write(LATER() + '\n\n');
  for (const a of out) process.stdout.write(`[${a.id}] ${a.item} · ${a.title} v${a.v} · ${short(a.submittedAt)}\n${JSON.stringify(a.answers, null, 2).replace(/^/gm, '  ')}\n`);
}

// agent 现在是不是在忙（Claude Code 钩子写的，见 bin/agent-state.mjs）
// 记着 busy、但会话记录（没有就看状态本身）15 分钟没动静了：多半是被 Esc 打断了（不触发 Stop），不再等它
const BUSY_STALE = 15 * 60_000;
function agentBusy(session) {
  if (!/^[\w-]{6,100}$/.test(session || '')) return false;
  try {
    const f = path.join(HOME, 'state', 'agents', `${session}.json`); const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s.state !== 'busy') return false;
    let last = fs.statSync(f).mtimeMs; try { if (s.transcript) last = Math.max(last, fs.statSync(s.transcript).mtimeMs); } catch {}
    return Date.now() - last < BUSY_STALE;
  } catch { return false; }
}

// 等用户的动静：审批单提交了答复（approvals 为 true 时），或者有人在上面「问一下」。
// 到了以后，agent 可能正在做别的：等它答完这一轮（钩子记成 idle）再退出。没装钩子就直接退出
// --timeout 秒数：到时还没动静就退出（退出码 2）；不给就一直等
const openQuestions = items => items.flatMap(m => openAsks(readResponses(m.project, m.slug)).map(a => ({ id: a.id, item: `${m.project}/${m.slug}`, title: m.title, kind: a.kind, label: a.label, text: a.text, at: a.at })));
async function waitFor(target, opts, { approvals }) {
  target = target || detectProject(process.cwd()).name; const [p, s] = target.split('/');
  const timeout = Number(opts.timeout || 0) * 1000; const start = Date.now();
  const items = () => scanAll().filter(m => m.project === p && (!s || m.slug === s));
  for (;;) {
    // 等的是某一张审批单，而它在对话里定了 / 被取代 / 过期了：不用再等
    if (approvals && s) {
      const meta = readMeta(p, s); if (meta) { meta.project = p; meta.slug = s; }
      const st = meta ? approvalStatus(meta) : null;
      if (st && ['chat', 'superseded', 'expired'].includes(st.state)) {
        if (opts.json) process.stdout.write(JSON.stringify({ ok: true, closed: st.state, answers: [], asks: [] }) + '\n');
        else process.stdout.write(t('This approval form was closed ({how}); nothing to do.', { how: st.state }) + '\n');
        return;
      }
    }
    const got = () => ({ answers: approvals ? submittedAnswers(items()) : [], asks: openQuestions(items()) });
    let g = got();
    if (g.answers.length || g.asks.length) {
      while (agentBusy(process.env.CLAUDE_CODE_SESSION_ID)) await new Promise(r => setTimeout(r, 1000));
      g = got();
      if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, ...g, note: LATER() + (g.asks.length ? ' ' + t('Answer each question in one or two sentences: mydash asks reply <id> "<answer>". Then run this wait again in the background if the item is still open.') : '') }) + '\n'); return; }
      if (g.answers.length) printAnswers(g.answers, opts, { woke: true });
      else process.stdout.write(LATER() + '\n\n');
      printAsks(g.asks);
      return;
    }
    if (timeout && Date.now() - start >= timeout) {
      if (opts.json) process.stdout.write(JSON.stringify({ ok: false, timeout: true, answers: [], asks: [] }) + '\n');
      else process.stdout.write(t('No answer yet; stopped waiting.') + '\n');
      process.exitCode = 2; return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
function printAsks(list) {
  for (const a of list) process.stdout.write(`[${a.id}] ${a.item} · ${a.label}\n  ${t('Question')}: ${a.text}\n`);
  if (list.length) process.stdout.write(t('Answer each question in one or two sentences: mydash asks reply <id> "<answer>". Then run this wait again in the background if the item is still open.') + '\n');
}
// 回答以后告诉服务：打开着的页面马上显示回答
async function notifyResponded(id) {
  const port = process.env.MYDASH_PORT || readConfig().port || 4870;
  try { await fetch(`http://127.0.0.1:${port}/api/responded`, { method: 'POST', headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(1500) }); } catch {}
}

// mydash asks：用户在待办、审批题上「问一下」的问题；asks reply <id> "回答"：一两句话回答，显示在那一项下面
export async function cmdAsks(pos, opts) {
  if (pos[0] === 'reply') {
    const id = pos[1]; const text = pos.slice(2).join(' ').trim();
    if (!id || !text) { process.stderr.write(t('Usage: mydash asks reply <id> "<answer in one or two sentences>"') + '\n'); process.exitCode = 1; return; }
    if (text.length > REPLY_MAX) { process.stderr.write(t('Too long ({n} characters, the limit is {max}). Keep it to one or two sentences; for longer guidance publish a separate document and put its link here.', { n: text.length, max: REPLY_MAX }) + '\n'); process.exitCode = 1; return; }
    for (const m of scanAll()) {
      if (!readResponses(m.project, m.slug).asks.some(a => a.id === id)) continue;
      const a = await replyAsk(m.project, m.slug, id, text); await syncOpen(m.project, m.slug); await notifyResponded(`${m.project}/${m.slug}`);
      if (opts.json) process.stdout.write(JSON.stringify({ ok: true, ask: a }) + '\n');
      else process.stdout.write(t('Replied; it shows under that item on the page.') + '\n');
      return;
    }
    process.stderr.write(t('No such question: {id}', { id }) + '\n'); process.exitCode = 1; return;
  }
  const list = openQuestions(pickItems(pos, opts));
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, asks: list }) + '\n'); return; }
  if (!list.length) { process.stdout.write(t('No open questions.') + '\n'); return; }
  printAsks(list);
}

export async function cmdApprovals(pos, opts) {
  // wait：一直等到用户在网页上提交答复才退出，并打印答复。agent 发完审批单后放在后台跑，
  // 用户一提交，Claude Code 这类会在后台命令结束时唤醒 agent 的工具就能马上接着干活。
  // --timeout 秒数：到时还没答复就退出（退出码 2）；不给就一直等
  if (pos[0] === 'wait') return waitFor(pos[1], opts, { approvals: true });
  // close：用户在对话里答了，关掉网页上那张（网页上随之锁住，钩子也不再提醒）。不给条目就关掉本会话所有还开着的
  if (pos[0] === 'close') {
    let targets = pos.slice(1);
    if (!targets.length) {
      const sid = currentSessionId(); let ix = {};
      try { ix = JSON.parse(fs.readFileSync(OPEN_INDEX, 'utf8')); } catch {}
      targets = Object.entries(ix).filter(([, e]) => sid && e.session === sid && e.kind === 'approval' && e.state === 'pending').map(([k]) => k);
    }
    const out = [];
    for (const target of targets) { const [p, s] = target.split('/'); out.push({ item: target, ...(await closeApproval(p, s, { note: opts.note || '' })) }); }
    if (opts.json) { process.stdout.write(JSON.stringify({ ok: out.every(x => x.ok), closed: out }) + '\n'); return; }
    if (!out.length) { process.stdout.write(t('No open approval forms to close.') + '\n'); return; }
    for (const x of out) process.stdout.write((x.ok ? t('Closed {item}; the page now shows it was decided in the conversation.', { item: x.item }) : t('Could not close {item}: {why}', { item: x.item, why: x.state ? t('it is already {state}', { state: x.state }) : x.error })) + '\n');
    if (out.some(x => !x.ok)) process.exitCode = 1;
    return;
  }
  if (pos[0] === 'done') {
    const id = pos[1]; let hit = null;
    for (const m of scanAll()) if (readResponses(m.project, m.slug).approvals.some(a => a.id === id)) { hit = await markApprovalDone(m.project, m.slug, id, opts.note || ''); await syncOpen(m.project, m.slug); break; }
    if (opts.json) process.stdout.write(JSON.stringify({ ok: Boolean(hit), approval: hit }) + '\n');
    else process.stdout.write((hit ? t('Marked as handled.') : t('No such answer: {id}', { id })) + '\n');
    return;
  }
  printAnswers(submittedAnswers(pickItems(pos, opts), { withDone: opts.done }), opts);
}

export async function cmdTodos(pos, opts) {
  // wait <项目/slug>：后台等用户在这份待办上「问一下」（和 approvals wait 一样，等 agent 答完这一轮才交给它）
  if (pos[0] === 'list') pos = pos.slice(1); // mydash todos list = mydash todos
  if (pos[0] === 'wait') return waitFor(pos[1], opts, { approvals: false });
  // check [项目[/slug]]：马上跑一遍带 <!-- check: 命令 --> 的待办（服务也会每两分钟自己跑）
  if (pos[0] === 'check') {
    const [p, s] = String(pos[1] || '').split('/');
    const items = scanAll().filter(m => !p || (m.project === p && (!s || m.slug === s)));
    const lines = []; const changed = await runChecks(items, { log: m => lines.push(m) });
    if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, ticked: changed }) + '\n'); return; }
    process.stdout.write((lines.length ? lines.join('\n') : t('Nothing newly done.')) + '\n');
    return;
  }
  // done <项目/slug> <key 或这一项开头的几个字>…：用户在对话里说做完了，替用户勾上（--undo 取消）
  if (pos[0] === 'done') {
    const [p, s] = String(pos[1] || '').split('/'); const meta = p && s ? readMeta(p, s) : null;
    const want = pos.slice(2).map(x => String(x).trim()).filter(Boolean);
    if (!meta || !want.length) { process.stderr.write(t('Usage: mydash todos done <project/slug> <item key or the start of its text>…') + '\n'); process.exitCode = 1; return; }
    const l = latest(meta); const list = versionTodos(p, s, l);
    const norm = x => x.replace(/[`*_~\[\]()]/g, '').replace(/\s+/g, ' ').toLowerCase();
    const res = [];
    for (const w of want) {
      const hits = list.filter(x => x.key === w || norm(x.text).startsWith(norm(w)) || norm(x.text).includes(norm(w)));
      if (hits.length !== 1) { res.push({ query: w, ok: false, matches: hits.map(x => x.text) }); continue; }
      await setTodo(p, s, hits[0].key, { done: !opts.undo, text: hits[0].text, v: l.v, from: 'agent' });
      res.push({ query: w, ok: true, key: hits[0].key, text: hits[0].text });
    }
    await syncOpen(p, s);
    const prog = todoProgress(list, readResponses(p, s).todos);
    if (opts.json) { process.stdout.write(JSON.stringify({ ok: res.every(x => x.ok), ticked: res, done: prog.done, total: prog.total }) + '\n'); return; }
    for (const x of res) process.stdout.write((x.ok ? `[${opts.undo ? ' ' : 'x'}] ${x.text}` : (x.matches.length ? t('“{q}” matches {n} items; be more specific.', { q: x.query, n: x.matches.length }) : t('No to-do matches “{q}”.', { q: x.query }))) + '\n');
    process.stdout.write(t('{done} of {total} done', prog) + '\n');
    if (res.some(x => !x.ok)) process.exitCode = 1;
    return;
  }
  const out = [];
  for (const m of pickItems(pos, opts)) {
    const l = latest(m); const list = versionTodos(m.project, m.slug, l); if (!list.length) continue;
    const st = readResponses(m.project, m.slug).todos; const p = todoProgress(list, st);
    if (!p.left && !opts.done) continue;
    out.push({ item: `${m.project}/${m.slug}`, title: m.title, url: baseUrl() + itemPath(m.project, m.slug), v: l.v, total: p.total, done: p.done, left: p.left,
      items: p.items.map(x => ({ key: x.key, text: x.text, done: x.done, ...(st[x.key] ? { at: st[x.key].at } : {}) })) });
  }
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, todos: out }) + '\n'); return; }
  if (!out.length) { process.stdout.write(t('No open to-dos.') + '\n'); return; }
  for (const x of out) {
    process.stdout.write(`\n${x.item} · ${x.title} (${x.done}/${x.total})\n  ${x.url}\n`);
    for (const i of x.items) process.stdout.write(`  [${i.done ? 'x' : ' '}] ${i.text}${i.done && i.at ? `  · ${short(i.at)}` : ''}\n`);
  }
}
