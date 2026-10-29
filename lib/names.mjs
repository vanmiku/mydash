// 项目显示名：只影响网页上怎么显示，Claude Code 发布时照常用文件夹名，网址也不变
// { "bm": { "name": "大英博物馆讲解", "at": "..." } }
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';

const FILE = process.env.MYDASH_NAMES_FILE || path.join(HOME, 'state', 'projects.json');
let MAP = {};
try { MAP = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { MAP = {}; }

export function projectNames() { return MAP; }
export function displayNameOf(project) { return MAP[project]?.name || project; }

export function cleanDisplayName(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// name 为空 = 恢复成文件夹名
export function setProjectName(project, name) {
  const n = cleanDisplayName(name);
  const before = MAP[project]?.name || '';
  if (!n || n === project) delete MAP[project];
  else MAP[project] = { name: n, at: new Date().toISOString() };
  if ((MAP[project]?.name || '') === before) return false;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(MAP, null, 2));
  fs.renameSync(tmp, FILE);
  return true;
}
