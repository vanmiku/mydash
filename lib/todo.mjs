// 待办：Markdown 里的任务清单（- [ ] …），用户在网页上勾掉，agent 能读到哪些做完了。
//   · 类型是「待办」的条目：全文所有任务清单都算
//   · 其他条目（比如方案）：只有 ```todo 代码块里的清单算，块里照常写 - [ ] …
// 每条按文字算 key：新版本里文字没变，勾选状态就延续下去。文字重复时按出现顺序加序号。
// 自动检测：某一项末尾写 <!-- check: 命令 -->，命令成功就算做完，mydash 替用户勾上（见 todocheck.mjs）。
//   只认明确的待办：用 --type todo 发布的待办，或 ```todo 块里的。按标题猜出来的待办里写了也不跑（防止抓来的外部内容借它在本机执行命令）。
//   要跑的命令在页面上直接显示出来。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Lexer } from 'marked';
import { itemDir, versionFile } from './store.mjs';

// 这个版本里，任务清单上的 <!-- check: --> 能不能跑：只有用 --type todo 发布的待办（```todo 块里的另算，总是可以）
export const checksAllowed = ver => ver?.category === 'todo' && ver?.categorySource === 'flag';

// 粗筛（真正的解析在 extractTodos 里，缩进在列表里的块也算）
export const hasTodoBlock = md => /(```|~~~)\s*todo\b/i.test(String(md || ''));
export const isTodoLang = lang => /^todo$/i.test(String(lang || '').trim().split(/\s+/)[0]);
// 一条待办的文字：只取第一行（下面可能还有嵌套的清单）
export const todoText = s => String(s).replace(/<!--[\s\S]*?-->/g, '').split('\n')[0].replace(/\s+/g, ' ').trim();
export const CHECK_RE = /<!--\s*check:\s*([\s\S]*?)\s*-->/i;
export const todoCheck = s => (String(s).split(/\n\s*[-*+] /)[0].match(CHECK_RE)?.[1] || '').trim();
export const stripFrontMatter = md => String(md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

export function todoKeyer() {
  const seen = new Map();
  return text => {
    const base = crypto.createHash('sha1').update(todoText(text).toLowerCase()).digest('hex').slice(0, 8);
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  };
}

// 按文档顺序列出待办：[{ key, text, done }]，done 是文档里写的 [x]。顺序和 render.mjs 渲染时一致，key 才对得上
export function extractTodos(md, { all = false } = {}) {
  if (!all && !hasTodoBlock(md)) return [];
  const out = []; const key = todoKeyer();
  const walk = (tokens, on, blk) => {
    for (const tk of tokens || []) {
      if (tk.type === 'code') { if (isTodoLang(tk.lang)) walk(Lexer.lex(tk.text, { gfm: true }), true, true); continue; }
      if (tk.type === 'list') {
        for (const it of tk.items) {
          if (on && it.task) { const text = todoText(it.text); const check = todoCheck(it.text); out.push({ key: key(text), text, done: Boolean(it.checked), ...(check ? { check } : {}), ...(blk ? { block: true } : {}) }); }
          walk(it.tokens, on, blk);
        }
        continue;
      }
      if (tk.tokens) walk(tk.tokens, on, blk);
    }
  };
  walk(Lexer.lex(stripFrontMatter(md), { gfm: true }), all, false);
  return out;
}

// 某个版本的待办（版本发布后不再改，按发布时间缓存；类型会被 rebuild --categories 之类改动，也算进缓存键）
const CACHE = new Map();
export function versionTodos(project, slug, ver) {
  if (!ver || ver.kind !== 'md' || !ver.main) return [];
  const k = `${project}/${slug}/v${ver.v}@${ver.time}|${ver.category || ''}|${ver.categorySource || ''}`;
  if (CACHE.has(k)) return CACHE.get(k);
  let list = [];
  const file = versionFile(itemDir(project, slug), ver.v, ver.main);
  try { list = extractTodos(fs.readFileSync(file, 'utf8'), { all: ver.category === 'todo' }); } catch {}
  // 自动检测只认明确的待办（见文件头）
  const explicit = checksAllowed(ver);
  list = list.map(x => (x.check && !explicit && !x.block ? (({ check, ...rest }) => rest)(x) : x));
  if (CACHE.size > 2000) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, list);
  return list;
}

// 合上用户勾选的状态：{ total, done, left, items: [{ key, text, done }] }
export function todoProgress(list, state = {}) {
  const items = list.map(x => ({ ...x, done: state[x.key] ? Boolean(state[x.key].done) : x.done }));
  const done = items.filter(x => x.done).length;
  return { total: items.length, done, left: items.length - done, items };
}
