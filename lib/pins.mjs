// 置顶：条目和项目都能置顶，存在服务器上、所有设备同步
// { items: { "项目/slug": 置顶时间 }, projects: { "项目": 置顶时间 } }
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';

const FILE = process.env.MYDASH_PINS_FILE || path.join(HOME, 'state', 'pins.json');
let P = { items: {}, projects: {} };
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); P = { items: j.items || {}, projects: j.projects || {} }; } catch {}

export function pins() { return P; }

export function setPin(kind, id, on) {
  const bag = kind === 'project' ? P.projects : P.items;
  const had = Boolean(bag[id]);
  if (on === had) return false;
  if (on) bag[id] = new Date().toISOString(); else delete bag[id];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(P, null, 2));
  fs.renameSync(tmp, FILE);
  return true;
}
