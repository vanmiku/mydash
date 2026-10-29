// 存储布局（运行时目录在 Documents 之外，避免 macOS 隐私保护拦截后台进程）：
//   ~/.mydash/data/<project>/<slug>/meta.json
//   ~/.mydash/data/<project>/<slug>/v<N>/<files...>
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = path.resolve(process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash'));
export const DATA_DIR = path.resolve(process.env.MYDASH_DATA || path.join(HOME, 'data'));
export const CONFIG_PATH = path.join(HOME, 'config.json');
// 这一套安装的标识（按数据目录算）：同一台机器上有多套时，用来确认端口上跑的是不是自己
export const INSTALL_ID = crypto.createHash('sha1').update(path.resolve(HOME)).digest('hex').slice(0, 10);
// meta.json 的格式版本：以后改格式时据此迁移
export const SCHEMA = 1;

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// 改配置（原子写入）：fn 拿到当前配置，返回新配置
export function updateConfig(fn) {
  const next = fn(readConfig());
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  // 可能存着推送的密码和密钥：每次写都只给自己读（rename 换上的是新文件，原来的权限不会留下）
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

export function baseUrl() {
  const c = readConfig();
  const port = process.env.MYDASH_PORT || c.port || 4870;
  return (process.env.MYDASH_BASE_URL || c.baseUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
}

// 访问方式：local（只本机）/ tailscale（系统 Tailscale 转发）/ tailscale-node（独立的 Tailscale 节点）
export function accessMode() {
  const c = readConfig();
  if (c.access) return c.access;
  if (fs.existsSync(path.join(HOME, 'ts', 'tailscaled.sock'))) return 'tailscale-node'; // v0.1 之前的安装没有 access 字段
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl()) ? 'local' : 'tailscale';
}

// 网页类产物（会运行脚本）走独立端口，和工作台不同源
export function contentPort() {
  const c = readConfig();
  return Number(process.env.MYDASH_CONTENT_PORT || c.contentPort || Number(process.env.MYDASH_PORT || c.port || 4870) + 1);
}

// 开了 HTTPS 时，内容端口在 tailnet 上另用一个端口走 HTTPS（默认内容端口 + 1），原来的端口还是 HTTP
export function httpsContentPort() { const c = readConfig(); return Number(c.httpsContentPort || contentPort() + 1); }

// URL 路径段编码（保留可读的 ASCII）
export function encSeg(s) { return encodeURIComponent(s); }
export function encPath(rel) { return rel.split('/').map(encodeURIComponent).join('/'); }

export function itemPath(project, slug) { return `/p/${encSeg(project)}/${encSeg(slug)}`; }
export function projectPath(project) { return `/p/${encSeg(project)}`; }
export function rawPath(project, slug, v, rel = '') {
  return `/f/${encSeg(project)}/${encSeg(slug)}/v${v}/${rel ? encPath(rel) : ''}`;
}

// 项目名 / slug 规范化：只拒绝路径分隔符和隐藏名，不强制 ASCII
export function cleanName(s) {
  return String(s).trim().replace(/[\/\\\s]+/g, '-').replace(/^[.\-]+/, '').replace(/[\x00-\x1f]/g, '').slice(0, 80);
}

export function asciiSlug(s) {
  const out = String(s).normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out;
}

export function itemDir(project, slug) { return path.join(DATA_DIR, project, slug); }

export function readMeta(project, slug) {
  try { return JSON.parse(fs.readFileSync(path.join(itemDir(project, slug), 'meta.json'), 'utf8')); }
  catch { return null; }
}

export async function writeMetaAtomic(dir, meta) {
  const tmp = path.join(dir, `.meta.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fsp.rename(tmp, path.join(dir, 'meta.json'));
}

// 读出全部条目（服务端会缓存）
export function scanAll() {
  const items = [];
  let projects = [];
  try { projects = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch { return items; }
  for (const p of projects) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    let slugs = [];
    try { slugs = fs.readdirSync(path.join(DATA_DIR, p.name), { withFileTypes: true }); } catch { continue; }
    for (const s of slugs) {
      if (!s.isDirectory() || s.name.startsWith('.')) continue;
      const meta = readMeta(p.name, s.name);
      if (!meta || !Array.isArray(meta.versions) || !meta.versions.length) continue;
      meta.project = p.name; meta.slug = s.name;
      items.push(meta);
    }
  }
  items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return items;
}

export function latest(meta) { return meta.versions[meta.versions.length - 1]; }

// 目录锁，防止同一条目被并发改写。name：.lock 管版本和 meta.json（发布、删版本、补预览），.rlock 管 responses.json（勾待办、审批、批注），
// 两把分开：发布转换 Office 文件要几分钟，网页上的勾选和提交不用等它。
// 锁是一个文件（独占创建），里面记着主人「进程号 主机名 随机串」。持锁期间每 15 秒续一次（改 mtime），所以只有持锁的进程没了、
// 或 60 秒没续，才算过期；过期被别人接手后，原来的主人不会误删别人的锁。
// 用文件不用目录：Linux 上服务的递归 fs.watch 看到新目录会去读它，锁目录转眼就删掉时会出错。老版本留下的锁目录照样认（过期就删）
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockOwner = async lock => { try { return await fsp.readFile(lock, 'utf8'); } catch { return ''; } };
export async function withLock(dir, fn, { name = '.lock', waitMs = name === '.lock' ? 600_000 : 10_000 } = {}) {
  const lock = path.join(dir, name);
  const me = `${process.pid} ${os.hostname()} ${crypto.randomBytes(6).toString('hex')}`;
  await fsp.mkdir(dir, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { await fsp.writeFile(lock, me, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EISDIR') throw e;
      try {
        const st = await fsp.stat(lock);
        const [pid, host] = st.isDirectory() ? [] : (await lockOwner(lock)).split(' ');
        const gone = host === os.hostname() && Number(pid) > 0 && !pidAlive(Number(pid));
        if (gone || Date.now() - st.mtimeMs > 60_000) { await fsp.rm(lock, { recursive: true, force: true }); continue; }
      } catch (err) { if (err.code === 'ENOENT') continue; }
      if (Date.now() - start > waitMs) throw new Error('item is locked by another publish, try again shortly: ' + dir);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  const beat = setInterval(() => { const t = new Date(); fs.utimes(lock, t, t, () => {}); }, 15_000); beat.unref?.();
  try { return await fn(); } finally {
    clearInterval(beat);
    if (await lockOwner(lock) === me) await fsp.rm(lock, { force: true });
  }
}

// 版本目录里的一个文件；rel 跳出版本目录（../ 或绝对路径）时返回 null
export function versionFile(dir, v, rel) {
  const root = path.join(dir, `v${v}`); const p = path.resolve(root, '.' + path.sep + String(rel || ''));
  return p.startsWith(root + path.sep) ? p : null;
}

// ---------- 版本之间去重：内容相同的文件用硬链接，不占第二份空间 ----------
// 版本目录发布后就不再改动，所以硬链接是安全的；删掉某个版本时，其他版本的链接不受影响。
export function sha1File(file) {
  const h = crypto.createHash('sha1'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
export const sha1Buf = b => crypto.createHash('sha1').update(b).digest('hex');
// 把 src 链接到 dest（跨卷或不支持时退回复制）；返回 true 表示是链接
export function linkOrCopy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(src, dest); return true; } catch { fs.copyFileSync(src, dest); return false; }
}
export function linkTree(srcDir, destDir) {
  let n = 0;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const a = path.join(srcDir, e.name), b = path.join(destDir, e.name);
    if (e.isDirectory()) n += linkTree(a, b); else { linkOrCopy(a, b); n++; }
  }
  return n;
}
