// 把单个文件渲染成可以直接阅读的 HTML 片段
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { kindOf, extOf, CODE_LANG, VIEWABLE } from './kinds.mjs';
import { rawPath, itemPath } from './store.mjs';
import { t, lang } from './i18n.mjs';
import { renderBlock } from './approval.mjs';
import { Lexer } from 'marked';
import { todoKeyer, todoText, todoCheck, isTodoLang } from './todo.mjs';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// 文本解码：UTF-8 失败时按 GB18030（覆盖 GBK）解
function decodeText(buf) {
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { s = new TextDecoder('gb18030').decode(buf); } catch { s = buf.toString('latin1'); } }
  return s.replace(/^﻿/, '');
}

const MAX_TEXT = 2 * 1024 * 1024;
async function readText(abs, size) {
  const fh = await fsp.open(abs, 'r');
  try {
    const len = Math.min(size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return { text: decodeText(buf), truncated: size > MAX_TEXT };
  } finally { await fh.close(); }
}

// 渲染结果缓存：文件路径 + 修改时间 + 大小
const CACHE = new Map();
function cacheGet(k) { const v = CACHE.get(k); if (v) { CACHE.delete(k); CACHE.set(k, v); } return v; }
function cacheSet(k, v) { CACHE.set(k, v); if (CACHE.size > 160) CACHE.delete(CACHE.keys().next().value); }

export async function renderFile(ctx) {
  // ctx: { abs, rel, project, slug, v, fileSet }
  const st = await fsp.stat(ctx.abs);
  const key = `${ctx.abs}|${st.mtimeMs}|${st.size}|${ctx.v}|${ctx.preview || ''}|${ctx.mode || ''}|${ctx.pages?.dir || ''}|${ctx.pages?.rendered || 0}|${ctx.todo || ''}|${ctx.checks ? 1 : 0}|${lang()}`;
  const hit = cacheGet(key); if (hit) return hit;
  const out = await renderUncached({ ...ctx, size: st.size });
  cacheSet(key, out);
  return out;
}

async function renderUncached(ctx) {
  const kind = kindOf(ctx.rel);
  const raw = rawPath(ctx.project, ctx.slug, ctx.v, ctx.rel);
  const name = esc(path.posix.basename(ctx.rel));
  const R = (html, extra = {}) => ({ kind, html, toc: [], needs: {}, wide: false, ...extra });
  // 发布时已经逐页渲染成图片：直接显示图片，任何浏览器都能看，不依赖 JS
  if (ctx.pages && (kind === 'pdf' || (ctx.preview && ctx.mode !== 'text'))) {
    const pdfRaw = kind === 'pdf' ? raw : rawPath(ctx.project, ctx.slug, ctx.v, ctx.preview);
    return R(pagesView(ctx, pdfRaw), { wide: true, bare: true });
  }
  // Office 文档：默认显示发布时生成的排版预览
  if (ctx.preview && ctx.mode !== 'text') {
    const praw = rawPath(ctx.project, ctx.slug, ctx.v, ctx.preview);
    if (kindOf(ctx.preview) === 'pdf') {
      return R(`<div class="pdf-view" data-src="${esc(praw)}"><p class="pdf-status">${t('Loading the layout preview…')}</p></div>`, { needs: { pdf: true }, wide: true, bare: true });
    }
    return R(`<figure class="shot"><a href="${esc(praw)}" target="_blank" rel="noopener"><img src="${esc(praw)}" alt="${name}"></a><figcaption>${t('Only the first page is available as a preview. Download the original, or export it to PDF and publish that.')}</figcaption></figure>`, { wide: true, bare: true });
  }
  try {
    switch (kind) {
      case 'md': {
        const { text, truncated } = await readText(ctx.abs, ctx.size);
        const r = renderMarkdown(text, ctx);
        if (truncated) r.html += truncNote(raw);
        return R(r.html, { toc: r.toc, needs: { mermaid: r.mermaid, approval: r.approval, todo: r.todos } });
      }
      case 'pdf':
        return R(`<div class="pdf-view" data-src="${esc(raw)}"><p class="pdf-status">${t('Loading PDF…')}</p><noscript><p class="pdf-status"><a href="${esc(raw)}">${t('Open PDF')}</a></p></noscript></div>`, { needs: { pdf: true }, wide: true, bare: true });
      case 'image':
        return R(`<figure class="shot"><a href="${esc(raw)}" target="_blank" rel="noopener"><img src="${esc(raw)}" alt="${name}" decoding="async"></a></figure>`, { wide: true, bare: true });
      case 'html':
        // 网页在独立的内容端口里运行（app.js 填 src），脚本碰不到工作台的接口
        return R(`<div class="frame"><iframe data-src="${esc(raw)}" title="${name}" allow="fullscreen; clipboard-write"></iframe><noscript><p class="pdf-status"><a href="${esc(raw)}">${t('Open original file')}</a></p></noscript></div>`, { wide: true, bare: true });
      case 'video':
        return R(`<video class="media" controls playsinline preload="metadata" src="${esc(raw)}"></video>`, { wide: true, bare: true });
      case 'audio':
        return R(`<div class="audio-wrap"><div class="audio-name">${name}</div><audio controls preload="metadata" src="${esc(raw)}"></audio></div>`);
      case 'table': {
        const { text, truncated } = await readText(ctx.abs, ctx.size);
        const delim = extOf(ctx.rel) === 'tsv' ? '\t' : sniffDelim(text);
        return R(csvTable(parseCsv(text, delim), truncated, raw), { wide: true });
      }
      case 'sheet': return R(await renderSheet(ctx.abs), { wide: true });
      case 'docx': {
        const r = await mammoth.convertToHtml({ path: ctx.abs });
        let html = neutralise(r.value).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
        return R(`<article class="prose docx">${html}</article>`);
      }
      case 'json': {
        const { text, truncated } = await readText(ctx.abs, ctx.size);
        let pretty = text;
        if (!truncated) { try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
        return R(codeBlock(pretty, 'json') + (truncated ? truncNote(raw) : ''), { wide: true });
      }
      case 'code': {
        const { text, truncated } = await readText(ctx.abs, ctx.size);
        const ext = extOf(ctx.rel);
        return R(codeBlock(text, CODE_LANG[ext]) + (truncated ? truncNote(raw) : ''), { wide: true });
      }
      case 'text': {
        const { text, truncated } = await readText(ctx.abs, ctx.size);
        return R(`<pre class="plain">${esc(text)}</pre>` + (truncated ? truncNote(raw) : ''));
      }
      default: return R(binaryCard(ctx, raw));
    }
  } catch (e) {
    return R(`<div class="render-error"><p>${esc(t('This file could not be rendered: {msg}', { msg: e.message }))}</p><p><a href="${esc(raw)}" target="_blank" rel="noopener">${t('Open original file')}</a></p></div>`);
  }
}

function pagesView(ctx, pdfRaw) {
  const pg = ctx.pages; const N = pg.total;
  const figs = pg.sizes.map(([w, h], i) => {
    const n = i + 1;
    const src = rawPath(ctx.project, ctx.slug, ctx.v, `${pg.dir}/p${String(n).padStart(3, '0')}.jpg`);
    return `<figure class="pdf-page img"><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" width="${w}" height="${h}" alt="${esc(t('Page {n}', { n }))}"${i < 2 ? '' : ' loading="lazy"'} decoding="async"></a><span class="pno">${n} / ${N}</span></figure>`;
  }).join('');
  const more = N > pg.rendered ? `<p class="trunc">${t('This PDF has {n} pages; the first {r} are shown here.', { n: N, r: pg.rendered })}<a href="${esc(pdfRaw)}" target="_blank" rel="noopener">${t('Open the full PDF')}</a></p>` : '';
  return `<div class="pdf-view pages"><p class="pdf-status">${t('{n} page|{n} pages', { n: N })} · <a href="${esc(pdfRaw)}" target="_blank" rel="noopener">${t('Open original PDF')}</a></p>${figs}${more}</div>`;
}

function truncNote(raw) {
  return `<p class="trunc">${t('This file is large; only the first 2 MB is shown.')}<a href="${esc(raw)}" target="_blank" rel="noopener">${t('Open original file')}</a></p>`;
}

function binaryCard(ctx, raw) {
  const ext = extOf(ctx.rel).toUpperCase() || t('File');
  const hint = /^(pptx?|ppsx?|key|pages|docx?|rtf|odt|odp|wps)$/i.test(ext) ? t('No layout preview was generated for this document. Download the original, or export it to PDF and publish that.') : t('This format cannot be previewed in the browser.');
  return `<div class="binary"><div class="binary-ext">${esc(ext)}</div><div><p class="binary-name">${esc(path.posix.basename(ctx.rel))} · ${fmtSize(ctx.size)}</p><p>${hint}</p><a class="btn" href="${esc(raw)}" download>${t('Download')}</a></div></div>`;
}

function codeBlock(text, lang) {
  let body;
  if (lang && hljs.getLanguage(lang) && text.length < 600_000) body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  else body = esc(text);
  return `<pre class="code standalone"><code class="hljs${lang ? ` language-${esc(lang)}` : ''}">${body}</code></pre>`;
}

// ---------- Markdown ----------
// 一段 Markdown 直接转成 HTML（终端提问里的计划用）
export function markdownHtml(md) { return renderMarkdown(String(md || ''), { rel: 'plan.md', project: '', slug: '', v: 0, fileSet: new Set() }).html; }

function renderMarkdown(src, ctx) {
  const toc = []; const ids = new Map(); let mermaid = false; let approval = false;
  // 待办（只在主文档里能勾）：ctx.todo 是 'all' 时全文的任务清单都能勾，'blocks' 时只有 ```todo 块里的。key 的顺序和 todo.mjs 的 extractTodos 一致
  const todoKey = todoKeyer(); let todoOn = ctx.todo === 'all'; let todos = 0; let inBlock = false;
  let front = '';
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fm) { front = fm[1]; src = src.slice(fm[0].length); }
  const slugger = (text) => {
    const base = text.toLowerCase().replace(/&[a-z#0-9]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const n = ids.get(base) || 0; ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const marked = new Marked({
    gfm: true,
    renderer: {
      // 正文里的原始 HTML 照常排版，但会运行代码或改掉整页行为的标签原样显示成文字（页面另有 CSP 兜底）
      html({ text }) { return neutralise(String(text).replace(RAW_BAD, m => esc(m))); },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = inner.replace(/<[^>]+>/g, '').trim();
        const id = slugger(plain);
        if (depth <= 3) toc.push({ depth, id, text: plain });
        return `<h${depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      list(token) {
        if (!todoOn || !token.items.some(i => i.task)) return false;
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== 1 && token.start !== '' ? ` start="${token.start}"` : '';
        return `<${tag}${start} class="todo-list">\n${token.items.map(i => this.listitem(i)).join('')}</${tag}>\n`;
      },
      listitem(item) {
        if (!todoOn || !item.task) return false;
        const k = todoKey(todoText(item.text)); todos++;
        // 去掉 marked 自带的禁用勾选框，换成能点的
        const tokens = item.tokens.filter(x => x.type !== 'checkbox').map(x => (x.tokens ? { ...x, tokens: x.tokens.filter(y => y.type !== 'checkbox') } : x));
        // 会自动检测的才标出来，并直接显示要跑的命令（只认明确的待办，见 todo.mjs）
        const check = ctx.checks || inBlock ? todoCheck(item.text) : '';
        const auto = check ? `<span class="todo-auto" title="${esc(t('Ticked automatically when this succeeds: {cmd}', { cmd: check }))}">${t('auto-check')}</span><code class="todo-cmd">${esc(check)}</code>` : '';
        return `<li class="todo-item${check ? ' has-check' : ''}" data-k="${k}"${item.checked ? ' data-src="1"' : ''}><label class="todo-box"><input type="checkbox"${item.checked ? ' checked' : ''} aria-label="${esc(t('Done'))}"><span class="todo-mark"></span></label><div class="todo-body">${this.parser.parse(tokens)}${auto}</div></li>\n`;
      },
      code({ text, lang }) {
        const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
        if (isTodoLang(l)) { const was = todoOn; todoOn = Boolean(ctx.todo); inBlock = true; const inner = this.parser.parse(Lexer.lex(text, { gfm: true })); todoOn = was; inBlock = false; return `<div class="todo-block">${inner}</div>\n`; }
        if (l === 'mermaid') { mermaid = true; return `<div class="mermaid-wrap"><pre class="mermaid">${esc(text)}</pre></div>\n`; }
        if (l === 'approval') { approval = true; return `<div class="ap-block">${renderBlock(text)}</div>\n`; }
        let body;
        if (l && hljs.getLanguage(l)) body = hljs.highlight(text, { language: l, ignoreIllegals: true }).value;
        else body = esc(text);
        return `<pre class="code"${l ? ` data-lang="${esc(l)}"` : ''}><code class="hljs${l ? ` language-${esc(l)}` : ''}">${body}</code></pre>\n`;
      },
    },
  });
  let html = marked.parse(src);
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<img (?![^>]*loading=)/g, '<img loading="lazy" ');
  html = rewriteUrls(neutralise(html), ctx);
  if (front) html = `<details class="frontmatter"><summary>${t('Document properties')}</summary><pre>${esc(front)}</pre></details>` + html;
  return { html: `<article class="prose">${html}</article>`, toc, mermaid, approval, todos };
}

// 原始 HTML 里不放行的标签：脚本、改基准地址、跳转、插件
const RAW_BAD = /<\/?(script|base|meta|link|object|embed|applet|noscript)\b[^>]*>/gi;
// javascript: / vbscript: 链接换成 #（Markdown 链接、原始 HTML、Word 里的超链接都可能带）
export const neutralise = html => String(html).replace(/(\s(?:href|src|action|formaction|xlink:href|poster)\s*=\s*["']?)\s*(?:javascript|vbscript|livescript)\s*:[^"'\s>]*/gi, '$1#');

// 相对链接改写：图片走原文件地址，条目内其它文档在案头里打开
function rewriteUrls(html, ctx) {
  const dir = path.posix.dirname(ctx.rel); const baseDir = dir === '.' ? '' : dir;
  return html.replace(/(\s(src|href|poster)=)"([^"]*)"/g, (all, pre, attr, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (!u || /^[a-z][a-z0-9+.\-]*:/i.test(u) || u.startsWith('#') || u.startsWith('/')) return all;
    const m = u.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
    let p = m[1]; const hash = m[3] || '';
    try { p = decodeURIComponent(p); } catch {}
    const resolved = path.posix.normalize(path.posix.join(baseDir, p));
    if (!resolved || resolved.startsWith('..')) return all;
    const k = kindOf(resolved);
    let target;
    if (attr === 'href' && ctx.fileSet && ctx.fileSet.has(resolved) && VIEWABLE.has(k) && k !== 'image') {
      target = `${itemPath(ctx.project, ctx.slug)}?v=${ctx.v}&f=${encodeURIComponent(resolved)}${hash}`;
    } else {
      target = rawPath(ctx.project, ctx.slug, ctx.v, resolved) + hash;
    }
    return `${pre}"${esc(target)}"`;
  });
}

// ---------- CSV ----------
function sniffDelim(text) {
  const head = text.slice(0, 4000).split('\n').slice(0, 5).join('\n');
  const count = c => (head.match(new RegExp(c === '|' ? '\\|' : c, 'g')) || []).length;
  return [',', ';', '\t', '|'].sort((a, b) => count(b) - count(a))[0];
}

function parseCsv(text, d) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; if (rows.length > 5000) break; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function csvTable(rows, truncated, raw) {
  if (!rows.length) return `<p class="muted">${t('Empty table')}</p>`;
  const LIMIT = 3000;
  const head = rows[0]; const body = rows.slice(1, LIMIT + 1);
  const num = s => /^-?[\d,.]+%?$/.test(String(s).trim());
  const numCol = head.map((_, i) => { const vals = body.slice(0, 200).map(r => r[i] ?? '').filter(v => String(v).trim()); return vals.length > 0 && vals.filter(num).length / vals.length >= 0.8; });
  const th = head.map((h, i) => `<th${numCol[i] ? ' class="num"' : ''}>${esc(h)}</th>`).join('');
  const tb = body.map(r => `<tr>${head.map((_, i) => `<td${numCol[i] ? ' class="num"' : ''}>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
  const more = rows.length - 1 > LIMIT || truncated ? `<p class="trunc">${t('Only the first {n} rows are shown.', { n: LIMIT })}<a href="${esc(raw)}" download>${t('Download the full file')}</a></p>` : '';
  return `<p class="table-info">${t('{n} row|{n} rows', { n: rows.length - 1 })} · ${t('{n} column|{n} columns', { n: head.length })}</p><div class="table-wrap tall"><table class="data"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>${more}`;
}

// ---------- Excel ----------
async function renderSheet(abs) {
  const wb = XLSX.read(await fsp.readFile(abs), { type: 'buffer', sheetRows: 1001, cellDates: true, dense: true });
  const names = wb.SheetNames.slice(0, 15);
  const tabs = names.length > 1 ? `<nav class="sheet-tabs">${names.map((n, i) => `<a href="#sheet-${i}">${esc(n)}</a>`).join('')}</nav>` : '';
  const parts = names.map((n, i) => {
    const tbl = XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }).replace(/<table/, '<table class="data"');
    return `<section class="sheet-part" id="sheet-${i}">${names.length > 1 ? `<h3>${esc(n)}</h3>` : ''}<div class="table-wrap tall">${tbl}</div></section>`;
  }).join('');
  return tabs + parts + (wb.SheetNames.length > 15 ? `<p class="trunc">${t('Only the first {n} sheets are shown.', { n: 15 })}</p>` : '');
}
