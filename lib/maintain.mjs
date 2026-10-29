// 维护：给已有数据去重（rebuild --dedup）、清理旧版本（prune）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { itemDir, readMeta, writeMetaAtomic, withLock, scanAll, readConfig, sha1File, versionFile } from './store.mjs';
import { t } from './i18n.mjs';
import { inferCategory } from './categories.mjs';

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p); else if (e.isFile()) yield p;
  }
}

// 同一条目各个版本之间，内容相同的文件（含预览图）改成硬链接；顺便给 meta 补上 sha1
export async function dedupItems(items, { dryRun = false } = {}) {
  let bytes = 0, count = 0;
  for (const m of items) {
    const dir = itemDir(m.project, m.slug);
    await withLock(dir, async () => {
      const meta = readMeta(m.project, m.slug); if (!meta) return;
      const seen = new Map(); let changed = false;
      for (const ver of meta.versions) {
        const vd = path.join(dir, `v${ver.v}`); if (!fs.existsSync(vd)) continue;
        for (const file of walkFiles(vd)) {
          const st = fs.statSync(file);
          const key = `${st.size}:${sha1File(file)}`;
          const first = seen.get(key);
          if (!first) { seen.set(key, file); continue; }
          const st0 = fs.statSync(first);
          if (st0.ino === st.ino && st0.dev === st.dev) continue; // 已经是同一份
          if (!dryRun) { const tmp = `${file}.dedup-${process.pid}`; try { fs.linkSync(first, tmp); fs.renameSync(tmp, file); } catch { fs.rmSync(tmp, { force: true }); continue; } }
          bytes += st.size; count++;
        }
        for (const f of ver.files) {
          if (f.sha1) continue;
          try { f.sha1 = sha1File(path.join(vd, ...f.path.split('/'))); changed = true; } catch {}
        }
      }
      if (changed && !dryRun) await writeMetaAtomic(dir, meta);
    });
  }
  return { bytes, count };
}

// 每个条目只留最近 keep 个版本；protect(project, slug, v) 为 true 的版本（比如还有没处理的批注）不删
export async function pruneItems(items, keep, { dryRun = false, protect = () => false } = {}) {
  let versions = 0, bytes = 0;
  for (const m of items) {
    if (m.versions.length <= keep) continue;
    const dir = itemDir(m.project, m.slug);
    await withLock(dir, async () => {
      const meta = readMeta(m.project, m.slug); if (!meta || meta.versions.length <= keep) return;
      const keepSet = new Set(meta.versions.slice(-keep).map(x => x.v));
      const drop = meta.versions.filter(x => !keepSet.has(x.v) && !protect(m.project, m.slug, x.v));
      if (!drop.length) return;
      for (const x of drop) {
        const vd = path.join(dir, `v${x.v}`);
        if (fs.existsSync(vd)) for (const f of walkFiles(vd)) { const st = fs.statSync(f); if (st.nlink <= 1) bytes += st.size; }
        if (!dryRun) await fsp.rm(vd, { recursive: true, force: true });
        versions++;
      }
      if (!dryRun) { const gone = new Set(drop.map(x => x.v)); meta.versions = meta.versions.filter(x => !gone.has(x.v)); await writeMetaAtomic(dir, meta); }
    });
  }
  return { versions, bytes };
}

const mb = n => (n / 1048576).toFixed(1);
const pick = target => { const [pf, sf] = String(target || '').split('/'); return scanAll().filter(m => (!pf || m.project === pf) && (!sf || m.slug === sf)); };

export async function cmdDedup(pos, opts) {
  const r = await dedupItems(pick(pos[0]), { dryRun: Boolean(opts['dry-run']) });
  process.stdout.write(t('Linked {n} duplicate files, freeing {mb} MB.', { n: r.count, mb: mb(r.bytes) }) + (opts['dry-run'] ? ' ' + t('(dry run, nothing changed)') : '') + '\n');
}

export async function cmdPrune(pos, opts, protect) {
  const keep = Math.max(1, Number(opts.keep || readConfig().keepVersions || 5));
  const r = await pruneItems(pick(pos[0]), keep, { dryRun: Boolean(opts['dry-run']), protect });
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, keep, removedVersions: r.versions, freedBytes: r.bytes, dryRun: Boolean(opts['dry-run']) }) + '\n'); return; }
  process.stdout.write(t('Kept the latest {keep} versions of each item: removed {n} versions, freeing {mb} MB.', { keep, n: r.versions, mb: mb(r.bytes) }) + (opts['dry-run'] ? ' ' + t('(dry run, nothing changed)') : '') + '\n');
}

// 给没有类型的旧版本推断类型（不覆盖已有的）
export async function cmdCategories(pos, opts) {
  const tally = {}; let n = 0;
  for (const m of pick(pos[0])) {
    const dir = itemDir(m.project, m.slug);
    await withLock(dir, async () => {
      const meta = readMeta(m.project, m.slug); if (!meta) return;
      let changed = false;
      for (const ver of meta.versions) {
        if (ver.category) continue;
        let md = '';
        if (ver.kind === 'md') { try { md = fs.readFileSync(versionFile(dir, ver.v, ver.main), 'utf8'); } catch {} }
        ver.category = inferCategory({ title: ver.title, slug: m.slug, md }); ver.categorySource = 'guess'; changed = true; n++;
        tally[ver.category] = (tally[ver.category] || 0) + 1;
      }
      meta.category = meta.versions[meta.versions.length - 1].category;
      if (changed && !opts['dry-run']) await writeMetaAtomic(dir, meta);
    });
  }
  process.stdout.write(t('Guessed the type of {n} versions: {parts}', { n, parts: Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ') || '0' }) + (opts['dry-run'] ? ' ' + t('(dry run, nothing changed)') : '') + '\n');
}
