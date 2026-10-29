// 发布时生成预览：Office 文档转 PDF（LibreOffice），PDF 逐页渲染成 JPEG。
// 逐页渲染：macOS 用 setup 编译的 ~/.mydash/bin/pdfpages（CoreGraphics），Linux 用 poppler 的 pdftoppm；都没有就留给浏览器里的 pdf.js。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// 外部转换程序一律异步跑：服务进程里（远程发布）转换时，页面、推送和钩子照常响应
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HOME, linkOrCopy, linkTree } from './store.mjs';
import { extOf, OFFICE_CONVERT } from './kinds.mjs';
import { t } from './i18n.mjs';
import { which, IS_WIN } from './sys.mjs';


export function findSoffice() {
  // macOS 优先用 setup 准备的无隔离属性副本：/Applications 里的原版在后台直接调用时会被首次启动检查卡住
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(d => path.join(d, 'LibreOffice', 'program', 'soffice.exe'));
  const cands = [process.env.MYDASH_SOFFICE, path.join(HOME, 'lo/LibreOffice.app/Contents/MacOS/soffice'), '/Applications/LibreOffice.app/Contents/MacOS/soffice', ...pf];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return which('soffice') || which('libreoffice');
}

export const PDFPAGES = path.join(HOME, 'bin', 'pdfpages');
export function pageRenderer() {
  if (fs.existsSync(PDFPAGES)) return 'pdfpages';
  if (which('pdftoppm') && which('pdfinfo')) return 'pdftoppm';
  return null;
}

const LO_FONTS_XCU = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lo-fonts.xcu');

async function sofficeToPdf(soffice, input, outDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-lo-'));
  // 中文字体替换表：楷体、宋体、微软雅黑等换成 Noto，否则这些字会被直接丢掉
  try { fs.mkdirSync(path.join(profile, 'user'), { recursive: true }); fs.copyFileSync(LO_FONTS_XCU, path.join(profile, 'user', 'registrymodifications.xcu')); } catch {}
  try {
    await run(soffice, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
      `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', outDir, input],
      { timeout: 120_000, killSignal: 'SIGKILL' });
  } catch { /* 下面按产物是否存在判断 */ } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  const out = path.join(outDir, path.basename(input).replace(/\.[^.]+$/, '') + '.pdf');
  return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : null;
}

// iWork 文件自带首页预览图，转换失败时拿它兜底
async function iworkPreview(input, outFile) {
  if (!which('unzip')) return null;
  for (const name of ['preview.jpg', 'QuickLook/Preview.jpg', 'QuickLook/Thumbnail.jpg']) {
    try {
      const buf = await run('unzip', ['-p', input, name]);
      if (buf.length > 100) { fs.writeFileSync(outFile, buf); return outFile; }
    } catch {}
  }
  return null;
}

// JPEG 尺寸：读 SOFn 段
function jpegSize(file) {
  const b = fs.readFileSync(file);
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1]; const len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}

async function renderWithPdftoppm(pdfAbs, outAbs, width, maxPages) {
  const info = (await run('pdfinfo', [pdfAbs], { timeout: 30_000 })).toString();
  const total = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] || 0);
  if (!total) return null;
  const last = Math.min(total, maxPages);
  fs.mkdirSync(outAbs, { recursive: true });
  await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to-x', String(width), '-scale-to-y', '-1', '-f', '1', '-l', String(last), pdfAbs, path.join(outAbs, 'p')],
    { timeout: 180_000, killSignal: 'SIGKILL' });
  // pdftoppm 按总页数补零（p-1.jpg / p-01.jpg …），统一改名成 p001.jpg
  const items = [];
  for (const f of fs.readdirSync(outAbs)) {
    const m = f.match(/^p-(\d+)\.jpg$/); if (!m) continue;
    const n = Number(m[1]); const name = `p${String(n).padStart(3, '0')}.jpg`;
    fs.renameSync(path.join(outAbs, f), path.join(outAbs, name));
    const size = jpegSize(path.join(outAbs, name)); if (size) items.push({ n, file: name, w: size[0], h: size[1] });
  }
  items.sort((a, b) => a.n - b.n);
  if (!items.length) return null;
  fs.writeFileSync(path.join(outAbs, 'pages.json'), JSON.stringify({ pages: total, rendered: items.length, items }));
  return { total, rendered: items.length, sizes: items.map(x => [x.w, x.h]) };
}

async function renderPages(pdfAbs, outAbs) {
  const r = pageRenderer(); if (!r) return null;
  try {
    fs.rmSync(outAbs, { recursive: true, force: true });
    if (r === 'pdftoppm') return await renderWithPdftoppm(pdfAbs, outAbs, 1600, 150);
    await run(PDFPAGES, [pdfAbs, outAbs, '1600', '150'], { timeout: 180_000, killSignal: 'SIGKILL' });
    const info = JSON.parse(fs.readFileSync(path.join(outAbs, 'pages.json'), 'utf8'));
    if (!info.rendered) return null;
    return { total: info.pages, rendered: info.rendered, sizes: info.items.map(x => [x.w, x.h]) };
  } catch { return null; }
}

// 在版本目录里生成预览，原地写进 files 的条目：
//   Office 文档 → preview: _preview/<路径>.pdf（或 iWork 首页图）
//   PDF（含上面的 Office 预览）→ pages: { dir: _pages/<路径>, total, rendered, sizes }
// reuseFrom：上一版的 { dir, files }。内容（sha1）没变的文件，直接链接上一版的预览，不再重新转换和渲染
export async function makePreviews(verDir, files, { onlyMissing = false, reuseFrom = null } = {}) {
  const notes = []; let nOffice = 0, nPages = 0, nReused = 0;
  const abs = rel => path.join(verDir, ...rel.split('/'));
  const soffice = findSoffice();
  const reused = new Set();
  if (reuseFrom) {
    const pabs = rel => path.join(reuseFrom.dir, ...rel.split('/'));
    for (const f of files) {
      const pf = reuseFrom.files.get(f.path);
      if (!pf || !f.sha1 || pf.sha1 !== f.sha1 || (!pf.preview && !pf.pages)) continue;
      try {
        if (pf.preview && fs.existsSync(pabs(pf.preview))) { linkOrCopy(pabs(pf.preview), abs(pf.preview)); f.preview = pf.preview; }
        if (pf.pages && fs.existsSync(pabs(pf.pages.dir))) { linkTree(pabs(pf.pages.dir), abs(pf.pages.dir)); f.pages = pf.pages; }
        reused.add(f.path); nReused++;
      } catch {}
    }
  }
  for (const f of files) {
    if (f.path.startsWith('_') || !OFFICE_CONVERT.has(f.kind) || reused.has(f.path)) continue;
    if (onlyMissing && f.preview && fs.existsSync(abs(f.preview))) continue;
    const dest = `_preview/${f.path}.pdf`;
    fs.mkdirSync(path.dirname(abs(dest)), { recursive: true });
    let ok = false;
    if (soffice) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-conv-'));
      const pdf = await sofficeToPdf(soffice, abs(f.path), work);
      if (pdf) { fs.copyFileSync(pdf, abs(dest)); f.preview = dest; ok = true; nOffice++; }
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (!ok && ['pages', 'key'].includes(extOf(f.path))) {
      const jpg = `_preview/${f.path}.jpg`;
      if (await iworkPreview(abs(f.path), abs(jpg))) { f.preview = jpg; ok = true; notes.push(t('{file}: only the first-page preview image was available; export it to PDF to publish the full content', { file: f.path })); }
    }
    if (!ok) notes.push(soffice ? t('{file}: converting to a PDF preview failed; the page offers the original file for download', { file: f.path }) : t('{file}: LibreOffice is not installed, so no layout preview (run mydash doctor for how to add it)', { file: f.path }));
  }
  const renderer = pageRenderer();
  for (const f of files) {
    if (f.path.startsWith('_') || reused.has(f.path)) continue;
    const pdfRel = f.kind === 'pdf' ? f.path : (f.preview && f.preview.endsWith('.pdf') ? f.preview : null);
    if (!pdfRel) continue;
    if (onlyMissing && f.pages && fs.existsSync(abs(f.pages.dir))) continue;
    const dir = `_pages/${f.path}`;
    const r = await renderPages(abs(pdfRel), abs(dir));
    if (r) {
      f.pages = { dir, ...r }; nPages++;
      if (r.total > r.rendered) notes.push(t('{file}: {n} pages; the page shows the first {r}, open the original for the rest', { file: f.path, n: r.total, r: r.rendered }));
    } else if (renderer) notes.push(t('{file}: page images were not generated; the page falls back to in-browser rendering', { file: f.path }));
  }
  return { notes, nOffice, nPages, nReused };
}
