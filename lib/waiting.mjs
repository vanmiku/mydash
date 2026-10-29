// 等你处理的东西（审批单、待办）：状态、结局，和按会话记的"开着的单子"。
//   审批单的状态只看最新版本：
//     pending 等你答 · submitted 网页上答了、agent 还没处理 · done agent 处理完了
//     chat 在对话里定了（agent 用 mydash approvals close 关的）· superseded 同一个会话又发了新的审批单
//     expired 没人答，发单的会话也停了 EXPIRE_DAYS 天
//   待办：还有没勾的就开着；全勾完就进处理记录。
//   开着的单子记在 state/open-items.json（{ "项目/slug": { session, project, kind, state, title, asks } }），
//   钩子（bin/agent-state.mjs）在用户每次发消息时据此提醒发单的那个会话：对话里答了就关单、做完了就勾掉、有人问就回答。
//   发单的会话已经结束时，等 agent 处理的（网页上答了的审批、没回答的提问）交给同一个项目里新开的会话。
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readMeta, latest, scanAll, withLock } from './store.mjs';
import { readResponses, latestApproval, latestClosure, addClosure, openAsks } from './responses.mjs';
import { versionTodos, todoProgress } from './todo.mjs';

export const EXPIRE_DAYS = 3;
export const OPEN_INDEX = path.join(HOME, 'state', 'open-items.json');
const AGENTS_DIR = path.join(HOME, 'state', 'agents');
const DAY = 86400_000;

// 会话最后一次有动静的时间（钩子写的状态文件）；没装钩子就是 null
export function sessionSeen(session) {
  if (!/^[\w-]{6,100}$/.test(session || '')) return null;
  try { return fs.statSync(path.join(AGENTS_DIR, `${session}.json`)).mtimeMs; } catch { return null; }
}

// { state, at, approval?, closure? }；不是审批单就是 null
export function approvalStatus(m, r = readResponses(m.project, m.slug)) {
  const l = latest(m);
  if ((l.category || m.category) !== 'approval') return null;
  const a = latestApproval(r, l.v);
  if (a) return { state: a.status === 'done' ? 'done' : 'submitted', at: a.submittedAt, approval: a };
  const c = latestClosure(r, l.v);
  if (c) return { state: c.how, at: c.at, closure: c };
  const cutoff = Date.now() - EXPIRE_DAYS * DAY;
  const seen = l.session ? sessionSeen(l.session) : null;
  if (Date.parse(l.time) < cutoff && (seen == null || seen < cutoff)) {
    return { state: 'expired', at: new Date(Math.max(Date.parse(l.time), seen || 0) + EXPIRE_DAYS * DAY).toISOString() };
  }
  return { state: 'pending' };
}
export const isOpenApproval = st => st?.state === 'pending';

const readIndex = () => { try { return JSON.parse(fs.readFileSync(OPEN_INDEX, 'utf8')); } catch { return {}; } };
function writeIndex(ix) {
  fs.mkdirSync(path.dirname(OPEN_INDEX), { recursive: true });
  const tmp = `${OPEN_INDEX}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(ix, null, 2)); fs.renameSync(tmp, OPEN_INDEX);
}
// 重新算一个条目开没开着，写进索引（发布、提交、勾选、关单之后都调）
export async function syncOpen(project, slug) {
  const id = `${project}/${slug}`;
  let entry = null;
  const meta = readMeta(project, slug);
  if (meta?.versions?.length) {
    meta.project = project; meta.slug = slug;
    const l = latest(meta);
    const r = readResponses(project, slug); const ap = approvalStatus(meta, r);
    const asks = openAsks(r).map(a => ({ id: a.id, label: a.label.slice(0, 60), text: a.text.slice(0, 160) }));
    const base = { session: l.session || null, project, title: l.title, kind: ap ? 'approval' : 'todo', ...(asks.length ? { asks } : {}) };
    // 等用户的（待答的审批、没勾完的待办）只提醒发单的会话；等 agent 的（网页上答了的审批、提问）谁都可以接手
    if (ap?.state === 'submitted') entry = { ...base, state: 'submitted', answer: ap.approval.id };
    else if (l.session && ap?.state === 'pending') entry = { ...base, state: 'pending' };
    else if (l.session && !ap) { const list = versionTodos(project, slug, l); if (list.length && todoProgress(list, r.todos).left) entry = base; }
    if (!entry && asks.length) entry = { ...base, state: 'asked' };
  }
  await withLock(path.dirname(OPEN_INDEX), async () => {
    const ix = readIndex();
    if (entry) ix[id] = entry; else delete ix[id];
    // 顺手清掉一周没动静的会话留下的"等用户"的单子；等 agent 的（答了的审批、提问）留着给新会话接手
    for (const [k, e] of Object.entries(ix)) {
      const seen = sessionSeen(e.session);
      if (seen != null && seen < Date.now() - 7 * DAY && e.state !== 'submitted' && !e.asks?.length) delete ix[k];
    }
    writeIndex(ix);
  });
  return entry;
}

// 同一个会话发了新的审批单：它在这个项目里之前还没答的审批单，标成被取代
export async function supersedeOlder(project, slug, session) {
  if (!session) return [];
  const out = [];
  for (const m of scanAll()) {
    if (m.project !== project || m.slug === slug || latest(m).session !== session || !isOpenApproval(approvalStatus(m))) continue;
    await addClosure(project, m.slug, { v: latest(m).v, how: 'superseded', by: `${project}/${slug}` });
    await syncOpen(project, m.slug); out.push(`${project}/${m.slug}`);
  }
  return out;
}

// 对话里定了：关掉还没答的审批单，网页上随之锁住
export async function closeApproval(project, slug, { note = '', from = '' } = {}) {
  const meta = readMeta(project, slug); if (!meta?.versions?.length) return { ok: false, error: 'no such item' };
  meta.project = project; meta.slug = slug;
  const st = approvalStatus(meta);
  if (!st) return { ok: false, error: 'not an approval' };
  if (!isOpenApproval(st)) return { ok: false, error: 'not open', state: st.state };
  const closure = await addClosure(project, slug, { v: latest(meta).v, how: 'chat', note, from });
  await syncOpen(project, slug);
  return { ok: true, closure };
}
