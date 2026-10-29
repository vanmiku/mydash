// 已读状态：存在服务器上，手机和电脑共用。{ "项目/slug": { v: 已读到的版本, at: 时间 } }
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';

const FILE = process.env.MYDASH_READ_FILE || path.join(HOME, 'state', 'read.json');
let MAP = {};
try { MAP = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { MAP = {}; }

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(MAP));
  fs.renameSync(tmp, FILE);
}

export function readMap() { return MAP; }
export function readVersion(id) { return MAP[id]?.v || 0; }

// time：这个版本的发布时间。同一个版本号删掉重发过（时间比上次读的晚），也算没读过
export const seenCurrent = (e, v, time) => (e?.v || 0) > v || ((e?.v || 0) === v && !(time && e.at && e.at < time));
export function markRead(id, v, time) {
  if (!(v > 0)) return false;
  if (seenCurrent(MAP[id], v, time)) return false;
  MAP[id] = { v, at: new Date().toISOString() };
  save(); return true;
}

export function markUnread(id) {
  if (!MAP[id]) return false;
  delete MAP[id]; save(); return true;
}

// items: [{ project, slug, versions }]
export function markAllRead(items) {
  let n = 0; const at = new Date().toISOString();
  for (const m of items) {
    const id = `${m.project}/${m.slug}`; const l = m.versions[m.versions.length - 1];
    if (!seenCurrent(MAP[id], l.v, l.time)) { MAP[id] = { v: l.v, at }; n++; }
  }
  if (n) save();
  return n;
}
