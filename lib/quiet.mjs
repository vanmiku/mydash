// 让未读不再失控：
//   静音的项目：里面的条目不算未读、不提醒（照常列出）
//   归档：手动归档的条目，以及超过 N 天还没看的未读条目（config.autoArchiveDays，默认 14，0 关闭），不在列表里显示
// 存在 state/quiet.json：{ muted: { 项目: 时间 }, archived: { "项目/slug": 时间 }, kept: { "项目/slug": 时间 } }（kept = 手动取消归档，不再自动归档）
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readConfig } from './store.mjs';

const FILE = path.join(HOME, 'state', 'quiet.json');
let Q = { muted: {}, archived: {}, kept: {} };
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); Q = { muted: j.muted || {}, archived: j.archived || {}, kept: j.kept || {} }; } catch {}
function save() { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = `${FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(Q, null, 2)); fs.renameSync(tmp, FILE); }

export function quiet() { return Q; }
export const isMuted = project => Boolean(Q.muted[project]);
export function autoArchiveDays() { const d = readConfig().autoArchiveDays; return d === undefined ? 14 : Number(d) || 0; }

export function setMuted(project, on) {
  if (Boolean(Q.muted[project]) === on) return false;
  if (on) Q.muted[project] = new Date().toISOString(); else delete Q.muted[project];
  save(); return true;
}
export function setArchived(id, on) {
  const now = new Date().toISOString();
  if (on) { Q.archived[id] = now; delete Q.kept[id]; } else { delete Q.archived[id]; Q.kept[id] = now; }
  save(); return true;
}
// unread：这个条目对用户来说是不是还没看
export function isArchived(m, unread) {
  const id = `${m.project}/${m.slug}`;
  if (Q.archived[id]) return true;
  const days = autoArchiveDays();
  if (!days || !unread) return false;
  const kept = Q.kept[id];
  if (kept && kept >= m.updated) return false;
  return Date.now() - Date.parse(m.updated) > days * 86400_000;
}
