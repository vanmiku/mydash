// mydash publish / rebuild：把文件或目录复制成条目的新版本，生成预览，打印网址
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readConfig, cleanName, asciiSlug, itemDir, readMeta, writeMetaAtomic, withLock, itemPath, scanAll, baseUrl, SCHEMA,
  sha1File, sha1Buf, linkOrCopy,
} from './store.mjs';
import { kindOf, MAIN_PRIORITY } from './kinds.mjs';
import { displayNameOf } from './names.mjs';
import { detectProject, publishCalls, matchAgent, currentSessionId } from './agents.mjs';
import { findSecrets } from './secrets.mjs';
import { makePreviews } from './office.mjs';
import { t, kindLabel } from './i18n.mjs';
import { normCategory, inferCategory, hasApprovalBlock } from './categories.mjs';
import { resolveComments } from './responses.mjs';
import { supersedeOlder, syncOpen } from './waiting.mjs';
import { versionTodos } from './todo.mjs';
import { remoteConfig, remotePublish } from './remote.mjs';

export class UsageError extends Error {}
const fail = msg => { throw new UsageError(msg); };

const SKIP_NAMES = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', '.DS_Store', '.turbo']);

async function walk(dir, base = '') {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(ent.name) || ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...await walk(abs, rel));
    else if (ent.isFile()) out.push({ src: abs, dest: rel });
    else if (ent.isSymbolicLink()) {
      try { const st = await fsp.stat(abs); if (st.isFile()) out.push({ src: abs, dest: rel }); } catch {}
    }
  }
  return out;
}

function expandHome(p) { return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

function uniqueDest(dest, used) {
  if (!used.has(dest)) { used.add(dest); return dest; }
  const ext = path.posix.extname(dest); const stem = dest.slice(0, dest.length - ext.length);
  for (let i = 2; ; i++) { const d = `${stem}-${i}${ext}`; if (!used.has(d)) { used.add(d); return d; } }
}

function relFrom(fromDir, to) { return fromDir ? path.posix.relative(fromDir, to) : to; }

// 收集 Markdown 里引用的本地图片和文件，必要时改写路径
function collectMdRefs(mdText, mdSrcAbs, mdDest, used, extra, seen) {
  const mdDir = path.dirname(mdSrcAbs);
  const destDir = path.posix.dirname(mdDest) === '.' ? '' : path.posix.dirname(mdDest);
  let linked = 0;
  const handle = (rawUrl, isImage) => {
    let url = rawUrl.trim();
    const angle = url.startsWith('<') && url.endsWith('>');
    if (angle) url = url.slice(1, -1);
    if (!url || /^[a-z][a-z0-9+.\-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return null;
    const m = url.match(/^([^?#]*)([?#].*)?$/);
    let p = m[1]; const suffix = m[2] || '';
    try { p = decodeURIComponent(p); } catch {}
    if (!p) return null;
    p = expandHome(p);
    const abs = path.isAbsolute(p) ? p : path.resolve(mdDir, p);
    let st; try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    if (!isImage) { if (st.size > 20 * 1024 * 1024 || linked >= 60) return null; linked++; }
    if (st.size > 100 * 1024 * 1024) return null;
    if (seen.has(abs)) { const d = seen.get(abs); return relFrom(destDir, d) + suffix; }
    const relInside = path.relative(mdDir, abs);
    let dest;
    if (!relInside.startsWith('..') && !path.isAbsolute(relInside)) {
      const cand = path.posix.join(destDir, relInside.split(path.sep).join('/'));
      dest = used.has(cand) ? uniqueDest(`_assets/${path.basename(abs)}`, used) : (used.add(cand), cand);
    } else {
      dest = uniqueDest(`_assets/${path.basename(abs)}`, used);
    }
    seen.set(abs, dest);
    extra.push({ src: abs, dest });
    const newUrl = relFrom(destDir, dest).split('/').map(encodeURIComponent).join('/') + suffix;
    return angle ? `<${newUrl}>` : newUrl;
  };
  // 代码块和行内代码里的写法是示例，不收集、不改写：先换成占位，改完再放回去
  const kept = [];
  const keep = m => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; };
  let text = mdText.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, keep).replace(/(`+)(?:(?!\1)[^\n])+\1/g, keep);
  // 行内链接和图片：[x](url "t") / ![x](url)
  text = text.replace(/(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)/g, (all, bang, label, url) => {
    const r = handle(url, bang === '!');
    return r == null ? all : `${bang}[${label}](${r}`;
  });
  // 引用式定义：[id]: url
  text = text.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)/gm, (all, pre, url) => {
    const r = handle(url, /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(url));
    return r == null ? all : pre + r;
  });
  // HTML 标签：src="..." / href="..."
  text = text.replace(/(\s(src|href)\s*=\s*)(["'])([^"']+)\3/g, (all, pre, attr, q, url) => {
    const r = handle(url, attr === 'src');
    return r == null ? all : `${pre}${q}${r}${q}`;
  });
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

function firstHeading(md) {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const m = body.match(/^#{1,2}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].replace(/[*_`]/g, '').trim() : null;
}

function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : null;
}

function excerptOf(md) {
  const lines = md.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = []; let fence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence || /^\s*#/.test(l) || /^\s*\|/.test(l) || /^\s*<[^>]+>\s*$/.test(l) || /^\s*!\[/.test(l) || /^\s*[-*_]{3,}\s*$/.test(l)) continue;
    const s = l.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>#~]|^\s*[-+]\s+|^\s*\d+\.\s+/g, '').replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
    if (out.join(' ').length > 220) break;
  }
  const s = out.join(' ');
  return s.length > 180 ? s.slice(0, 180) + '…' : s;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

// 返回 true，或者连不上的原因（ECONNREFUSED、超时等），方便排查
export async function serverAlive(ms = 3000) {
  const port = process.env.MYDASH_PORT || readConfig().port || 4870;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(ms) });
    return r.ok || `HTTP ${r.status}`;
  } catch (e) { return e.cause?.code || e.name || e.message; }
}

export function fmtTime(iso) {
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 发布：返回结果对象（CLI 负责打印）。opts 同命令行选项；opts.cwd 可覆盖当前目录（setup 发欢迎条目时用）
export async function publish(pos, opts = {}) {
  if (!pos.length) fail(t('What should be published? Usage: mydash publish <file or folder...>; see mydash --help'));
  const cwd = opts.cwd || process.cwd();
  // 项目按文件夹定义：在 agent 会话里，--project 和会话启动文件夹不一致时以文件夹为准（--force-project 才能强制）
  const detected = opts.detected || detectProject(cwd);
  let project = cleanName(opts['force-project'] || opts.project || detected.name);
  let projectNote = '';
  if (opts.project && !opts['force-project'] && detected.session && cleanName(opts.project) !== cleanName(detected.name)) {
    projectNote = t('Published to {name}, following the rule “project = the folder the session started in”; --project {given} was ignored. Use --force-project if you really mean another project.', { name: detected.name, given: opts.project });
    project = cleanName(detected.name);
  }
  if (!project) fail(t('The project name is empty'));

  const entries = []; // {src} 或 {content}，dest 为条目内的相对路径
  const used = new Set();
  const sources = [];
  const resolveIn = p => path.resolve(cwd, expandHome(p));
  const dirInputs = pos.filter(p => p !== '-' && fs.existsSync(resolveIn(p)) && fs.statSync(resolveIn(p)).isDirectory());
  const singleDir = pos.length === 1 && dirInputs.length === 1;

  for (const input of pos) {
    if (input === '-') {
      const buf = await readStdin();
      const name = opts.name || 'note.md';
      entries.push({ content: buf, dest: uniqueDest(path.basename(name), used), stdinName: name });
      sources.push('(stdin)');
      continue;
    }
    const abs = resolveIn(input);
    let st; try { st = fs.statSync(abs); } catch { fail(t('Not found: {path}', { path: input })); }
    sources.push(abs);
    if (st.isDirectory()) {
      const files = await walk(abs);
      if (!files.length) fail(t('The folder is empty: {path}', { path: input }));
      for (const f of files) {
        const dest = singleDir ? f.dest : `${path.basename(abs)}/${f.dest}`;
        entries.push({ src: f.src, dest: uniqueDest(dest, used) });
      }
    } else if (st.isFile()) {
      entries.push({ src: abs, dest: uniqueDest(path.basename(abs), used) });
    } else fail(t('Not a regular file: {path}', { path: input }));
  }

  // Markdown：带上引用的本地资源
  const extra = []; const seen = new Map();
  for (const e of entries) seen.set(e.src, e.dest);
  for (const e of entries) {
    if (kindOf(e.dest) !== 'md') continue;
    const text = e.content ? e.content.toString('utf8') : fs.readFileSync(e.src, 'utf8');
    const baseAbs = e.src || path.join(cwd, e.stdinName || 'note.md');
    const rewritten = collectMdRefs(text, baseAbs, e.dest, used, extra, seen);
    e.content = Buffer.from(rewritten, 'utf8');
    e.mdText = rewritten;
  }
  entries.push(...extra);

  // 防误发密钥和凭据
  if (!opts['allow-secret']) {
    const hits = findSecrets(entries);
    if (hits.length) fail(t('Refusing to publish; these look like secrets or credentials:') + '\n' + hits.map(h => `  ${h.file}  (${h.reason})`).join('\n') + '\n' + t('Remove them (or the references to them), or add --allow-secret if you are sure.'));
  }

  // 大小限制
  let total = 0;
  for (const e of entries) total += e.content ? e.content.length : fs.statSync(e.src).size;
  if (!opts.force) {
    if (entries.length > 3000) fail(t('Too many files ({n}); add --force if this is intended', { n: entries.length }));
    if (total > 800 * 1024 * 1024) fail(t('Total size {mb} MB is too large; add --force if this is intended', { mb: (total / 1048576).toFixed(0) }));
  }

  // 主文件
  let main = opts.main ? String(opts.main).replace(/^\.\//, '') : null;
  if (main && !entries.some(e => e.dest === main)) {
    const hit = entries.find(e => path.posix.basename(e.dest) === path.basename(main));
    main = hit ? hit.dest : null;
  }
  if (!main) {
    const top = entries.filter(e => !e.dest.startsWith('_assets/'));
    const fileInputs = top.filter(e => (e.src && sources.includes(e.src)) || e.stdinName);
    const depth = e => e.dest.split('/').length;
    const isIndex = e => /(^|\/)(index|readme)\.[a-z]+$/i.test(e.dest) ? 1 : 0;
    const prefer = (list) => {
      if (singleDir) { const idx = list.find(e => e.dest.toLowerCase() === 'index.html'); if (idx) return idx; }
      for (const k of MAIN_PRIORITY) {
        const hits = list.filter(e => kindOf(e.dest) === k);
        if (hits.length) return hits.sort((a, b) => depth(a) - depth(b) || isIndex(b) - isIndex(a))[0];
      }
      return list[0];
    };
    main = (fileInputs[0] || prefer(top) || entries[0]).dest;
  }
  const mainEntry = entries.find(e => e.dest === main);

  // 标题
  let title = opts.title;
  let titleSource = title ? 'flag' : '';
  if (!title && kindOf(main) === 'md') { title = firstHeading(mainEntry.mdText || ''); if (title) titleSource = 'heading'; }
  if (!title && kindOf(main) === 'html') {
    try { title = htmlTitle(mainEntry.content ? mainEntry.content.toString('utf8') : fs.readFileSync(mainEntry.src, 'utf8')); } catch {}
  }
  if (!title) { title = singleDir ? path.basename(resolveIn(pos[0])) : path.posix.basename(main).replace(/\.[^.]+$/, ''); titleSource = 'guess'; }

  // slug
  let slug;
  if (opts.slug) slug = cleanName(opts.slug);
  else {
    const stem = path.posix.basename(singleDir ? resolveIn(pos[0]) : main).replace(/\.[^.]+$/, '');
    if (/^[\x20-\x7e]+$/.test(stem) && asciiSlug(stem).length >= 2) slug = asciiSlug(stem);
    else if (/^[\x20-\x7e]+$/.test(title) && asciiSlug(title).length >= 3) slug = asciiSlug(title);
    else slug = 'x-' + crypto.createHash('sha1').update(project + '|' + (mainEntry.src || title)).digest('hex').slice(0, 8);
  }
  if (!slug) fail(t('The slug is empty; pass one with --slug'));

  if ((opts.type || opts.category) && !normCategory(opts.type || opts.category)) fail(t('--type must be one of: {list}', { list: 'approval, todo, plan, report, other' }));
  const prep = { project, slug, title, titleSource, entries, main, mainMd: mainEntry.mdText || '', sources, cwd, agent: detected.agent || null, session: detected.agent ? currentSessionId() : null, projectNote, host: readConfig().machine || os.hostname() };
  const remote = remoteConfig();
  if (remote && !opts.local) return remotePublish(prep, opts, remote);
  return commitPublish(prep, opts);
}

// 写进数据目录：标题、类型沿用以前的规则，和上一版去重，生成预览，写 meta。
// 远程发布时，服务端收齐文件后也走这里（prep.entries 的 src 指向收到的文件）
export async function commitPublish(prep, opts = {}) {
  const { project, slug, entries, main, sources, cwd, projectNote } = prep;
  let { title, titleSource } = prep;
  const prevMeta = readMeta(project, slug);
  // 再发同一 slug 且没给 --title：手动指定过的标题一直保留；上一版也是取自 Markdown 标题的，才跟着新标题走
  if (titleSource !== 'flag' && prevMeta?.title) {
    const prevSrc = prevMeta.versions[prevMeta.versions.length - 1]?.titleSource;
    if (!(prevSrc === 'heading' && titleSource === 'heading')) { title = prevMeta.title; titleSource = prevSrc || 'flag'; }
  }
  // 类型：--type 指定的一直保留；含审批表单的是审批；否则按标题推断
  let category, categorySource;
  if (opts.type || opts.category) { category = normCategory(opts.type || opts.category); categorySource = 'flag'; } else if (hasApprovalBlock(prep.mainMd)) { category = 'approval'; categorySource = 'form'; }
  else {
    const prevV = prevMeta?.versions[prevMeta.versions.length - 1];
    if (prevV?.categorySource === 'flag') { category = prevV.category; categorySource = 'flag'; }
    else { category = inferCategory({ title, slug, md: prep.mainMd }); categorySource = 'guess'; }
  }
  const dir = itemDir(project, slug);
  const now = new Date().toISOString();
  const excerpt = kindOf(main) === 'md' ? excerptOf(prep.mainMd || '') : '';

  const result = await withLock(dir, async () => {
    const meta = readMeta(project, slug) || { schema: SCHEMA, project, slug, created: now, versions: [] };
    let v = meta.versions.reduce((m, x) => Math.max(m, x.v), 0) + 1;
    while (fs.existsSync(path.join(dir, `v${v}`))) v++;
    const tmp = path.join(dir, `.tmp-v${v}-${process.pid}`);
    // 持着条目锁时没有别人在写版本，之前崩溃留下的 .tmp-v* 都可以清掉
    for (const d of fs.readdirSync(dir)) if (d.startsWith('.tmp-v')) await fsp.rm(path.join(dir, d), { recursive: true, force: true });
    // 和上一版内容相同的文件直接硬链接过来（看路径 + 大小 + sha1）
    const prevVer = meta.versions[meta.versions.length - 1];
    const prevDir = prevVer ? path.join(dir, `v${prevVer.v}`) : null;
    const prevFiles = new Map((prevVer?.files || []).map(f => [f.path, f]));
    const files = []; let linked = 0;
    for (const e of entries) {
      const out = path.join(tmp, ...e.dest.split('/'));
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const size = e.content ? e.content.length : fs.statSync(e.src).size;
      const sha1 = e.content ? sha1Buf(e.content) : sha1File(e.src);
      const pf = prevFiles.get(e.dest); const prevPath = prevDir && path.join(prevDir, ...e.dest.split('/'));
      let reused = false;
      if (pf && pf.size === size && fs.existsSync(prevPath) && (pf.sha1 || sha1File(prevPath)) === sha1) { linkOrCopy(prevPath, out); reused = true; linked++; }
      if (!reused) {
        if (e.content) await fsp.writeFile(out, e.content);
        else await fsp.copyFile(e.src, out, fs.constants.COPYFILE_FICLONE);
      }
      files.push({ path: e.dest, size, kind: kindOf(e.dest), sha1 });
    }
    const conv = await makePreviews(tmp, files, { reuseFrom: prevDir ? { dir: prevDir, files: prevFiles } : null });
    conv.linked = linked;
    await fsp.rename(tmp, path.join(dir, `v${v}`));
    const prev = meta.versions[meta.versions.length - 1];
    meta.versions.push({
      v, time: now, title, titleSource, note: opts.note || '', main, kind: kindOf(main), files,
      sources, excerpt, cwd, host: prep.host || os.hostname(), category, categorySource, ...(prep.agent ? { agent: prep.agent } : {}), ...(prep.session ? { session: prep.session } : {}), ...(prep.remote ? { remote: true } : {}),
    });
    meta.schema = SCHEMA; meta.title = title; meta.updated = now; meta.kind = kindOf(main); meta.category = category;
    await writeMetaAtomic(dir, meta);
    return { v, prev, count: files.length, conv };
  });

  // --resolves：这一版处理了哪些批注
  let resolved = 0;
  if (opts.resolves) {
    const ids = String(opts.resolves).trim() === 'all' ? 'all' : String(opts.resolves).split(',').map(x => x.trim()).filter(Boolean);
    resolved = await resolveComments(project, slug, ids, { v: result.v });
  }
  // 审批单：同一个会话之前没答的审批单被它取代；然后更新"开着的单子"（钩子据此提醒发单的会话）
  const superseded = category === 'approval' ? await supersedeOlder(project, slug, prep.session) : [];
  const open = await syncOpen(project, slug);
  return {
    ok: true, project, slug, version: result.v, resolvedComments: resolved, title, files: result.count, kind: kindOf(main),
    category, url: baseUrl() + itemPath(project, slug), prev: result.prev ? { time: result.prev.time, title: result.prev.title } : null,
    office: result.conv.nOffice, pdfPages: result.conv.nPages, reusedPreviews: result.conv.nReused || 0, unchangedFiles: result.conv.linked || 0, notes: result.conv.notes, projectNote, agent: prep.agent || null,
    superseded, open: open ? open.kind : null, todos: versionTodos(project, slug, readMeta(project, slug)?.versions.at(-1)).length,
  };
}

// 发布后通知服务：开着的页面马上刷新（不依赖文件监听）。连不上就算了，服务自己也会发现
async function notifyServer(project, slug) {
  const port = process.env.MYDASH_PORT || readConfig().port || 4870;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/published`, { method: 'POST', headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ project, slug }), signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function cmdPublish(pos, opts) {
  const r = await publish(pos, opts);
  // 传到别的机器的：那边已经处理好，不用再看本机服务
  const alive = r.remote ? true : await notifyServer(r.project, r.slug) || await serverAlive();
  const up = alive === true;
  if (opts.json) { process.stdout.write(JSON.stringify({ ...r, serverAlive: up }) + '\n'); return; }
  const disp = displayNameOf(r.project);
  const where = disp !== r.project ? t('{name} (folder {folder})', { name: disp, folder: r.project }) : r.project;
  process.stdout.write(t('Published: {where} / {title}  v{v} · {kind} · {n} file|Published: {where} / {title}  v{v} · {kind} · {n} files', { where, title: r.title, v: r.version, kind: kindLabel(r.kind), n: r.files }) + '\n');
  if (r.prev) process.stdout.write(t('This is version {v} of slug “{slug}”; the previous one is from {time}, “{prev}”. If they are not the same thing, publish again with a different --slug.', { v: r.version, slug: r.slug, time: fmtTime(r.prev.time), prev: r.prev.title }) + '\n');
  if (r.remote) process.stdout.write(t('Sent to {url} ({n} file uploaded; the rest were already there).|Sent to {url} ({n} files uploaded; the rest were already there).', { url: r.remote, n: r.uploaded }) + '\n');
  if (r.resolvedComments) process.stdout.write(t('Marked {n} comment as handled.|Marked {n} comments as handled.', { n: r.resolvedComments }) + '\n');
  if (r.office) process.stdout.write(t('Generated layout previews for {n} Office document.|Generated layout previews for {n} Office documents.', { n: r.office }) + '\n');
  if (r.unchangedFiles) process.stdout.write(t('{n} file unchanged since the last version; linked, not copied.|{n} files unchanged since the last version; linked, not copied.', { n: r.unchangedFiles }) + (r.reusedPreviews ? ' ' + t('Reused {n} preview.|Reused {n} previews.', { n: r.reusedPreviews }) : '') + '\n');
  if (r.pdfPages) process.stdout.write(t('Rendered page images for {n} PDF, readable right in the page.|Rendered page images for {n} PDFs, readable right in the page.', { n: r.pdfPages }) + '\n');
  for (const n of r.notes) process.stderr.write(t('Note: {msg}', { msg: n }) + '\n');
  if (r.projectNote) process.stderr.write(t('Note: {msg}', { msg: r.projectNote }) + '\n');
  if (!up) process.stderr.write(t('Tip: the mydash service is not responding, so the page will not open yet. Run mydash doctor to see how to fix it.') + ` (${alive})\n`);
  // 给 agent 的下一步（只有用了审批单、待办才会看到）
  const id = `${r.project}/${r.slug}`;
  if (r.superseded?.length) process.stdout.write(t('Replaced your earlier open approval: {list}', { list: r.superseded.join(', ') }) + '\n');
  if (r.category === 'approval') process.stdout.write(t('This is an approval form. To be woken when the user submits it, run this in the background: mydash approvals wait {id}. If the user answers in the conversation instead, close it: mydash approvals close {id} --note "<what was decided>"', { id }) + '\n');
  else if (r.todos) process.stdout.write(t('The user ticks these to-dos on the page. If they tell you in the conversation that one is done, tick it: mydash todos done {id} "<start of the item>"', { id }) + '\n' + t('If a command can tell whether an item is done, end that item with <!-- check: command -->; mydash runs it every two minutes and ticks the item when it succeeds.') + '\n' + t('The user can ask about any item on the page. To be woken when they do, run this in the background: mydash todos wait {id}', { id }) + '\n');
  process.stdout.write(r.url + '\n');
}

// mydash rebuild --agents：给没记来源的旧版本补上 agent（见 agents.mjs 的说明）
async function rebuildAgents(items, dryRun) {
  const calls = publishCalls();
  const tally = {}; let touched = 0, missing = 0;
  for (const m of items) {
    const dir = itemDir(m.project, m.slug);
    await withLock(dir, async () => {
      const meta = readMeta(m.project, m.slug); if (!meta) return;
      let changed = false;
      for (const ver of meta.versions) {
        if (ver.agent) continue;
        const a = matchAgent(calls, m.slug, ver.time);
        if (!a) { missing++; continue; }
        ver.agent = a; changed = true; tally[a] = (tally[a] || 0) + 1;
      }
      if (changed) { touched++; if (!dryRun) await writeMetaAtomic(dir, meta); }
    });
  }
  const parts = Object.entries(tally).map(([a, n]) => `${a} ${n}`).join(', ') || '0';
  process.stdout.write(t('Found the publishing tool for {found} versions ({parts}) in {n} items; {missing} versions have no match.', { found: Object.values(tally).reduce((x, y) => x + y, 0), parts, n: touched, missing }) + (dryRun ? ' ' + t('(dry run, nothing changed)') : '') + '\n');
}

export async function cmdRebuild(pos, opts = {}) {
  const target = pos[0] || '';
  if (opts.agents) {
    const [pf, sf] = target.split('/');
    return rebuildAgents(scanAll().filter(m => (!pf || m.project === pf) && (!sf || m.slug === sf)), Boolean(opts['dry-run']));
  }
  const [pf, sf] = target.split('/');
  const items = scanAll().filter(m => (!pf || m.project === pf) && (!sf || m.slug === sf));
  let touched = 0;
  for (const m of items) {
    const dir = itemDir(m.project, m.slug);
    await withLock(dir, async () => {
      const meta = readMeta(m.project, m.slug); if (!meta) return;
      let changed = false;
      for (const ver of meta.versions) {
        const vd = path.join(dir, `v${ver.v}`); if (!fs.existsSync(vd)) continue;
        const before = JSON.stringify(ver.files);
        const r = await makePreviews(vd, ver.files, { onlyMissing: true });
        for (const n of r.notes) process.stderr.write(t('Note: {msg}', { msg: `${m.project}/${m.slug} v${ver.v} ${n}` }) + '\n');
        if (JSON.stringify(ver.files) !== before) changed = true;
      }
      if (changed) { await writeMetaAtomic(dir, meta); touched++; process.stdout.write(t('Previews added: {id}', { id: `${m.project}/${m.slug}` }) + '\n'); }
    });
  }
  process.stdout.write(t('Checked {n} items, updated {m}.', { n: items.length, m: touched }) + '\n');
}
