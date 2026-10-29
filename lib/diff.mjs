// 版本对比：按行比较（Myers 算法），改了的行里再按词标出具体改动（中文按字）。
import { t } from './i18n.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 返回 [{ op: '=' | '-' | '+', a?: index, b?: index }]
export function diffSeq(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2); const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) ? v[k + 1 + max] : v[k - 1 + max] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) { x++; y++; }
      v[k + max] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // 回溯出编辑步骤
  const out = []; let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d]; const k = x - y;
    const prevK = (k === -d || (k !== d && vv[k - 1 + max] < vv[k + 1 + max])) ? k + 1 : k - 1;
    const px = vv[prevK + max], py = px - prevK;
    while (x > px && y > py) { out.push({ op: '=', a: --x, b: --y }); }
    if (d > 0) { if (x === px) out.push({ op: '+', b: --y }); else out.push({ op: '-', a: --x }); }
  }
  while (x > 0 && y > 0) out.push({ op: '=', a: --x, b: --y });
  return out.reverse();
}

const tokens = s => String(s).match(/\s+|[㐀-鿿豈-﫿]|[A-Za-z0-9_]+|[^\sA-Za-z0-9_㐀-鿿]/g) || [];
// 一对改动的行：标出词级差异
function inline(oldLine, newLine) {
  const a = tokens(oldLine), b = tokens(newLine);
  if (a.length * b.length > 400_000) return [esc(oldLine), esc(newLine)];
  let o = '', n = '';
  for (const s of diffSeq(a, b)) {
    if (s.op === '=') { o += esc(a[s.a]); n += esc(b[s.b]); }
    else if (s.op === '-') o += `<del>${esc(a[s.a])}</del>`;
    else n += `<ins>${esc(b[s.b])}</ins>`;
  }
  const merge = x => x.replace(/<\/ins><ins>/g, '').replace(/<\/del><del>/g, '');
  return [merge(o), merge(n)];
}

// 渲染对比视图：context 行上下文，其余没变的折叠起来
export function renderDiff(oldText, newText, { fromV, toV, context = 3 } = {}) {
  const A = String(oldText).replace(/\r\n/g, '\n').split('\n'), Bv = String(newText).replace(/\r\n/g, '\n').split('\n');
  if (A.length + Bv.length > 40_000) return { html: `<p class="diff-big">${t('This file is too large to compare.')}</p>`, added: 0, removed: 0 };
  const steps = diffSeq(A, Bv);
  let added = 0, removed = 0;
  const rows = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.op === '=') { rows.push({ k: '=', html: esc(A[s.a]) }); continue; }
    // 一段连续的删除 + 新增：成对的行做词级对比
    const dels = [], adds = [];
    while (i < steps.length && steps[i].op !== '=') { (steps[i].op === '-' ? dels : adds).push(steps[i]); i++; }
    i--;
    removed += dels.length; added += adds.length;
    const pairs = Math.min(dels.length, adds.length);
    for (let j = 0; j < dels.length; j++) rows.push({ k: '-', html: j < pairs ? inline(A[dels[j].a], Bv[adds[j].b])[0] : esc(A[dels[j].a]) });
    for (let j = 0; j < adds.length; j++) rows.push({ k: '+', html: j < pairs ? inline(A[dels[j].a], Bv[adds[j].b])[1] : esc(Bv[adds[j].b]) });
  }
  const near = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.k !== '=') for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) near[j] = true; });
  const line = r => `<div class="dl dl-${r.k === '+' ? 'add' : r.k === '-' ? 'del' : 'eq'}"><span class="dn">${r.k === '=' ? '' : r.k === '+' ? '+' : '−'}</span><span class="dt">${r.html || ' '}</span></div>`;
  let html = ''; let skip = [];
  const flush = () => { if (!skip.length) return; html += `<details class="diff-skip"><summary>${t('{n} unchanged line|{n} unchanged lines', { n: skip.length })}</summary>${skip.map(line).join('')}</details>`; skip = []; };
  rows.forEach((r, i) => { if (near[i]) { flush(); html += line(r); } else skip.push(r); });
  flush();
  if (!added && !removed) html = `<p class="diff-same">${t('No changes in this file between v{a} and v{b}.', { a: fromV, b: toV })}</p>`;
  return { html: `<div class="diff">${html}</div>`, added, removed };
}
