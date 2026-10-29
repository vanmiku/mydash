// 全文搜索：每个条目最新版本里能读成文字的文件（Markdown、文本、代码、JSON、表格，网页去掉标签）。
// 文字按条目缓存在内存里，条目更新了才重新读。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, latest } from './store.mjs';
import { kindOf } from './kinds.mjs';

const TEXT_KINDS = new Set(['md', 'text', 'code', 'json', 'table', 'html']);
const cache = new Map();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function decode(buf) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { try { return new TextDecoder('gb18030').decode(buf); } catch { return ''; } } }
function itemText(m) {
  const id = `${m.project}/${m.slug}`; const hit = cache.get(id);
  if (hit && hit.updated === m.updated) return hit;
  const l = latest(m); let text = ''; let budget = 2 * 1024 * 1024;
  for (const f of l.files) {
    if (f.path.startsWith('_') || !TEXT_KINDS.has(kindOf(f.path)) || budget <= 0) continue;
    let s = '';
    try { const fd = fs.openSync(path.join(DATA_DIR, m.project, m.slug, `v${l.v}`, ...f.path.split('/')), 'r'); const buf = Buffer.alloc(Math.min(f.size, 400 * 1024, budget)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); s = decode(buf); } catch { continue; }
    if (kindOf(f.path) === 'html') s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    s = s.replace(/[ \t]+/g, ' ');
    text += `\n${s}`; budget -= s.length;
  }
  const out = { updated: m.updated, text, low: text.toLowerCase() };
  cache.set(id, out);
  return out;
}

// 返回 [{ m, hits, snippet }]：所有词都出现的条目，按出现次数排
export function search(items, q, { limit = 30 } = {}) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(x => x.length >= 1).slice(0, 6);
  if (!terms.length || terms.join('').length < 2) return [];
  const out = [];
  for (const m of items) {
    const it = itemText(m); const hay = it.low;
    if (!terms.every(w => hay.includes(w))) continue;
    let hits = 0; for (const w of terms) { let i = -1; while ((i = hay.indexOf(w, i + 1)) >= 0 && hits < 999) hits++; }
    const at = hay.indexOf(terms[0]);
    const start = Math.max(0, at - 50), end = Math.min(it.text.length, at + terms[0].length + 70);
    let snip = esc(it.text.slice(start, end).replace(/\s+/g, ' '));
    for (const w of terms) snip = snip.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), x => `<mark>${x}</mark>`);
    out.push({ m, hits, snippet: (start > 0 ? '…' : '') + snip + (end < it.text.length ? '…' : '') });
  }
  out.sort((a, b) => b.hits - a.hits || String(b.m.updated).localeCompare(String(a.m.updated)));
  return out.slice(0, limit);
}
