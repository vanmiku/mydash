// 文件类型识别：CLI 和服务端共用
import path from 'node:path';

const KIND_BY_EXT = {
  md: 'md', markdown: 'md', mdx: 'md',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', svg: 'image', heic: 'image', ico: 'image',
  html: 'html', htm: 'html',
  csv: 'table', tsv: 'table',
  xlsx: 'sheet', xls: 'sheet', ods: 'sheet', xlsm: 'sheet',
  docx: 'docx',
  doc: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc', wps: 'doc',
  pptx: 'slides', ppt: 'slides', odp: 'slides', key: 'slides', ppsx: 'slides', pps: 'slides',
  numbers: 'sheet',
  json: 'json', geojson: 'json',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  txt: 'text', log: 'text', srt: 'text', vtt: 'text', text: 'text', rst: 'text',
};

// 代码类扩展名 -> highlight.js 语言名
export const CODE_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', env: 'bash',
  xml: 'xml', plist: 'xml', css: 'css', scss: 'scss', less: 'less',
  vue: 'xml', svelte: 'xml', lua: 'lua', r: 'r', dart: 'dart', gd: 'gdscript', tscn: 'ini',
  jsonl: 'json', ndjson: 'json', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile',
};

// English labels; translated with kindLabel() in lib/i18n.mjs
export const KIND_LABEL = {
  md: 'Document', pdf: 'PDF', image: 'Image', html: 'Web page', table: 'Table', sheet: 'Spreadsheet',
  docx: 'Word', doc: 'Text document', slides: 'Slides', json: 'JSON', code: 'Code', text: 'Text', video: 'Video', audio: 'Audio', binary: 'File',
};

export function extOf(p) {
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

export function kindOf(p) {
  const ext = extOf(p);
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (CODE_LANG[ext]) return 'code';
  return 'binary';
}

// 能直接在页面里"看"的类型（用于挑主文件、生成文件标签）
export const VIEWABLE = new Set(['md', 'pdf', 'image', 'html', 'table', 'sheet', 'docx', 'doc', 'slides', 'json', 'code', 'text', 'video', 'audio']);
// 挑主文件时的优先级
export const MAIN_PRIORITY = ['md', 'html', 'pdf', 'docx', 'doc', 'slides', 'sheet', 'table', 'image', 'video', 'json', 'text', 'code', 'audio', 'binary'];

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', wasm: 'application/wasm',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  bcmap: 'application/octet-stream', pfb: 'application/octet-stream',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  webmanifest: 'application/manifest+json',
};

export function mimeOf(p) {
  const ext = extOf(p);
  if (MIME[ext]) return MIME[ext];
  const k = kindOf(p);
  if (k === 'md' || k === 'text' || k === 'code' || k === 'table') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

// 发布时需要转成 PDF 预览的类型（保真排版）
export const OFFICE_CONVERT = new Set(['docx', 'doc', 'slides']);
