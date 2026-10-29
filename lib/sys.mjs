// 跨平台的小工具：在 PATH 里找命令（Windows 上按 PATHEXT 找 .exe/.cmd），不依赖 which 命令
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
const EXTS = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(e => e.toLowerCase()) : [''];

export function which(cmd) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of EXTS) {
      const p = path.join(dir.replace(/^"|"$/g, ''), cmd + (ext && !cmd.toLowerCase().endsWith(ext) ? ext : ''));
      try { const st = fs.statSync(p); if (st.isFile() && (IS_WIN || (st.mode & 0o111))) return p; } catch {}
    }
  }
  return null;
}
