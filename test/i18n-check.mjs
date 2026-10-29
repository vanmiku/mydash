// 检查译文是否齐全：代码里每个 t('...') / T('...') 的键都要在 lib/locales/zh.mjs 里有翻译；也列出没人用的旧键。
// 用法：node test/i18n-check.mjs [--missing-only]；有缺失时退出码为 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zh from '../lib/locales/zh.mjs';
import { KIND_LABEL } from '../lib/kinds.mjs';
import { CATEGORY_LABEL } from '../lib/categories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...['lib', 'bin'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, d, f))),
  path.join(ROOT, 'server.mjs'), path.join(ROOT, 'static', 'app.js'), path.join(ROOT, 'static', 'pdf-view.mjs'),
];
const used = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b[tT]\(\s*'((?:[^'\\]|\\.)*)'/g)) if (m[1] !== '...') used.set(m[1].replace(/\\'/g, "'"), path.relative(ROOT, f));
}
for (const v of Object.values(KIND_LABEL)) used.set(v, 'lib/kinds.mjs');
for (const v of Object.values(CATEGORY_LABEL)) used.set(v, 'lib/categories.mjs');
const missing = [...used].filter(([k]) => !(k in zh));
const unused = Object.keys(zh).filter(k => !used.has(k));
for (const [k, f] of missing) console.log(`missing  ${f}  ${JSON.stringify(k)}`);
if (!process.argv.includes('--missing-only')) for (const k of unused) console.log(`unused   ${JSON.stringify(k)}`);
console.log(`${used.size} keys used, ${missing.length} missing, ${unused.length} unused`);
process.exit(missing.length ? 1 : 0);
