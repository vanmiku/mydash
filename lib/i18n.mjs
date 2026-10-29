// Interface language. Source strings are English; lib/locales/<lang>.mjs maps them to translations.
// Plurals: 'one form|other form' (picked by vars.n); placeholders: {name}.
// The language is chosen per installation (config.json "lang", or MYDASH_LANG). Pages can override it per device:
// the server runs each request inside withLang(<the device's choice>), so t() there uses that language,
// while the CLI, notifications and agent hooks keep the installation's language.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readConfig } from './store.mjs';
import zh from './locales/zh.mjs';
import { KIND_LABEL } from './kinds.mjs';

const DICTS = { zh };
export const LANGS = ['en', 'zh'];

export function normLang(l) {
  const s = String(l || '').toLowerCase();
  return s.startsWith('zh') ? 'zh' : 'en';
}

let LANG = normLang(process.env.MYDASH_LANG || readConfig().lang || 'en');
const REQ = new AsyncLocalStorage();
export function lang() { return REQ.getStore() || LANG; }
export function setLang(l) { LANG = normLang(l); }
export function defaultLang() { return LANG; }
export function withLang(l, fn) { return REQ.run(normLang(l), fn); }
export function htmlLang() { return lang() === 'zh' ? 'zh-CN' : 'en'; }
export function locale() { const l = lang(); return (l === LANG && readConfig().locale) || (l === 'zh' ? 'zh-CN' : 'en-US'); }

// A key may carry a context after '@@' (e.g. 'Pinned@@state') so one English word can map to two translations.
export function format(str, vars) {
  let s = str.includes('@@') ? str.slice(0, str.indexOf('@@')) : str;
  if (s.includes('|')) { const [one, other] = s.split('|'); s = vars && Number(vars.n) === 1 ? one : other; }
  return vars ? s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all)) : s;
}

export function t(key, vars) {
  const d = DICTS[lang()];
  return format((d && d[key]) || key, vars);
}

// Strings used by the browser: every T('...') literal in the given client files, translated.
export function clientDict(files, l = lang()) {
  const d = DICTS[normLang(l)]; if (!d) return {};
  const out = {};
  for (const f of files) {
    let src = ''; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const k = m[1].replace(/\\'/g, "'");
      if (d[k]) out[k] = d[k];
    }
  }
  return out;
}

export function kindLabel(kind) { return t(KIND_LABEL[kind] || KIND_LABEL.binary); }
