// 用户在网页上留给 agent 的回应，存在条目目录的 responses.json：
//   approvals：审批单的答复（每次提交一条，最新的有效）
//   comments： 批注（针对某个版本、可带引用的原文；agent 处理完标记 resolved）
//   todos：    待办的勾选状态，按待办的 key（见 todo.mjs）：{ key: { done, text, v, at, from } }
//   closures： 审批单没在网页上答就结束了：how = chat（对话里定了，agent 关的）/ superseded（同一个会话发了新的审批单）
//   asks：     用户在某一项待办、某一道审批题上「问一下」：{ id, kind: todo | approval, key, label, v, text, at, from, reply: { text, at } | null }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { itemDir, withLock } from './store.mjs';

const fileOf = (p, s) => path.join(itemDir(p, s), 'responses.json');
const EMPTY = () => ({ approvals: [], comments: [], todos: {}, closures: [], asks: [] });

export function readResponses(p, s) {
  try { const r = JSON.parse(fs.readFileSync(fileOf(p, s), 'utf8')); return { approvals: r.approvals || [], comments: r.comments || [], todos: r.todos || {}, closures: r.closures || [], asks: r.asks || [] }; }
  catch { return EMPTY(); }
}
async function update(p, s, fn) {
  return withLock(itemDir(p, s), async () => {
    const r = readResponses(p, s); const out = fn(r);
    const tmp = fileOf(p, s) + `.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(r, null, 2)); await fsp.rename(tmp, fileOf(p, s));
    return out;
  }, { name: '.rlock' });
}
// 短 ID，方便 agent 在命令里引用
const newId = prefix => prefix + crypto.randomBytes(3).toString('hex');
const now = () => new Date().toISOString();

export const addApproval = (p, s, { v, answers, from }) => update(p, s, r => {
  const a = { id: newId('a'), v, answers, submittedAt: now(), from, status: 'submitted' };
  r.approvals.push(a); return a;
});
export const markApprovalDone = (p, s, id, note = '') => update(p, s, r => {
  const a = r.approvals.find(x => x.id === id); if (!a) return null;
  a.status = 'done'; a.doneAt = now(); if (note) a.doneNote = note; return a;
});
// 这个版本最新的一次答复
export function latestApproval(r, v) { return [...r.approvals].reverse().find(x => x.v === v) || null; }

export const addClosure = (p, s, { v, how, note = '', by = '', from = '' }) => update(p, s, r => {
  const c = { v, how, note: String(note).slice(0, 2000), ...(by ? { by } : {}), at: now(), ...(from ? { from } : {}) };
  r.closures.push(c); return c;
});
export const latestClosure = (r, v) => [...(r.closures || [])].reverse().find(x => x.v === v) || null;

export const addComment = (p, s, c) => update(p, s, r => {
  const x = { id: newId('c'), v: c.v, file: c.file || '', quote: String(c.quote || '').slice(0, 1000), heading: String(c.heading || '').slice(0, 200), text: String(c.text || '').slice(0, 5000), createdAt: now(), from: c.from, status: 'open' };
  r.comments.push(x); return r.comments;
});
export const deleteComment = (p, s, id) => update(p, s, r => { r.comments = r.comments.filter(x => !(x.id === id && x.status === 'open')); return r.comments; });
// ids：['c1a2b3', …] 或 'all'；v：处理后的新版本号（可选）
export const resolveComments = (p, s, ids, { v = null, note = '' } = {}) => update(p, s, r => {
  let n = 0;
  for (const x of r.comments) {
    if (x.status !== 'open' || (ids !== 'all' && !ids.includes(x.id))) continue;
    x.status = 'resolved'; x.resolvedAt = now(); if (v) x.resolvedIn = v; if (note) x.note = note; n++;
  }
  return n;
});
export const openComments = r => r.comments.filter(x => x.status === 'open');

export const setTodo = (p, s, key, { done, text, v, from }) => update(p, s, r => {
  r.todos[key] = { done: Boolean(done), text: String(text || '').slice(0, 500), v, at: now(), from };
  return r.todos;
});

// 「问一下」：用户问，agent 用一两句话答（长说明另发文档，回答里放链接）
export const ASK_MAX = 1000, REPLY_MAX = 400;
export const addAsk = (p, s, { kind, key, label, v, text, from }) => update(p, s, r => {
  const a = { id: newId('q'), kind, key, label: String(label || '').slice(0, 200), v, text: String(text).slice(0, ASK_MAX), at: now(), from, reply: null };
  r.asks.push(a); return a;
});
export const replyAsk = (p, s, id, text) => update(p, s, r => {
  const a = r.asks.find(x => x.id === id); if (!a) return null;
  a.reply = { text: String(text).slice(0, REPLY_MAX), at: now() }; return a;
});
export const openAsks = r => (r.asks || []).filter(x => !x.reply);
