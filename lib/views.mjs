// 页面模板
import os from 'node:os';
import crypto from 'node:crypto';
import { esc, fmtSize, markdownHtml } from './render.mjs';
import { kindOf, VIEWABLE } from './kinds.mjs';
import { itemPath, projectPath, rawPath, latest, readConfig, accessMode, contentPort, httpsContentPort } from './store.mjs';
import { t, lang, htmlLang, locale, kindLabel } from './i18n.mjs';
import { agentInfo } from './agents.mjs';
import { CATEGORY_LABEL } from './categories.mjs';
import { latestApproval, openComments } from './responses.mjs';
import { submitLabel } from './approval.mjs';
import { todoProgress } from './todo.mjs';
import { approvalStatus } from './waiting.mjs';
import { allPrompts, promptTitle } from './prompts.mjs';
import { isMuted, isArchived, autoArchiveDays } from './quiet.mjs';
import { publicChannel } from './notify.mjs';
import { pushGuide, webpushGuide } from './pushguide.mjs';
import { status as updateStatus } from './update.mjs';

const CFG = readConfig();
// 这台机器自己的名字：别的机器传来的条目才标出机器名
const THIS_HOST = new Set([os.hostname(), CFG.machine].filter(Boolean));
const hostTag = h => (h && !THIS_HOST.has(h) ? `<span class="host-tag" title="${esc(t('Published from {host}', { host: h }))}">${ICON.server}${esc(h)}</span>` : '');

// ---------- 数据源（由服务端注入）----------
let NAV = () => [];                 // 全部条目
let READ = () => ({});              // 已读：{ "项目/slug": { v } }
let NAMES = () => ({});             // 项目显示名：{ 项目: { name } }
let PINS = () => ({ items: {}, projects: {} });
let RESP = () => ({ approvals: [], comments: [] });  // 条目的审批答复和批注
export function setResponsesSource(fn) { RESP = fn; }
let TODOS = () => [];                // 条目最新版本里的待办（todo.mjs 的 versionTodos）
export function setTodosSource(fn) { TODOS = fn; }
export function setNavSource(fn) { NAV = fn; }
export function setReadSource(fn) { READ = fn; }
export function setNamesSource(fn) { NAMES = fn; }
export function setPinsSource(fn) { PINS = fn; }

let BUILD = '1';
export function setBuild(b) { BUILD = b; }

export function dname(project) { return NAMES()[project]?.name || project; }
const idOf = m => `${m.project}/${m.slug}`;

// 静音项目里的条目不算未读；归档的也不算
// 审批单、待办（类型）不进时间线、不算未读、不自动归档：它们在最上面的「等你处理」里，结束了进「处理记录」
const isAction = m => ['approval', 'todo'].includes(latest(m).category || m.category);
export function readState(m, map = READ()) {
  const e = map[idOf(m)]; const l = latest(m);
  const v = l.v;
  // 读过的版本被删掉、又用同一个版本号重发：按没读过算（读的时间早于这一版的发布时间）
  const seen = e?.v === v && e.at && l.time && e.at < l.time ? v - 1 : e?.v || 0;
  const action = isAction(m);
  const raw = seen < v && !action;
  const archived = isArchived(m, raw);
  const quiet = archived || isMuted(m.project);
  return { unread: raw && !quiet, seen, updated: !quiet && !action && seen > 0 && seen < v, archived, muted: isMuted(m.project) };
}
function unreadCount(items, map = READ()) { let n = 0; for (const m of items) if (readState(m, map).unread) n++; return n; }
// 列表默认不显示归档的；?archived=1 只看归档的
function splitArchived(items, showArchived) {
  const map = READ(); const live = [], arch = [];
  for (const m of items) if (!isAction(m)) (readState(m, map).archived ? arch : live).push(m);
  return { shown: showArchived ? arch : live, archivedCount: arch.length };
}
function archivedNote(n, showArchived, base) {
  if (showArchived) return `<p class="arch-note"><a href="${esc(base)}">${t('Back to the list')}</a></p>`;
  if (!n) return '';
  const days = autoArchiveDays();
  return `<p class="arch-note">${t('{n} archived item|{n} archived items', { n })}${days ? ` · ${t('unread items older than {d} days are archived automatically', { d: days })}` : ''} · <a href="${esc(base)}?archived=1">${t('Show')}</a></p>`;
}
const isPinnedItem = m => Boolean(PINS().items[idOf(m)]);
const isPinnedProject = p => Boolean(PINS().projects[p]);

// ---------- 图标 ----------
const svg = (d, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const PIN_D = '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>';
export const ICON = {
  pin: svg(PIN_D, 'pin'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  all: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  ext: svg('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  down: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  dot: svg('<circle cx="12" cy="12" r="4"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>'),
  expand: svg('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  up: svg('<path d="m7 14 5-5 5 5"/>'),
  inbox: svg('<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>'),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 'i-light'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>', 'i-dark'),
  auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>', 'i-auto'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'i-check'),
  upd: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>', 'i-upd'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M3 15h18M9.5 9.5V20"/>'),
  slides: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>'),
  play: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m10 9 5 3-5 3z"/>'),
  code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  comment: svg('<path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5h-1A1.5 1.5 0 0 1 3 16V7a1.5 1.5 0 0 1 1.5-1.5z"/>', 'i-comment'),
  stamp: svg('<path d="M9 4h6l-1 6h3.5a1.5 1.5 0 0 1 1.5 1.5V14H5v-2.5A1.5 1.5 0 0 1 6.5 10H10z"/><path d="M5 17h14M7 20h10"/>', 'i-stamp'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>', 'i-todo'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 'i-gear'),
  inbox2: svg('<path d="M4 13.5 6.5 5h11l2.5 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20"/>', 'i-inbox2'),
  spark: svg('<path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18"/>', 'i-spark'),
  term: svg('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>', 'i-term'),
  chatgpt: svg('<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>', 'i-chatgpt'),
  bot: svg('<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4.5V8M9.5 13.2v.6M14.5 13.2v.6"/>', 'i-bot'),
  printer: svg('<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6H7z"/>'),
  server: svg('<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>', 'i-server'),
  devices: svg('<rect x="2.5" y="5" width="13" height="9.5" rx="1.8"/><path d="M1.5 17.5h15"/><rect x="16.5" y="9" width="6" height="11" rx="1.6"/>'),
};
// 项目页里每条都属于同一个项目，头像换成类型图标
const KIND_ICON = { md: 'doc', text: 'doc', docx: 'doc', doc: 'doc', pdf: 'doc', image: 'image', html: 'globe', table: 'table', sheet: 'table', slides: 'slides', video: 'play', audio: 'play', json: 'code', code: 'code', binary: 'doc' };
// 会运行脚本的文件（网页、SVG）只从独立的内容端口打开，不和工作台同源
export const ACTIVE_RE = /\.(html?|xhtml|svg)$/i;
function kindTile(kind) { return `<span class="kind-tile k-${esc(kind)}" aria-hidden="true">${ICON[KIND_ICON[kind] || 'doc']}</span>`; }
export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent-solid, var(--accent))"/><path d="M8.5 22v-7.2a3.3 3.3 0 0 1 6.6 0V22m0-7.2a3.3 3.3 0 0 1 6.6 0V22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24.6" cy="8.2" r="2.3" fill="var(--unread)"/></svg>`;

// ---------- 项目头像：字取显示名，色相按文件夹名（改名不变色）----------
const HUES = [8, 24, 40, 88, 140, 165, 188, 205, 222, 240, 262, 285, 310, 335];
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function avText(name) {
  const first = [...name][0] || '?';
  if (/\p{Script=Han}/u.test(first)) return first;
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  // 中英混排（如「Acme 官网」）只取拉丁字母，不拼成「A官」
  const second = parts[1] && /\p{Script=Han}/u.test(parts[1][0]) ? '' : parts[1]?.[0] || '';
  const s = parts.length >= 2 ? parts[0][0] + second : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  return (s || first).toUpperCase();
}
export function avatar(project, cls = '') {
  return `<span class="av ${cls}" style="--h:${HUES[hash(project) % HUES.length]}" aria-hidden="true">${esc(avText(dname(project)))}</span>`;
}

function pinButton(kind, id, on, { label = false, small = false } = {}) {
  const text = kind === 'project' ? (on ? t('Unpin project') : t('Pin project')) : (on ? t('Unpin') : t('Pin'));
  return `<button type="button" class="pin-btn${label ? ' label' : ''}${small ? ' sm' : ''}${on ? ' on' : ''}" data-pin="${kind}" data-id="${esc(id)}" aria-pressed="${on}" title="${text}" aria-label="${text}">${ICON.pin}${label ? `<span>${on ? t('Pinned@@state') : t('Pin')}</span>` : ''}</button>`;
}

// ---------- 时间：按配置的时区（config.timezone，服务器常是 UTC）和界面语言 ----------
const pad = n => String(n).padStart(2, '0');
const TZ = CFG.timezone || undefined;
const PARTS = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' });
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parts(x) {
  const o = {}; for (const p of PARTS.formatToParts(new Date(x))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute, wd: WD.indexOf(o.weekday) };
}
export function hm(iso) { const p = parts(iso); return `${pad(p.H)}:${pad(p.M)}`; }
export function fullTime(iso) { const p = parts(iso); return `${p.y}-${pad(p.m)}-${pad(p.d)} ${hm(iso)}`; }
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
function shortDate(iso) {
  const p = parts(iso), now = parts(Date.now());
  if (sameDay(p, now)) return hm(iso);
  return new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', month: 'numeric', day: 'numeric', ...(p.y !== now.y ? { year: 'numeric' } : {}) }).format(Date.UTC(p.y, p.m - 1, p.d, 12));
}
function dayKey(iso) { const p = parts(iso); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
const ZH_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dateText(y, m, d, withYear) {
  if (lang() === 'zh') return `${withYear ? y + '年' : ''}${m}月${d}日 ${ZH_WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
  return new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(Date.UTC(y, m - 1, d, 12));
}
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const now = parts(Date.now());
  const diff = Math.round((Date.UTC(now.y, now.m - 1, now.d) - Date.UTC(y, m - 1, d)) / 86400000);
  const date = dateText(y, m, d, y !== now.y);
  const name = diff === 0 ? t('Today') : diff === 1 ? t('Yesterday') : diff === 2 && lang() === 'zh' ? '前天' : null;
  return { name: name || date, sub: name ? date : '' };
}
// 页脚的访问范围说明
function reachNote() {
  if (CFG.lan) return accessMode() === 'local' ? t('This computer, and this Wi-Fi with the access code') : t('Your tailnet, and this Wi-Fi with the access code');
  return accessMode() === 'local' ? t('Only this computer can open this page') : t('Only devices on your tailnet can open this page');
}
const shortHome = p => String(p).replace(os.homedir(), '~').replace(/^\/(Users|home)\/[^/]+/, '~');
// ---------- 来源 agent：列表里头像右下角的小标，条目页写全名，可按 agent 筛选 ----------
const agentCls = id => (agentInfo(id)?.known ? id : 'other');
function agentIcon(id) { return id === 'claude' ? ICON.spark : id === 'codex' ? ICON.chatgpt : ICON.bot; }
function agentBadge(id) {
  const a = agentInfo(id); if (!a) return '';
  return `<i class="ag-badge ag-${agentCls(id)}" title="${esc(t('Published by {agent}', { agent: a.name }))}">${agentIcon(a.known ? id : '')}</i>`;
}
function agentTag(id, full = false, iconOnly = false) {
  const a = agentInfo(id); if (!a) return '';
  const title = esc(t('Published by {agent}', { agent: a.name }));
  return `<span class="agent ag-${agentCls(id)}" title="${title}"${iconOnly ? ` aria-label="${title}"` : ''}>${agentIcon(a.known ? id : '')}${iconOnly ? '' : `<span>${esc(full ? a.name : a.short)}</span>`}</span>`;
}

// ---------- 边栏 ----------
export function projectSummary(items) {
  const map = new Map();
  for (const m of items) {
    const p = map.get(m.project) || { name: m.project, count: 0, updated: m.updated };
    if (!isAction(m)) p.count++;
    if (m.updated > p.updated) p.updated = m.updated; map.set(m.project, p);
  }
  return [...map.values()].sort((a, b) => b.updated.localeCompare(a.updated));
}

export function sidebar(current = '') {
  const items = NAV();
  const projects = projectSummary(items);
  const map = READ();
  const unreadBy = new Map(); let unreadAll = 0;
  for (const m of items) if (readState(m, map).unread) { unreadBy.set(m.project, (unreadBy.get(m.project) || 0) + 1); unreadAll++; }
  const row = p => {
    const dn = dname(p.name); const u = unreadBy.get(p.name) || 0; const pinned = isPinnedProject(p.name);
    return `<div class="side-row" data-name="${esc(dn.toLowerCase())}" data-search="${esc((dn + ' ' + p.name).toLowerCase())}" data-updated="${esc(p.updated)}" data-pinned="${pinned ? 1 : 0}">
<a class="side-proj${p.name === current ? ' on' : ''}" href="${esc(projectPath(p.name))}"${p.name === current ? ' aria-current="page"' : ''} title="${esc(dn !== p.name ? `${dn} · ${t('Folder: {name}', { name: p.name })}` : dn)}">${avatar(p.name)}<span class="side-name">${esc(dn)}</span>${u ? `<b class="side-unread" title="${esc(t('{n} unread', { n: u }))}">${u}</b>` : ''}<em>${p.count}</em></a>${pinButton('project', p.name, pinned, { small: true })}</div>`;
  };
  const pinnedRows = projects.filter(p => isPinnedProject(p.name));
  const restRows = projects.filter(p => !isPinnedProject(p.name));
  return `<aside id="side" class="side" aria-label="${t('Project list')}" data-unread="${unreadAll}">
  <div class="side-top">
    <a class="brand" href="/" aria-label="${t('mydash home')}">${LOGO}<span class="brand-name">mydash</span></a>
    <span class="side-title">${t('Switch project')}</span>
    <button type="button" class="side-collapse" aria-label="${t('Collapse sidebar')}" title="${t('Collapse sidebar (shortcut: [)')}">${ICON.panel}</button>
    <button type="button" class="side-close" aria-label="${t('Close project list')}">${ICON.close}</button>
  </div>
  <a class="side-all${current ? '' : ' on'}" href="/"${current ? '' : ' aria-current="page"'} title="${t('All items')}"><span class="side-all-ico">${ICON.all}</span><span class="side-name">${t('All items')}</span>${unreadAll ? `<b class="side-unread" title="${esc(t('{n} unread', { n: unreadAll }))}">${unreadAll}</b>` : ''}<em>${items.length}</em></a>
  ${projects.length > 6 ? `<label class="side-filter">${ICON.search}<input id="pf" type="search" placeholder="${t('Filter projects')}" autocomplete="off" enterkeyhint="search"></label>` : ''}
  <div class="side-group" data-group="pinned"${pinnedRows.length ? '' : ' hidden'}>
    <div class="side-head"><span>${ICON.pin}${t('Pinned')}</span></div>
    <div class="side-list pinned">${pinnedRows.map(row).join('')}</div>
  </div>
  <div class="side-group" data-group="rest">
    <div class="side-head"><span>${t('Projects · {n}', { n: projects.length })}</span><span class="side-sort" role="group" aria-label="${t('Sort')}"><button type="button" data-sort="recent" class="on">${t('Recent')}</button><button type="button" data-sort="name">${t('Name')}</button></span></div>
    <div class="side-list rest">${restRows.map(row).join('') || (projects.length ? '' : `<p class="side-none">${t('No projects yet')}</p>`)}</div>
  </div>
  <p class="side-none side-nomatch" hidden>${t('No matching projects')}</p>
  <div class="side-foot"><span class="live" title="${t('Live updates')}"><i></i></span><button type="button" class="reach-btn" title="${esc(reachNote())}">${ICON.devices}<span>${t('Open on another device')}</span></button></div>
</aside>`;
}

// ---------- 外观：自动 / 浅色 / 深色 ----------
// 自动：晚上 NIGHT[0] 点到早上 NIGHT[1] 点用深色；系统本身是深色时也用深色。
// 在 <head> 里同步执行，首屏就是对的颜色，不会先白一下再变黑。app.js 切换时也调它。
export const NIGHT = [19, 7];
const THEME_JS = `window.mydashTheme=function(m){var d=document.documentElement;if(!m){try{m=localStorage.getItem('mydash.theme')}catch(e){}}if(m!=='light'&&m!=='dark')m='auto';var h=new Date().getHours(),t=m!=='auto'?m:(h>=${NIGHT[0]}||h<${NIGHT[1]}||matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';d.dataset.theme=t;d.dataset.themeMode=m;var a=document.getElementById('hl-light'),b=document.getElementById('hl-dark'),c=document.querySelector('meta[name=theme-color]');if(a)a.media=t==='dark'?'not all':'all';if(b)b.media=t==='dark'?'all':'not all';if(c)c.content=t==='dark'?'#0d0d10':'#f6f6f7';return t};mydashTheme();`;
// 页面里的内联脚本只有这两段（首屏配色、边栏收起状态）。CSP 只放行它们的哈希和本站的脚本文件：
// 产物正文（Markdown、Word）里夹带的脚本、事件属性、javascript: 链接在工作台上一律不运行
const HEAD_JS = `${THEME_JS}try{if(localStorage.getItem('mydash.side')==='collapsed')document.documentElement.classList.add('side-collapsed')}catch(e){}`;
const sha256 = s => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
export const PAGE_CSP = `script-src 'self' ${sha256(HEAD_JS)} ${sha256(THEME_JS)}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
function themeMenu() {
  const opt = (mode, icon, name, sub = '') => `<button type="button" role="menuitemradio" aria-checked="false" data-theme-set="${mode}">${icon}<span class="tm-text"><b>${name}</b>${sub ? `<small>${sub}</small>` : ''}</span>${ICON.check}</button>`;
  return `<div class="theme">
      <button type="button" class="theme-btn" aria-haspopup="true" aria-expanded="false" aria-controls="theme-menu" aria-label="${t('Appearance')}" title="${t('Appearance: auto / light / dark')}">${ICON.auto}${ICON.sun}${ICON.moon}</button>
      <div class="theme-menu" id="theme-menu" role="menu" aria-label="${t('Appearance')}" hidden>
        <p class="tm-h">${t('Appearance')}</p>
        ${opt('auto', ICON.auto, t('Auto'), t('Dark from {a}:00 to {b}:00, or whenever the system is dark', { a: pad(NIGHT[0]), b: pad(NIGHT[1]) }))}
        ${opt('light', ICON.sun, t('Light'))}
        ${opt('dark', ICON.moon, t('Dark'))}
      </div>
    </div>`;
}

// ---------- 整体框架 ----------
export function layout({ title, body, page, crumbs = [], data = {}, head = '' }) {
  const dataAttrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const crumbHtml = crumbs.map(c => c.href ? `<a href="${esc(c.href)}">${esc(c.text)}</a>` : `<span>${esc(c.text)}</span>`).join('<i>/</i>');
  return `<!doctype html>
<html lang="${htmlLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f6f7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="mydash">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>${(() => { const n = unreadCount(NAV()); return n ? `(${n}) ` : ''; })()}${esc(title)}</title>
<meta name="mydash-title" content="${esc(title)}">
<meta name="mydash-content-port" content="${contentPort()}" data-https-port="${httpsContentPort()}"${CFG.contentOrigin ? ` data-origin="${esc(CFG.contentOrigin)}"` : ''}>
<link rel="manifest" href="/manifest.webmanifest?b=${BUILD}">
<link rel="icon" href="/favicon.ico?b=${BUILD}" sizes="32x32">
<link rel="icon" href="/static/icon.svg?b=${BUILD}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-180.png?b=${BUILD}">
<link rel="preload" href="/static/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" id="hl-light" href="/vendor/hljs/github.min.css">
<link rel="stylesheet" id="hl-dark" href="/vendor/hljs/github-dark.min.css" media="not all">
<link rel="stylesheet" href="/static/app.css?b=${BUILD}">
<script>${HEAD_JS}</script>
${head}
</head>
<body class="page-${page}"${dataAttrs}>
<div class="app">
${sidebar(data.project || '')}
<div class="side-mask"></div>
<div class="col">
  <header class="topbar">
    <button type="button" class="side-toggle" aria-label="${t('Project list')}" aria-controls="side" aria-expanded="false">${ICON.menu}</button>
    <a class="brand brand-m" href="/" aria-label="${t('mydash home')}">${LOGO}<span class="brand-name">mydash</span></a>
    <nav class="crumbs" aria-label="${t('Breadcrumb')}"><a href="/">mydash</a>${crumbHtml ? '<i>/</i>' + crumbHtml : ''}</nav>
    <button type="button" class="lang-btn" data-lang="${lang() === 'zh' ? 'en' : 'zh'}" title="${t('Language on this device')}" aria-label="${lang() === 'zh' ? 'Switch to English' : '切换到中文'}">${lang() === 'zh' ? 'EN' : '中'}</button>
    <a class="set-link${page === 'settings' ? ' on' : ''}" href="/settings" aria-label="${t('Settings')}" title="${t('Settings')}">${ICON.gear}</a>
    ${themeMenu()}
  </header>
  <main id="main">
${body}
  </main>
  <footer class="foot"><span>${t('mydash · deliverables from Claude Code and Codex')}</span><span>${reachNote()}</span></footer>
</div>
</div>
<nav class="tabbar" aria-label="${t('Quick switch')}">
  <a class="tb-item tb-all${page === 'home' ? ' on' : ''}" href="/?show=all">${ICON.all}<span>${t('All')}</span></a>
  <button type="button" class="tb-item tb-proj${data.project ? ' on' : ''}" aria-controls="side" aria-expanded="false" aria-label="${t('Switch project')}">${data.project ? avatar(data.project, 'sm') : ICON.folder}<span class="tb-proj-name">${esc(data.project ? dname(data.project) : t('Projects@@tab'))}</span>${ICON.up}</button>
  <a class="tb-item tb-unread" href="/?show=unread">${ICON.inbox}<span>${t('Unread')}</span>${(() => { const n = unreadCount(NAV()); return `<b class="tb-badge"${n ? '' : ' hidden'}>${n}</b>`; })()}</a>
</nav>
<div class="toast" role="status" aria-live="polite"></div>
<script src="/i18n.js?l=${lang()}&b=${BUILD}"></script>
<script src="/static/app.js?b=${BUILD}" defer></script>
</body>
</html>`;
}

// ---------- 列表 ----------
function thumbOf(m) {
  const l = latest(m);
  const mainFile = l.files.find(f => f.path === l.main);
  if (l.kind === 'image') return { src: rawPath(m.project, m.slug, l.v, l.main), doc: false };
  if (mainFile?.pages) return { src: rawPath(m.project, m.slug, l.v, `${mainFile.pages.dir}/p001.jpg`), doc: true };
  return null;
}
function searchText(m) {
  const l = latest(m);
  return [m.title, m.project, dname(m.project), m.slug, l.note, l.excerpt, kindLabel(l.kind), catLabel(catOf(m)), agentInfo(l.agent)?.name || ''].join(' ').toLowerCase();
}

function entry(m, i, { showProject = true } = {}) {
  const l = latest(m);
  const files = l.files.length;
  const ex = l.note || l.excerpt || '';
  const th = thumbOf(m);
  const thumb = th ? `<img class="entry-thumb${th.doc ? ' doc' : ''}" src="${esc(th.src)}" alt="" loading="lazy" decoding="async">` : '';
  const rs = readState(m);
  const pinned = isPinnedItem(m);
  const cls = ['entry', rs.unread ? 'unread' : '', pinned ? 'pinned' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}" data-id="${esc(idOf(m))}" data-search="${esc(searchText(m))}" data-unread="${rs.unread ? 1 : 0}" data-agent="${esc(agentFilterKey(l.agent))}" data-cat="${catOf(m)}" style="--i:${Math.min(i, 18)}">
  <a class="entry-link" href="${esc(itemPath(m.project, m.slug))}">
    <span class="entry-av">${showProject ? avatar(m.project) : kindTile(l.kind)}${rs.unread ? `<i class="unread-dot" aria-label="${t('Unread')}"></i>` : ''}${agentBadge(l.agent)}</span>
    <div class="entry-body">
      <div class="entry-title"><span class="entry-title-text">${esc(m.title)}</span>${l.v > 1 ? `<span class="ver">v${l.v}</span>` : ''}${rs.updated ? `<span class="new-ver">${t('New version')}</span>` : ''}${apPill(m)}${tdPill(m)}${cmPill(m)}</div>
      <div class="entry-meta" data-time="${hm(m.updated)}">${showProject ? `<span class="entry-proj">${esc(dname(m.project))}</span><b>·</b>` : ''}${typeLabel(catOf(m), l.kind)}${files > 1 ? `<b>·</b><span>${t('{n} file|{n} files', { n: files })}</span>` : ''}${hostTag(l.host) ? `<b>·</b>${hostTag(l.host)}` : ''}</div>
      ${ex ? `<p class="entry-ex">${esc(ex)}</p>` : ''}
    </div>
    ${thumb}
    <time class="entry-time" datetime="${esc(m.updated)}">${hm(m.updated)}</time>
  </a>
  ${pinButton('item', idOf(m), pinned)}
</li>`;
}

function timeline(items, opts) {
  const groups = new Map();
  for (const m of items) { const k = dayKey(m.updated); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  let i = 0;
  return `<section class="timeline">${[...groups].map(([k, list]) => {
    const { name, sub } = dayLabel(k);
    return `<div class="day"><h2 class="day-h"><span>${esc(name)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}<em>${list.length}</em></h2><ol class="entries">${list.map(m => entry(m, i++, opts)).join('')}</ol></div>`;
  }).join('')}<p class="no-match" hidden>${t('Nothing matches.')}</p><p class="all-read" hidden>${t('All caught up.')}</p></section>`;
}

// 置顶区：卡片
function pinnedSection(items, { showProject = true } = {}) {
  const pinned = items.filter(isPinnedItem).sort((a, b) => String(PINS().items[idOf(b)]).localeCompare(String(PINS().items[idOf(a)])));
  if (!pinned.length) return '';
  const card = m => {
    const l = latest(m); const th = thumbOf(m); const rs = readState(m);
    const media = th ? `<img src="${esc(th.src)}" alt="" loading="lazy" decoding="async"${th.doc ? ' class="doc"' : ''}>`
      : (l.excerpt || l.note) ? `<p>${esc(l.excerpt || l.note)}</p>` : `<span class="card-kind">${ICON.doc}<b>${esc(kindLabel(l.kind))}</b></span>`;
    return `<div class="card-wrap" data-search="${esc(searchText(m))}" data-unread="${rs.unread ? 1 : 0}" data-agent="${esc(agentFilterKey(l.agent))}" data-cat="${catOf(m)}">
  <a class="card${rs.unread ? ' unread' : ''}" href="${esc(itemPath(m.project, m.slug))}">
    <div class="card-media">${media}</div>
    <div class="card-body">
      <div class="card-title">${rs.unread ? `<i class="unread-dot inline" aria-label="${t('Unread')}"></i>` : ''}${esc(m.title)}</div>
      <div class="card-meta">${showProject ? `${avatar(m.project, 'xs')}<span>${esc(dname(m.project))}</span><b>·</b>` : ''}${typeLabel(catOf(m), l.kind)}<b>·</b><time datetime="${esc(m.updated)}">${shortDate(m.updated)}</time>${l.agent ? `<b>·</b>${agentTag(l.agent, false, true)}` : ''}</div>
    </div>
  </a>
  ${pinButton('item', idOf(m), true)}
</div>`;
  };
  return `<section class="pinned-sec" aria-label="${t('Pinned')}"><h2 class="sec-h">${ICON.pin}<span>${t('Pinned')}</span><em>${pinned.length}</em></h2><div class="cards">${pinned.map(card).join('')}</div></section>`;
}

// ---------- 类型：审批 / 方案 / 汇报 / 其他 ----------
const catOf = m => latest(m).category || m.category || 'other';
const catLabel = c => t(CATEGORY_LABEL[c] || 'Other');
// 列表里的类型 + 格式：Markdown 文档直接写类型；其他格式写"类型 · 格式"；"其他"就只写格式
function typeLabel(cat, kind) {
  if (cat === 'other') return `<span>${esc(kindLabel(kind))}</span>`;
  return `<span class="cat cat-${cat}">${esc(catLabel(cat))}</span>${kind !== 'md' ? `<b>·</b><span>${esc(kindLabel(kind))}</span>` : ''}`;
}
function catSeg(items) {
  const counts = new Map();
  for (const m of items) { const k = catOf(m); counts.set(k, (counts.get(k) || 0) + 1); }
  if (counts.size < 2) return '';
  const order = ['approval', 'todo', 'plan', 'report', 'other'].filter(k => counts.has(k));
  return `<div class="seg cat-seg" role="group" aria-label="${t('Type')}"><button type="button" data-cat="all" class="on">${t('Any type')}</button>${order.map(k => `<button type="button" data-cat="${k}" class="cat-${k}"><i></i>${esc(catLabel(k))} <em>${counts.get(k)}</em></button>`).join('')}</div>`;
}

// ---------- 审批状态、待办进度、未处理的批注数 ----------
// 审批状态只看最新版本，见 waiting.mjs：pending / submitted / done / chat / superseded / expired
export function approvalState(m) { return approvalStatus(m, RESP(m.project, m.slug))?.state || null; }
const apLabel = st => ({ pending: t('Awaiting you'), submitted: t('Submitted'), done: t('Handled'), chat: t('Decided in the conversation'), superseded: t('Replaced'), expired: t('Expired') })[st] || t('Handled');
function apPill(m) { const st = approvalState(m); return st ? `<span class="ap-pill ap-${st}">${apLabel(st)}</span>` : ''; }
// 待办进度：待办类条目，或者文档里嵌了 ```todo 块的条目。{ total, done, left, items } 或 null
export function todoState(m) {
  const list = TODOS(m);
  return list.length ? todoProgress(list, RESP(m.project, m.slug).todos) : null;
}
function tdPill(m) {
  const st = todoState(m); if (!st) return '';
  return st.left ? `<span class="td-pill" title="${esc(t('{done} of {total} done', st))}">${ICON.todo}${st.done}/${st.total}</span>` : `<span class="td-pill td-all">${ICON.todo}${t('All done')}</span>`;
}
// 处理记录：结束了的审批单（答了 / 对话里定了 / 被取代 / 过期）和勾完了的待办
function recordsSection(items) {
  const rows = items.filter(isAction).map(m => {
    const ap = approvalStatus(m, RESP(m.project, m.slug));
    if (ap) return ap.state === 'pending' ? null : { m, kind: 'ap', st: ap.state, at: ap.at || m.updated };
    const td = todoState(m); return td && !td.left ? { m, kind: 'td', at: m.updated } : null;
  }).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!rows.length) return '';
  const row = x => `<a class="rec-row" href="${esc(itemPath(x.m.project, x.m.slug))}">${x.kind === 'ap' ? ICON.stamp : ICON.todo}<span class="rec-t">${esc(x.m.title)}</span>${x.kind === 'ap' ? `<span class="ap-pill ap-${x.st}">${apLabel(x.st)}</span>` : `<span class="td-pill td-all">${t('All done')}</span>`}<time datetime="${esc(x.at)}">${shortDate(x.at)}</time></a>`;
  return `<details class="rec-sec"><summary>${t('Records · {n}', { n: rows.length })}</summary><div class="rec-rows">${rows.map(row).join('')}</div></details>`;
}
function cmPill(m) { const n = openComments(RESP(m.project, m.slug)).length; return n ? `<span class="cm-pill" title="${esc(t('{n} open comment|{n} open comments', { n }))}">${ICON.comment}${n}</span>` : ''; }
// 等你处理：列表最上面。还没答的审批单 + 还没做完的待办（静音项目、归档的不算）
const toolName = id => agentInfo(id)?.name || t('A tool');
const promptHead = p => ({ question: t('{tool} is asking you', { tool: toolName(p.tool) }), plan: t('{tool} wants a plan approved', { tool: toolName(p.tool) }), permission: t('{tool} wants permission', { tool: toolName(p.tool) }) })[p.kind];
function waitingSection(items, { showProject = true, project = null } = {}) {
  const map = READ();
  // 终端里的提问排最前面：agent 正卡在那里等
  const prompts = allPrompts().filter(p => p.status === 'pending' && (!project || p.project === project)).reverse();
  const prow = p => `<a class="ap-row pr-row" href="/prompts/${esc(p.id)}">${ICON.term}<span class="ap-row-t"><b>${esc(promptHead(p))}：${esc(promptTitle(p))}</b><small>${showProject ? `${esc(dname(p.project))} · ` : ''}<time datetime="${esc(p.at)}">${shortDate(p.at)}</time></small></span><span class="ap-go">${t('Answer')}</span></a>`;
  const rows = items.filter(m => !readState(m, map).archived).map(m => {
    if (approvalState(m) === 'pending') return { m, kind: 'ap' };
    const st = todoState(m); return st?.left ? { m, kind: 'td', st } : null;
  }).filter(Boolean);
  if (!rows.length && !prompts.length) return '';
  const row = ({ m, kind, st }) => `<a class="ap-row${kind === 'td' ? ' td-row' : ''}" href="${esc(itemPath(m.project, m.slug))}">${kind === 'ap' ? ICON.stamp : ICON.todo}<span class="ap-row-t"><b>${esc(m.title)}</b><small>${showProject ? `${esc(dname(m.project))} · ` : ''}<time datetime="${esc(m.updated)}">${shortDate(m.updated)}</time></small></span><span class="ap-go">${kind === 'ap' ? t('Review') : t('{n} left', { n: st.left })}</span></a>`;
  return `<section class="ap-sec" aria-label="${t('Waiting on you')}"><h2 class="sec-h">${ICON.inbox2}<span>${t('Waiting on you')}</span><em>${rows.length + prompts.length}</em></h2><div class="ap-rows">${prompts.map(prow).join('')}${rows.map(row).join('')}</div></section>`;
}
// 项目页：终端里问过的（答了、交回终端、取消了的），默认收起
function promptRecords(project) {
  const list = allPrompts().filter(p => p.project === project && p.status !== 'pending').reverse().slice(0, 30);
  if (!list.length) return '';
  const label = p => ({ answered: t('Answered here'), terminal: t('Answered in {tool}', { tool: toolName(p.tool) }), released: t('Sent back to {tool}', { tool: toolName(p.tool) }), cancelled: t('Cancelled') })[p.status] || p.status;
  return `<details class="rec-sec"><summary>${t('Questions from your AI tools · {n}', { n: list.length })}</summary><div class="rec-rows">${list.map(p => `<a class="rec-row" href="/prompts/${esc(p.id)}">${ICON.term}<span class="rec-t">${esc(promptHead(p))}：${esc(promptTitle(p))}</span><span class="ap-pill pr-pill pr-${esc(p.status)}">${esc(label(p))}</span><time datetime="${esc(p.at)}">${shortDate(p.at)}</time></a>`).join('')}</div></details>`;
}

// 按来源筛选的键：认识的 agent 用 id，别的工具（MYDASH_AGENT 报了名字的）归到 other；
// 没有来源记录的（安装时的欢迎条目、在终端里手动发的）不是哪个工具发的，不算进来源筛选，只在「全部来源」里出现
function agentFilterKey(id) { return !id ? '' : agentInfo(id).known ? id : 'other'; }
function agentSeg(items) {
  const counts = new Map();
  for (const m of items) { const k = agentFilterKey(latest(m).agent); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  if (counts.size < 2) return '';
  const order = ['claude', 'codex', 'other'].filter(k => counts.has(k));
  const label = k => (k === 'other' ? `${ICON.bot}<span>${t('Other')}</span>` : `${agentIcon(k)}<span>${esc(agentInfo(k).short)}</span>`);
  return `<div class="seg agent-seg" role="group" aria-label="${t('Published by')}"><button type="button" data-agent="all" class="on">${t('Any tool')}</button>${order.map(k => `<button type="button" data-agent="${k}" class="ag-${k}">${label(k)} <em>${counts.get(k)}</em></button>`).join('')}</div>`;
}
function listTools(items, project = '') {
  const n = unreadCount(items);
  return `<div class="list-tools" data-project="${esc(project)}">
  <div class="seg" role="group" aria-label="${t('Show')}"><button type="button" data-show="all" class="on">${t('All')} <em>${items.length}</em></button><button type="button" data-show="unread">${t('Unread')} <em class="unread-n${n ? ' has' : ''}">${n}</em></button></div>
  <button type="button" class="filter-btn" aria-expanded="false" aria-controls="list-more">${ICON.filter}<span>${t('Filter')}</span><em hidden></em></button>
  <div class="list-more" id="list-more">
  <button type="button" class="mark-all"${n ? '' : ' disabled'}>${t('Mark all as read')}</button>
  ${catSeg(items)}
  ${agentSeg(items)}
  </div>
</div>`;
}

function emptyState() {
  return `<section class="empty">
  <div class="empty-ico">${LOGO}</div>
  <h2>${t('mydash is empty')}</h2>
  <p>${t('Ask Claude Code or Codex, in any project, to run the command below. What it publishes shows up here, grouped by project.')}</p>
  <pre class="code"><code>${esc(t('mydash publish plan.md --title "Launch plan" --slug launch-plan'))}</code></pre>
</section>`;
}

// ---------- 首页 ----------
export function homePage(allItems, { showArchived = false } = {}) {
  const { shown: items, archivedCount } = splitArchived(allItems, showArchived);
  const plist = projectSummary(allItems).sort((a, b) => isPinnedProject(b.name) - isPinnedProject(a.name));
  const shown = items.slice(0, 300);
  const unread = unreadCount(items);
  const today = items.filter(m => dayKey(m.updated) === dayKey(new Date().toISOString())).length;
  const now = parts(Date.now());
  const body = `
<header class="page-head">
  <div class="page-id">
    <p class="eyebrow">${esc(dateText(now.y, now.m, now.d, false))}</p>
    <h1 class="page-title">${showArchived ? t('Archived') : t('All items')}</h1>
    <p class="page-sub"><a class="digest-link" href="/today">${ICON.inbox}${t('Today')}</a><b>·</b><span>${t('{n} item|{n} items', { n: items.length })}</span><b>·</b><span>${t('{n} project|{n} projects', { n: plist.length })}</span>${unread ? `<b>·</b><span class="hl">${t('{n} unread', { n: unread })}</span>` : ''}${today ? `<b>·</b><span>${t('{n} new today', { n: today })}</span>` : ''}</p>
  </div>
  ${items.length ? `<label class="search">${ICON.search}<input id="q" type="search" placeholder="${t('Search titles, projects, summaries')}" autocomplete="off" enterkeyhint="search"><kbd class="kbd-hint">/</kbd></label>` : ''}
</header>
${plist.length ? `<section class="projects" aria-label="${t('Projects')}"><div class="projects-scroll">${plist.map(p => { const u = items.filter(m => m.project === p.name && readState(m).unread).length; return `<a class="proj${isPinnedProject(p.name) ? ' pinned' : ''}" href="${esc(projectPath(p.name))}">${avatar(p.name, 'sm')}<span class="proj-name">${esc(dname(p.name))}</span>${u ? `<b class="side-unread">${u}</b>` : `<span class="proj-count">${p.count}</span>`}</a>`; }).join('')}</div></section>` : ''}
${showArchived ? '' : updateBar()}
${showArchived ? '' : waitingSection(allItems)}
${showArchived ? '' : pinnedSection(items)}
${items.length ? listTools(items) + timeline(shown) : allItems.length ? '' : emptyState()}
${items.length > shown.length ? `<p class="more">${t('The {n} older items are on their project pages.', { n: items.length - shown.length })}</p>` : ''}
${archivedNote(archivedCount, showArchived, '/')}`;
  return layout({ title: 'mydash', body, page: 'home' });
}

// ---------- 今日摘要：今天 agent 发了什么、等你审批的、还没处理的批注 ----------
export function digestPage(allItems) {
  const today = dayKey(new Date().toISOString());
  const map = READ();
  const todays = allItems.filter(m => dayKey(m.updated) === today && !isAction(m) && !readState(m, map).archived);
  const pending = allItems.filter(m => approvalState(m) === 'pending');
  const withComments = allItems.map(m => ({ m, n: openComments(RESP(m.project, m.slug)).length })).filter(x => x.n);
  const todoLeft = allItems.reduce((a, m) => a + (readState(m, map).archived ? 0 : todoState(m)?.left || 0), 0);
  const byProject = new Map();
  for (const m of todays) { if (!byProject.has(m.project)) byProject.set(m.project, []); byProject.get(m.project).push(m); }
  const now = parts(Date.now());
  const row = m => {
    const l = latest(m); const rs = readState(m, map);
    return `<li class="dg-row${rs.unread ? ' unread' : ''}"><a href="${esc(itemPath(m.project, m.slug))}"><span class="dg-t">${rs.unread ? `<i class="unread-dot inline" aria-label="${t('Unread')}"></i>` : ''}${esc(m.title)}${l.v > 1 ? ` <span class="ver">v${l.v}</span>` : ''}${apPill(m)}${tdPill(m)}</span><span class="dg-m">${typeLabel(catOf(m), l.kind)}<b>·</b><span>${hm(m.updated)}</span>${l.agent ? `<b>·</b>${agentTag(l.agent)}` : ''}</span>${l.note || l.excerpt ? `<span class="dg-x">${esc(l.note || l.excerpt)}</span>` : ''}</a></li>`;
  };
  const unread = todays.filter(m => readState(m, map).unread).length;
  const body = `
<header class="page-head">
  <div class="page-id">
    <p class="eyebrow">${esc(dateText(now.y, now.m, now.d, false))}</p>
    <h1 class="page-title">${t('Today')}</h1>
    <p class="page-sub"><span>${t('{n} item today|{n} items today', { n: todays.length })}</span>${unread ? `<b>·</b><span class="hl">${t('{n} unread', { n: unread })}</span>` : ''}${pending.length ? `<b>·</b><span>${t('{n} awaiting your approval', { n: pending.length })}</span>` : ''}${todoLeft ? `<b>·</b><span>${t('{n} to-do left|{n} to-dos left', { n: todoLeft })}</span>` : ''}${withComments.length ? `<b>·</b><span>${t('{n} with open comments', { n: withComments.length })}</span>` : ''}</p>
  </div>
</header>
${waitingSection(allItems)}
${todays.length ? [...byProject].map(([proj, list]) => `<section class="dg-sec"><h2 class="dg-h"><a href="${esc(projectPath(proj))}">${avatar(proj, 'sm')}<span>${esc(dname(proj))}</span></a><em>${list.length}</em></h2><ol class="dg-list">${list.map(row).join('')}</ol></section>`).join('') : `<p class="dg-empty">${t('Nothing new today yet.')}</p>`}
${withComments.length ? `<section class="dg-sec"><h2 class="dg-h">${ICON.comment}<span>${t('Open comments')}</span><em>${withComments.length}</em></h2><ol class="dg-list">${withComments.map(({ m }) => row(m)).join('')}</ol></section>` : ''}
${unread ? `<div class="dg-foot"><button type="button" class="mark-all" data-ids="${esc(todays.filter(m => readState(m, map).unread).map(idOf).join(','))}">${t('Mark today’s items as read')}</button></div>` : ''}`;
  return layout({ title: `${t('Today')} · mydash`, body, page: 'today' });
}

// ---------- 项目页 ----------
export function projectPage(project, allItems, { showArchived = false } = {}) {
  const { shown: items0, archivedCount } = splitArchived(allItems, showArchived);
  const items = items0.length ? items0 : allItems.slice(0, 0);
  const pinned = isPinnedProject(project);
  const muted = isMuted(project);
  const body = `
<header class="page-head proj-head">
  <div class="proj-id">
    ${avatar(project, 'av-lg')}
    <div class="proj-text">
      <h1 class="proj-title"><span class="proj-display">${esc(dname(project))}</span><button type="button" class="rename" aria-label="${t('Rename project')}" title="${t('Rename (display only; agents keep publishing under the folder name)')}">${ICON.edit}</button></h1>
      <form class="rename-form" hidden><input name="name" maxlength="60" value="${esc(dname(project))}" placeholder="${esc(project)}" autocomplete="off" enterkeyhint="done" aria-label="${t('Project display name')}"><button type="submit" class="rename-save">${t('Save')}</button><button type="button" class="rename-cancel">${t('Cancel')}</button></form>
      <p class="page-sub">${dname(project) !== project ? `<span>${t('Folder')} <code>${esc(project)}</code></span><b>·</b>` : ''}<span>${t('{n} item|{n} items@@project', { n: allItems.filter(m => !isAction(m)).length })}</span><b>·</b><span>${t('Updated')} <time data-rel datetime="${esc(allItems[0].updated)}">${fullTime(allItems[0].updated)}</time></span>${muted ? `<b>·</b><span class="muted-tag">${t('Muted')}</span>` : ''}</p>
    </div>
  </div>
  <div class="head-actions">${pinButton('project', project, pinned, { label: true })}<button type="button" class="act mute-btn${muted ? ' on' : ''}" data-project="${esc(project)}" aria-pressed="${muted}" title="${esc(muted ? t('Unmute: count its items as unread again') : t('Mute: its items no longer count as unread'))}">${muted ? t('Unmute') : t('Mute')}</button></div>
</header>
${showArchived ? '' : waitingSection(allItems, { showProject: false, project }) + recordsSection(allItems) + promptRecords(project)}
${showArchived ? '' : pinnedSection(items, { showProject: false })}
${items.length ? listTools(items, project) + timeline(items, { showProject: false }) : ''}
${archivedNote(archivedCount, showArchived, projectPath(project))}`;
  return layout({ title: `${dname(project)} · mydash`, body, page: 'project', crumbs: [{ text: dname(project) }], data: { project, display: dname(project) } });
}

// 局域网设备的登录页：单独一页，不带边栏（还没登录的人不能看到项目名）
export function loginPage({ next = '/', error = '' } = {}) {
  return `<!doctype html>
<html lang="${htmlLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f6f7">
<title>${t('Enter the access code')} · mydash</title>
<link rel="icon" href="/favicon.ico?b=${BUILD}" sizes="32x32">
<link rel="apple-touch-icon" href="/static/icon-180.png?b=${BUILD}">
<link rel="stylesheet" href="/static/app.css?b=${BUILD}">
<script>${THEME_JS}</script>
</head>
<body class="page-login">
<main class="login">
  <div class="login-card">
    ${LOGO}
    <h1>${t('Enter the access code')}</h1>
    <p>${t('This mydash can be opened on the same Wi-Fi with an access code. You only need to enter it once on each device.')}</p>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <input name="code" autocapitalize="characters" autocomplete="one-time-code" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12" required autofocus aria-label="${t('Access code')}">
      ${error ? `<p class="login-err" role="alert">${esc(error)}</p>` : ''}
      <button type="submit">${t('Open')}</button>
    </form>
    <p class="login-hint">${t('The code is on the computer running mydash: click “Open on another device” at the bottom of the sidebar, or run mydash lan.')}</p>
  </div>
</main>
</body>
</html>`;
}

function approvalForm(meta, ver, isLatest, responses, summary, mdText) {
  const sub = latestApproval(responses, ver.v);
  // 没在网页上答就结束了的（对话里定了 / 被取代 / 过期）：锁住，写明怎么结束的
  const st = isLatest ? approvalStatus(meta, responses) : null;
  const closed = st && ['chat', 'superseded', 'expired'].includes(st.state)
    ? { how: st.state, at: st.at, note: st.closure?.note || '', by: st.closure?.by ? itemPath(...st.closure.by.split('/')) : '' } : null;
  return `<form id="ap-form" class="ap-submit" data-id="${esc(`${meta.project}/${meta.slug}`)}" data-v="${ver.v}" data-latest="${isLatest ? 1 : 0}" novalidate>
  <div class="ap-state" hidden></div>
  <div class="ap-actions"><button type="submit" class="ap-send">${esc(submitLabel(mdText) || t('Submit'))}</button></div>
</form>
<script type="application/json" id="ap-data">${jsonData({ submission: sub, summary, title: ver.title, closed })}</script>`;
}

// 待办进度条：勾选在 app.js 里处理，状态（含文档里写的 [x]）放在 #td-data
function todoBar(meta, ver, st) {
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  return `<div class="td-bar${st.left ? '' : ' all'}" data-id="${esc(`${meta.project}/${meta.slug}`)}" data-v="${ver.v}">
  <p>${ICON.todo}<span class="td-txt">${st.left ? t('{done} of {total} done', st) : t('All done')}</span><small>${t('Tick them off here as you go.')}</small></p>
  <div class="td-track" role="progressbar" aria-valuemin="0" aria-valuemax="${st.total}" aria-valuenow="${st.done}"><i style="width:${pct}%"></i></div>
  <button type="button" class="linkish td-hide" hidden></button>
</div>
<script type="application/json" id="td-data">${jsonData(Object.fromEntries(st.items.map(x => [x.key, x.done])))}</script>`;
}

function commentsPanel(meta, ver, rel, responses, prose) {
  const open = openComments(responses).length;
  return `<section class="cm-panel" id="comments" data-id="${esc(`${meta.project}/${meta.slug}`)}" data-v="${ver.v}" data-file="${esc(rel)}"${prose ? ' data-prose="1"' : ''}>
  <div class="cm-head"><h2>${ICON.comment}<span>${t('Comments')}</span><em class="cm-n">${open || ''}</em></h2><button type="button" class="cm-add">${t('Add a comment')}</button></div>
  <div class="cm-list"></div>
  <p class="cm-tip">${prose ? t('Select any text in the document to comment on that passage. Your agent reads open comments the next time it works on this.') : t('Your agent reads open comments the next time it works on this.')}</p>
</section>
<script type="application/json" id="cm-data">${jsonData(responses.comments)}</script>`;
}

// ---------- 设置：自动归档、推送、每日摘要（存进 config.json，马上生效）----------
// 推送渠道的名字（给人看的）
const CH_NAME = () => ({ bark: 'Bark', ntfy: 'ntfy', telegram: 'Telegram', pushover: 'Pushover', webhook: t('Group bot'), email: t('Email') });
// 收起时标题旁写着开了哪些
export function pushSummary(channels, devices = 0) {
  const on = [...channels.filter(c => !c.off).map(c => c.name || CH_NAME()[c.type] || c.type), ...(devices ? [t('Web push')] : [])];
  return on.length ? t('On: {list}', { list: on.join(lang() === 'zh' ? '、' : ', ') }) : t('None turned on yet');
}
// 已加的渠道，一行一个：名字、类型和目标（密钥遮住）、开关、试发、改、删
export function channelRows(channels) {
  if (!channels.length) return `<p class="set-empty">${t('No notification service yet. Add one below; you can add several, even two of the same kind.')}</p>`;
  return channels.map(ch => {
    const pc = publicChannel(ch); const kind = CH_NAME()[ch.type] || ch.type;
    const target = pc.masked.url || (ch.type === 'telegram' ? `chat ${pc.values.chat}` : ch.type === 'pushover' ? pc.values.user : ch.type === 'email' ? pc.values.to : '');
    return `<div class="set-chrow${ch.off ? ' off' : ''}" data-id="${esc(ch.id)}" data-type="${esc(ch.type)}">
      <div class="set-chmain"><b>${esc(pc.name || kind)}</b><small>${pc.name ? `${esc(kind)} · ` : ''}${esc(target)}</small></div>
      <label class="set-switch" title="${esc(t('On / off'))}"><input type="checkbox" class="set-chon" aria-label="${esc(t('{name} on', { name: pc.name || kind }))}"${ch.off ? '' : ' checked'}><span></span></label>
      <div class="set-chacts"><button type="button" class="act set-test">${t('Send a test')}</button><button type="button" class="act set-edit">${t('Edit')}</button><button type="button" class="linkish set-del">${t('Remove')}</button></div>
      <script type="application/json" class="set-chdata">${jsonData(pc)}</script>
    </div>`;
  }).join('');
}
// ---------- 新版本（lib/update.mjs）----------
// 首页顶上的一条：有新版本（点一下更新）、正在更新、上次更新的结果（点「知道了」收起）
function updateBar() {
  const s = updateStatus();
  const last = s.last && !s.last.seen ? s.last : null;
  let cls, text, more = '', btns = '';
  if (s.running) { cls = 'running'; text = t('Updating mydash… This page comes back by itself in a minute or two.'); }
  else if (last) {
    cls = last.ok ? 'done' : 'failed';
    text = last.ok ? t('mydash was updated to {v}.', { v: last.to }) : t('mydash could not update to {v}.', { v: last.to || '?' });
    const notes = last.ok ? last.human || [] : [last.error].filter(Boolean);
    if (notes.length) more = `<ul class="upd-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
    btns = `${last.ok && last.url ? `<a class="upd-link" href="${esc(last.url)}" target="_blank" rel="noopener">${t('What’s new')}</a>` : ''}<button type="button" class="upd-btn quiet" data-upd="seen">${t('OK')}</button>`;
  } else if (s.available && s.mode !== 'off') {
    cls = 'available';
    text = t('mydash {v} is available (you have {cur}).', { v: s.latest.version, cur: s.current });
    btns = `${s.latest.url ? `<a class="upd-link" href="${esc(s.latest.url)}" target="_blank" rel="noopener">${t('What’s new')}</a>` : ''}${s.canUpdate ? `<button type="button" class="upd-btn" data-upd="start">${t('Update')}</button>` : `<code>mydash update</code>`}`;
  } else return '';
  return `<div class="upd-bar upd-${cls}" id="upd-bar" role="status">${ICON.upd}<div class="upd-main"><span class="upd-t">${text}</span>${more}</div><div class="upd-acts">${btns}</div></div>`;
}

function updateSection() {
  const s = updateStatus();
  const state = !s.canCheck ? t('mydash was not installed from a git checkout, so it cannot look for new versions. Reinstall from a clone to get updates.')
    : s.running ? t('Updating…')
    : s.available ? t('Version {v} is available.', { v: s.latest.version })
    : s.error ? t('Could not check: {err}', { err: s.error })
    : s.checkedAt ? t('Up to date. Last checked {when}.', { when: shortDate(s.checkedAt) }) : t('Not checked yet.');
  return `<section class="set-sec" id="update">
    <h2>${ICON.upd}${t('Updates')}</h2>
    <p class="set-hint">${t('mydash follows its official releases. Once a day it asks the repository it was installed from whether there is a new one; nothing about you or your items is sent.')}</p>
    <p class="set-upd-state">${t('Installed: {v}', { v: esc(s.current) })} · <span>${esc(state)}</span>${s.available && s.latest.url ? ` <a href="${esc(s.latest.url)}" target="_blank" rel="noopener">${t('What’s new')}</a>` : ''}</p>
    <div class="set-field"><label for="s-umode">${t('When a new version comes out')}</label><select id="s-umode" name="updateMode" data-auto>${[['notify', t('Tell me; I update with one tap')], ['auto', t('Install it at night, between 3 and 5 am')], ['off', t('Do nothing')]].map(([v, l]) => `<option value="${v}"${s.mode === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    ${s.canCheck ? `<div class="set-upd-btns"><button type="button" class="act" data-upd="check"${s.running ? ' disabled' : ''}>${t('Check now')}</button>${s.available && s.canUpdate && !s.running ? `<button type="button" class="act upd-go" data-upd="start">${t('Update now')}</button>` : ''}</div>` : ''}
  </section>`;
}

export function settingsPage({ archiveDays, notify, timezone, webpush = { httpsUrl: '', devices: 0 }, prompts = {} }) {
  const dayOpts = [3, 7, 14, 30, 60, 90];
  if (archiveDays && !dayOpts.includes(archiveDays)) dayOpts.push(archiveDays);
  const opts = dayOpts.sort((a, b) => a - b).map(d => `<option value="${d}"${d === archiveDays ? ' selected' : ''}>${t('{n} day|{n} days', { n: d })}</option>`).join('') + `<option value="0"${archiveDays ? '' : ' selected'}>${t('Never archive automatically')}</option>`;
  // 添加、修改渠道用的表单（每种一个模板，页面上点「添加」或「改」时拿来用）。字段名就是 notify.mjs 里 CHANNELS 的字段
  const fld = (key, label, { kind = 'text', ph = '', short = false } = {}) => `<label class="set-sub${short ? ' short' : ''}"><span>${label}</span><input name="${key}" type="${kind}" ${kind === 'url' ? 'inputmode="url" ' : ''}autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(ph)}"></label>`;
  const sel = (key, label, options) => `<label class="set-sub short"><span>${label}</span><select name="${key}">${options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`;
  // 每种渠道的表单末尾带一份「怎么设置」的教程（lib/pushguide.mjs），点开才显示
  const tpl = (type, sub, fields, help, extra = '') => `<template id="tpl-${type}" data-name="${esc(CH_NAME()[type])}" data-sub="${esc(sub)}"><div class="set-edfields">${fields}</div><div class="set-edextra">${extra}</div><small class="set-help">${help}</small>${pushGuide(type)}</template>`;
  const TYPES = [['bark', t('iPhone app')], ['ntfy', t('iPhone and Android app')], ['telegram', t('a bot messages you')], ['pushover', t('iPhone and Android app, one-off purchase')], ['webhook', t('WeCom, Feishu, DingTalk, Slack or Discord')], ['email', t('through your own mailbox (SMTP)')]];
  const sub = Object.fromEntries(TYPES);
  const body = `
<header class="page-head"><div class="page-id"><h1 class="page-title">${t('Settings')}</h1><p class="page-sub"><span>${t('Changes are saved automatically.')}</span></p></div></header>
<div class="set-form" id="set-form">
  <section class="set-sec">
    <h2>${ICON.devices}${t('This device')}</h2>
    <p class="set-hint">${t('Only for this browser. The command line and notifications keep the language chosen at install.')}</p>
    <div class="set-grid2">
      <div class="set-field"><label for="s-lang">${t('Language')}</label><select id="s-lang" name="lang">${[['zh', '中文'], ['en', 'English']].map(([v, l]) => `<option value="${v}"${lang() === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set-field"><label for="s-theme">${t('Appearance')}</label><select id="s-theme" name="theme">${[['auto', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
    </div>
  </section>
  <section class="set-sec">
    <h2>${ICON.inbox}${t('Auto-archive')}</h2>
    <p class="set-hint">${t('Unread items older than this move to the archive and stop counting as unread. Nothing is deleted; archived items are one tap away.')}</p>
    <div class="set-field"><label for="s-days">${t('Archive unread items after')}</label><select id="s-days" name="autoArchiveDays" data-auto>${opts}</select></div>
  </section>
  <details class="set-sec set-fold" id="set-push">
    <summary><h2>${ICON.devices}${t('Notifications on your phone')}</h2><span class="set-sum">${esc(pushSummary(notify.channels, webpush.devices))}</span></summary>
    <div class="set-fold-body">
    <p class="set-hint">${t('A notification when an agent publishes something new or a question waits for you. Only titles and project names go through the push service; the content stays here. Add as many as you like.')}</p>
    <div class="set-chs" id="set-chs">${channelRows(notify.channels)}</div>
    <form class="set-ed" id="set-ed" hidden novalidate>
      <h3 class="set-edh"></h3>
      <label class="set-sub"><span>${t('Name (optional)')}</span><input name="name" type="text" maxlength="40" autocomplete="off" placeholder="${esc(t('e.g. My iPhone'))}"></label>
      <div class="set-edbody"></div>
      <div class="set-ch-acts"><button type="submit" class="set-save">${t('Save')}</button><button type="button" class="act set-edtest">${t('Send a test')}</button><button type="button" class="linkish set-cancel">${t('Cancel')}</button></div>
    </form>
    <div class="set-adder"><button type="button" class="act set-add">+ ${t('Add a notification service')}</button>
      <div class="set-types" hidden><p class="set-hint">${t('Which one?')}</p>${TYPES.map(([type, s2]) => `<button type="button" class="set-type" data-type="${type}"><b>${esc(CH_NAME()[type])}</b><small>${esc(s2)}</small></button>`).join('')}</div>
    </div>
    ${tpl('bark', sub.bark, fld('url', t('Bark URL'), { kind: 'url', ph: 'https://api.day.app/…' }), t('iPhone: install the Bark app, copy the URL from its home screen, paste it here.'))}
    ${tpl('ntfy', sub.ntfy, fld('url', t('Topic URL'), { kind: 'url', ph: 'https://ntfy.sh/…' }), t('Install the ntfy app and subscribe to the same topic. Anyone who knows the topic can read it, so use a random one.'), `<button type="button" class="linkish set-gen">${t('Make a random topic')}</button>`)}
    ${tpl('telegram', sub.telegram, fld('token', t('Bot token'), { ph: '123456:ABC…' }) + fld('chat', t('Chat ID'), { ph: t('Fill in with the button below') }), t('In Telegram, message @BotFather, send /newbot and paste the token it gives you. Then send your new bot any message and tap “Find my chat ID”.'), `<button type="button" class="act set-tg">${t('Find my chat ID')}</button>`)}
    ${tpl('pushover', sub.pushover, fld('user', t('User key')) + fld('token', t('App API token')), t('Sign in at pushover.net: the User Key is on the front page; create an Application to get its API token.'))}
    ${tpl('webhook', sub.webhook, fld('url', t('Webhook URL'), { kind: 'url', ph: 'https://…' }) + fld('secret', t('Signing secret (optional)')), t('Add a bot to a group and paste its webhook URL; the service is recognised from the URL. If Feishu or DingTalk signing is on, paste the secret too. For a DingTalk keyword, use mydash.'))}
    ${tpl('email', sub.email, `<div class="set-grid">${fld('host', t('SMTP server'), { ph: 'smtp.gmail.com' })}${fld('port', t('Port'), { kind: 'number', ph: '465', short: true })}${sel('secure', t('Encryption'), [['tls', 'TLS (465)'], ['starttls', 'STARTTLS (587)']])}</div>${fld('user', t('Account'), { kind: 'email', ph: 'me@gmail.com' })}${fld('pass', t('Password'))}${fld('to', t('Send to'), { kind: 'email', ph: 'me@gmail.com' })}${fld('from', t('From (optional, defaults to the account)'), { kind: 'email' })}`, t('Sends from your own mailbox. Most mailboxes need an app password or authorisation code here, not your normal password; the guide below has the steps for Gmail, QQ, 163 and iCloud.'))}
    <details class="set-ch set-wp" data-type="webpush" data-https="${esc(webpush.httpsUrl)}"${webpush.devices ? ' open' : ''}>
      <summary><span class="set-ch-name">${t('Web push')}</span><span class="set-on"${webpush.devices ? '' : ' hidden'}>${t('{n} device|{n} devices', { n: webpush.devices })}</span><small>${t('no app needed; the browser shows it')}</small></summary>
      <div class="set-ch-body">
        <p class="set-wp-state">${webpush.httpsUrl ? '' : t('Needs HTTPS: turn it on for your tailnet in the Tailscale admin (DNS → HTTPS Certificates). mydash picks it up within a minute.')}</p>
        <div class="set-ch-acts"><button type="button" class="act set-wp-on" hidden>${t('Turn on for this device')}</button><button type="button" class="act set-wp-off" hidden>${t('Turn off for this device')}</button><button type="button" class="act set-wp-test">${t('Send a test')}</button></div>
        <small class="set-help">${t('iPhone: open the HTTPS address in Safari, Share → Add to Home Screen, open mydash from the home screen, then turn it on here.')}${webpush.httpsUrl ? ` <a href="${esc(webpush.httpsUrl)}/settings">${esc(webpush.httpsUrl)}</a>` : ''}</small>
        ${webpushGuide()}
      </div>
    </details>
    </div>
  </details>
  <section class="set-sec">
    <h2>${ICON.term}${t('Questions from your AI tools')}</h2>
    <p class="set-hint">${t('When Claude Code or Codex (command line or app) asks you to choose, approve a plan or allow a command, the question comes here too. Claude Code asks in the terminal at the same time, and whichever you answer first counts. Codex asks in its own window first; if you do not answer there, you get a reminder here and on your phone.')}</p>
    <div class="set-field"><label class="set-check"><input type="checkbox" name="promptsOn" data-auto${prompts.enabled !== false ? ' checked' : ''}><span>${t('Bring questions from your AI tools to mydash')}</span></label></div>
    <div class="set-field"><label for="s-pmode">${t('Claude Code choice questions and plan approvals')}</label><select id="s-pmode" name="promptsMode" data-auto>${[['parallel', t('Ask in the terminal and here at the same time')], ['hold', t('Ask here first; the terminal waits')]].map(([v, l]) => `<option value="${v}"${(prompts.mode || 'parallel') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="set-field"><label for="s-pcodex">${t('Codex choice questions')}</label><select id="s-pcodex" name="promptsCodex" data-auto>${[['app', t('Ask in Codex first; remind me here if I do not answer')], ['hold', t('Ask here first; Codex waits')]].map(([v, l]) => `<option value="${v}"${(prompts.codexMode || 'app') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="set-field"><label class="set-check"><input type="checkbox" name="promptsChat" data-auto${prompts.chat !== false ? ' checked' : ''}><span>${t('When an agent asks you something in its reply text, have it ask again as a choice question')}</span></label><p class="set-hint">${t('A question written in the reply does not reach mydash. With this on, the agent is asked once to put it as a choice question instead.')}</p></div>
    <div class="set-field"><label for="s-ppush">${t('When nobody answers, remind me on my phone')}</label><select id="s-ppush" name="promptsPush" data-auto>${[[0, t('Right away')], [30, t('After 30 seconds without an answer')], [60, t('After a minute without an answer')], [-1, t('Never')]].map(([v, l]) => `<option value="${v}"${Number(prompts.pushDelay ?? 30) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
  </section>
  <section class="set-sec">
    <h2>${ICON.todo}${t('Daily summary')}</h2>
    <p class="set-hint">${t('Once a day: how many new items, and what is waiting on you. Needs a notification service above.')}</p>
    <div class="set-field set-daily"><label class="set-check"><input type="checkbox" name="dailyOn" data-auto${notify.daily ? ' checked' : ''}><span>${t('Send every day at')}</span></label><input type="time" name="daily" data-auto value="${esc(notify.daily || '21:00')}" step="60"><small>${esc(t('Time zone: {tz}', { tz: timezone }))}</small></div>
  </section>
  ${updateSection()}
</div>`;
  return layout({ title: `${t('Settings')} · mydash`, page: 'settings', body, crumbs: [{ text: t('Settings') }] });
}

// ---------- 终端里的提问：在这里答（见 lib/prompts.mjs、bin/agent-ask.mjs）----------
export function promptPage(p) {
  const pending = p.status === 'pending';
  const dis = pending && !p.appOnly ? '' : ' disabled'; // 只能在那边答的：题目照样显示，选项不能点
  let body = '';
  if (p.kind === 'question') {
    const ans = p.answer?.answers || {};
    body = p.questions.map((q, i) => {
      const a = ans[q.question]; const picked = new Set([].concat(a ?? []).map(String));
      const other = a != null ? [...picked].find(x => !q.options.some(o => o.label === x)) : '';
      const type = q.multiSelect ? 'checkbox' : 'radio';
      return `<fieldset class="ap-q pr-q" data-multi="${q.multiSelect ? 1 : 0}"><legend>${q.header ? `<span class="pr-chip">${esc(q.header)}</span>` : ''}${esc(q.question)}${q.multiSelect ? `<small class="pr-multi">${t('Pick any number')}</small>` : ''}</legend><div class="ap-body">${q.options.map(o => `<label class="ap-opt"><input type="${type}" name="q${i}" value="${esc(o.label)}"${picked.has(o.label) ? ' checked' : ''}${dis}><span class="ap-mark"></span><span class="ap-text"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}<label class="ap-opt ap-other"><input type="${type}" name="q${i}" value="__other__"${other ? ' checked' : ''}${dis}><span class="ap-mark"></span><span class="ap-text"><b>${t('Other@@option')}</b><input type="text" class="ap-other-text" placeholder="${esc(t('Write your own answer'))}" value="${esc(other || '')}" autocomplete="off"${dis}></span></label></div></fieldset>`;
    }).join('');
  } else if (p.kind === 'plan') {
    body = `<div class="pr-plan">${markdownHtml(p.plan)}</div>${pending ? `<label class="pr-fb"><span>${t('Want changes? Say what, then press “Ask for changes”.')}</span><textarea class="pr-feedback" rows="3"></textarea></label>` : p.answer?.feedback ? `<blockquote class="ap-closed-note">${esc(p.answer.feedback)}</blockquote>` : ''}`;
  } else {
    body = `${p.description ? `<p class="pr-desc">${esc(p.description)}</p>` : ''}<pre class="code pr-input"><code>${esc(p.input)}</code></pre>${pending ? `<label class="pr-fb"><span>${t('Reason, if you deny (optional)')}</span><textarea class="pr-reason" rows="2"></textarea></label>` : ''}`;
  }
  const btns = p.kind === 'question' ? `<button type="button" class="pr-go" data-act="answer">${t('Submit')}</button>`
    : p.kind === 'plan' ? `<button type="button" class="pr-go" data-act="approve">${t('Go ahead with this plan')}</button><button type="button" class="pr-alt" data-act="revise">${t('Ask for changes')}</button>`
    : `<button type="button" class="pr-go" data-act="allow">${t('Allow')}</button>${p.suggestions?.length ? `<button type="button" class="pr-alt" data-act="always">${t('Always allow this')}</button>` : ''}<button type="button" class="pr-alt pr-deny" data-act="deny">${t('Deny')}</button>`;
  const when = iso => `<time datetime="${esc(iso)}">${fullTime(iso)}</time>`;
  const tool = toolName(p.tool);
  const done = p.answer ? (p.kind === 'plan' ? (p.answer.approve ? t('approved the plan') : t('asked for changes')) : p.kind === 'permission' ? ({ allow: t('allowed it'), always: t('allowed it from now on'), deny: t('denied it') })[p.answer.decision] : '') : '';
  const status = pending ? '' : `<div class="pr-status pr-${esc(p.status)}">${p.status === 'answered' ? `${t('Answered here')} · ${when(p.answeredAt)}${done ? ` · ${esc(done)}` : ''}` : p.status === 'released' ? `${t('Sent back to {tool}', { tool })} · ${when(p.endedAt)}` : p.status === 'terminal' ? `${t('Answered in {tool}', { tool })} · ${when(p.endedAt)}` : `${t('Cancelled in {tool}, or it stopped waiting', { tool })} · ${when(p.endedAt)}`}</div>`;
  const page = `
<header class="page-head pr-head">
  <div class="page-id">
    <p class="eyebrow"><a href="${esc(projectPath(p.project))}">${avatar(p.project, 'xs')}<span>${esc(dname(p.project))}</span></a><b>·</b>${agentTag(p.tool, true)}<b>·</b>${when(p.at)}</p>
    <h1 class="page-title">${esc(promptHead(p))}</h1>
  </div>
</header>
${status}
<div class="sheet pr-sheet"><article class="prose">${body}</article></div>
${pending ? (p.appOnly ? `<p class="pr-note pr-app">${t('{tool} is asking this in its own window. Answer it there; this page closes by itself once you do. ({tool} cannot take an answer from here.)', { tool })}</p>`
  : p.both ? `<div class="pr-acts">${btns}</div><p class="pr-note">${t('{tool} is asking this in its own window at the same time. Answer wherever is handy; the other one closes.', { tool })}</p>`
  : `<div class="pr-acts">${btns}<button type="button" class="pr-back" data-act="release">${t('Answer in {tool} instead', { tool })}</button></div><p class="pr-note">${t('Until you answer here, {tool} waits. “Answer in {tool} instead” hands the question back to it.', { tool })}</p>`) : ''}
<script type="application/json" id="pr-data">${jsonData({ id: p.id, kind: p.kind, status: p.status, questions: p.kind === 'question' ? p.questions.map(q => q.question) : [] })}</script>`;
  return layout({ title: `${promptHead(p)} · mydash`, page: 'prompt', body: page, crumbs: [{ text: dname(p.project), href: projectPath(p.project) }, { text: t('Question from {tool}', { tool }) }], data: { project: p.project } });
}

export function notFoundPage(msg = t('Page not found.')) {
  return layout({ title: `${t('Not found')} · mydash`, page: 'missing', body: `<section class="empty"><div class="empty-ico">${ICON.doc}</div><h2>${esc(msg)}</h2><p><a href="/">${t('Back to home')}</a></p></section>` });
}

// ---------- 条目页 ----------
function tocHtml(toc) {
  if (toc.length < 3) return { aside: '', mobile: '' };
  const items = toc.map(x => `<li class="d${x.depth}"><a href="#${esc(x.id)}">${x.text}</a></li>`).join('');
  return {
    aside: `<aside class="toc" aria-label="${t('Contents')}"><p class="toc-h">${t('On this page')}</p><ol>${items}</ol></aside>`,
    mobile: `<details class="toc-m"><summary>${t('Contents · {n} section|Contents · {n} sections', { n: toc.length })}</summary><ol>${items}</ol></details>`,
  };
}

// JSON 放进 <script type="application/json">，防止 </script> 截断
const jsonData = o => JSON.stringify(o).replace(/</g, '\\u003c');

export function itemPage(meta, ver, rel, rendered, gallery, { fileEntry, mode, responses = { approvals: [], comments: [] }, approvalSummary = '', mdText = '', diff = null, diffable = false, todos = null } = {}) {
  const l = latest(meta);
  const isLatest = ver.v === l.v;
  const p = meta.project, s = meta.slug;
  const files = ver.files;
  const vq = isLatest ? '' : `v=${ver.v}&`;
  const DOC_KINDS = new Set(['md', 'pdf', 'html', 'docx', 'doc', 'slides', 'sheet', 'table']);
  const viewable = files.filter(f => VIEWABLE.has(f.kind) && !f.path.startsWith('_') && (f.path === ver.main || !f.path.includes('/') || DOC_KINDS.has(f.kind)))
    .sort((a, b) => (b.path === ver.main) - (a.path === ver.main));
  const tabs = viewable.length > 1 && !gallery
    ? viewable.slice(0, 14).map(f => `<a class="tab${f.path === rel ? ' on' : ''}" href="${esc(itemPath(p, s))}?${vq}f=${encodeURIComponent(f.path)}"><span class="tab-kind">${esc(kindLabel(f.kind))}</span>${esc(f.path)}</a>`).join('')
    : '';
  const raw = rawPath(p, s, ver.v, rel);
  const allFiles = files.length > 1 ? `<details class="files"><summary>${t('All {n} files', { n: files.length })}</summary><ul>${files.map(f => {
    const href = VIEWABLE.has(f.kind) && f.kind !== 'image' ? `${itemPath(p, s)}?${vq}f=${encodeURIComponent(f.path)}` : rawPath(p, s, ver.v, f.path);
    return `<li><a href="${esc(href)}">${esc(f.path)}</a><span>${fmtSize(f.size)}</span></li>`;
  }).join('')}</ul></details>` : '';
  const mixedAgents = new Set(meta.versions.map(x => x.agent || '')).size > 1;
  const prevOf = x => { const i = meta.versions.findIndex(y => y.v === x.v); return i > 0 ? meta.versions[i - 1] : null; };
  const versions = meta.versions.length > 1 ? `<details class="versions"${isLatest ? '' : ' open'}><summary>${t('Versions · {n}', { n: meta.versions.length })}</summary><ol>${[...meta.versions].reverse().map(x => `<li class="${x.v === ver.v ? 'on' : ''}"><a href="${esc(itemPath(p, s))}${x.v === l.v ? '' : `?v=${x.v}`}"><b>v${x.v}</b><time>${fullTime(x.time)}</time><span>${esc(x.note || x.title)}</span>${mixedAgents ? agentTag(x.agent) : ''}</a>${diffable && prevOf(x) ? `<a class="vd" href="${esc(itemPath(p, s))}?v=${x.v}&amp;diff=${prevOf(x).v}&amp;f=${encodeURIComponent(rel)}">${t('Compare')}</a>` : ''}</li>`).join('')}</ol></details>` : '';
  const sources = ver.sources && ver.sources.length ? `<details class="sources"><summary>${t('Source')}</summary><ul>${ver.sources.map(x => `<li><code>${esc(shortHome(x))}</code></li>`).join('')}</ul>${ver.cwd ? `<p>${t('Published from')} <code>${esc(shortHome(ver.cwd))}</code></p>` : ''}</details>` : '';
  const oldBanner = isLatest ? '' : `<div class="banner old-banner">${t('You are viewing an old version, v{v}.', { v: ver.v })}<a href="${esc(itemPath(p, s))}">${t('See the latest, v{v}', { v: l.v })}</a></div>`;
  // 上次看过旧版本：告诉你之后改了什么，并能一键回去对比
  const rs = readState(meta);
  const since = isLatest && rs.updated ? meta.versions.filter(x => x.v > rs.seen) : [];
  const seenBanner = since.length ? `<div class="banner seen-banner"><p>${t('You last saw {v}. It has changed {n} time since.|You last saw {v}. It has changed {n} times since.', { v: `<b>v${rs.seen}</b>`, n: since.length })}${diffable && meta.versions.some(x => x.v === rs.seen) ? `<a href="${esc(itemPath(p, s))}?diff=${rs.seen}&amp;f=${encodeURIComponent(rel)}">${t('See what changed')}</a>` : ''}${meta.versions.some(x => x.v === rs.seen) ? `<a href="${esc(itemPath(p, s))}?v=${rs.seen}">${t('Back to v{v}', { v: rs.seen })}</a>` : ''}</p>${since.some(x => x.note) ? `<ul>${since.map(x => `<li><b>v${x.v}</b>${esc(x.note || x.title)}</li>`).join('')}</ul>` : ''}</div>` : '';
  const label = kindLabel(kindOf(rel));
  const fq = `${esc(itemPath(p, s))}?${vq}f=${encodeURIComponent(rel)}`;
  const modeSwitch = fileEntry?.preview && kindOf(rel) === 'docx'
    ? `<b>·</b>${mode === 'text' ? `<a href="${fq}">${t('Layout view')}</a>` : `<a href="${fq}&amp;mode=text">${t('Text view')}</a>`}`
    : '';
  if (rendered && !gallery && rendered.kind === 'md') {
    // 正文第一个大标题和页面标题说的是一回事就不再显示：去掉标点空格后一样、一个包含另一个，或者大部分字相同（agent 常常多写个前缀、换个标点）
    const norm = x => String(x).replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const pairs = x => { const out = new Map(); for (let i = 0; i < x.length - 1; i++) { const k = x.slice(i, i + 2); out.set(k, (out.get(k) || 0) + 1); } return out; };
    // a 是正文标题、b 是页面标题：正文标题比页面标题长很多时（多写了内容）就留着
    const similar = (a, b) => { if (!a || !b) return false; if (a === b || (b.includes(a) && a.length >= b.length * 0.6) || (a.includes(b) && a.length <= b.length + 8)) return true; const A = pairs(a), B = pairs(b); let n = 0; for (const [k, c] of A) n += Math.min(c, B.get(k) || 0); return (2 * n) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1)) >= 0.75; };
    const m = rendered.html.match(/^(<article class="prose">(?:<details class="frontmatter">[\s\S]*?<\/details>)?)<h1 id="([^"]*)">([\s\S]*?)<\/h1>\n?/);
    if (m && similar(norm(m[3]), norm(ver.title))) {
      rendered = { ...rendered, html: m[1] + rendered.html.slice(m[0].length), toc: rendered.toc.filter((x, i) => !(i === 0 && x.depth === 1 && x.id === m[2])) };
    }
  }
  const toc = rendered && !gallery && !diff ? tocHtml(rendered.toc) : { aside: '', mobile: '' };
  const wide = gallery || rendered?.wide;
  const bare = gallery || rendered?.bare;
  const content = diff
    ? `<div class="diff-head"><span>${t('Changes from v{a} to v{b}', { a: diff.fromV, b: diff.toV })}</span><b class="diff-n add">+${diff.added}</b><b class="diff-n del">−${diff.removed}</b><a href="${esc(itemPath(p, s))}${isLatest ? '' : `?v=${ver.v}`}">${t('Back to the document')}</a></div>${diff.html}`
    : gallery
    ? `<div class="gallery">${files.filter(f => f.kind === 'image').map(f => { const u = rawPath(p, s, ver.v, f.path); return `<figure class="shot"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(f.path)}" loading="lazy" decoding="async"></a><figcaption>${esc(f.path)}</figcaption></figure>`; }).join('')}</div>`
    : rendered.html;
  const needs = rendered?.needs || {};
  const pinned = Boolean(PINS().items[`${p}/${s}`]);
  // 手机上只留「置顶」和「⋯」，其余收进菜单（电脑上照常一排）
  const actions = `<div class="doc-actions">
    ${pinButton('item', `${p}/${s}`, pinned, { label: true })}
    <button type="button" class="act icon more-btn" aria-label="${t('More')}" title="${t('More')}" aria-expanded="false" aria-controls="doc-more">${ICON.dots}</button>
    <div class="doc-more" id="doc-more">
    <button type="button" class="act read-toggle">${t('Mark as unread')}</button>
    <button type="button" class="act arch-btn" data-archived="${rs.archived ? 1 : 0}">${rs.archived ? t('Unarchive') : t('Archive')}</button>
    ${diffable && !diff && prevOf(ver) ? `<a class="act" href="${esc(itemPath(p, s))}?v=${ver.v}&amp;diff=${prevOf(ver).v}&amp;f=${encodeURIComponent(rel)}">${t('Compare with v{v}', { v: prevOf(ver).v })}</a>` : ''}
    ${rendered?.kind === 'html' ? `<button type="button" class="act icon fs-btn" title="${t('Full screen (Esc to exit)')}" aria-label="${t('Full screen')}">${ICON.expand}</button>` : ''}
    ${!gallery && ['md', 'docx', 'text', 'code', 'json', 'table'].includes(rendered?.kind) ? `<button type="button" class="act icon print-btn" title="${t('Print or save as PDF')}" aria-label="${t('Print or save as PDF')}">${ICON.printer}</button>` : ''}
    ${gallery ? '' : `<a class="act icon" href="${esc(raw)}"${ACTIVE_RE.test(rel) ? ' data-isolated' : ''} target="_blank" rel="noopener" title="${t('Open original file')}" aria-label="${t('Open original file')}">${ICON.ext}</a><a class="act icon" href="${esc(raw)}" download title="${t('Download')}" aria-label="${t('Download')}">${ICON.down}</a>`}
    </div>
  </div>`;
  const body = `
<div class="doc-page${toc.aside ? ' has-toc' : ''}${wide ? ' wide' : ''}">
  <div class="doc-main">
    <header class="doc-head">
      <div class="doc-kicker"><a href="${esc(projectPath(p))}">${avatar(p, 'xs')}<span>${esc(dname(p))}</span></a><i>/</i><code>${esc(s)}</code></div>
      ${actions}
      <h1 class="doc-title">${esc(ver.title)}</h1>
      <div class="doc-meta"><span class="ver-badge${isLatest ? '' : ' old'}">v${ver.v}</span><time data-rel datetime="${esc(ver.time)}">${fullTime(ver.time)}</time>${ver.agent ? `<b>·</b>${agentTag(ver.agent, true)}` : ''}${hostTag(ver.host) ? `<b>·</b>${hostTag(ver.host)}` : ''}<b>·</b>${(ver.category || 'other') !== 'other' ? `<span class="cat cat-${esc(ver.category)}">${esc(catLabel(ver.category))}</span><b>·</b>` : ''}<span>${gallery ? t('{n} image|{n} images', { n: files.filter(f => f.kind === 'image').length }) : esc(label)}</span>${modeSwitch}${versions || allFiles || sources ? `<b>·</b>${versions}${allFiles}${sources}` : ''}</div>
      ${ver.note || oldBanner || seenBanner || tabs ? `<div class="doc-rest">
        ${ver.note ? `<p class="doc-note">${esc(ver.note)}</p>` : ''}
        ${oldBanner}${seenBanner}
        ${tabs ? `<nav class="tabs" aria-label="${t('Files')}">${tabs}</nav>` : ''}
      </div>` : ''}
    </header>
    ${toc.mobile}
    ${todos ? todoBar(meta, ver, todos) : ''}
    <div class="sheet kind-${gallery ? 'gallery' : esc(rendered.kind)}${bare ? ' bare' : ''}">${content}</div>
    ${needs.approval && rel === ver.main ? approvalForm(meta, ver, isLatest, responses, approvalSummary, mdText) : ''}
    ${(todos || needs.approval) && rel === ver.main ? `<script type="application/json" id="ask-data">${jsonData({ id: `${p}/${s}`, v: ver.v, latest: isLatest, asks: (responses.asks || []).filter(a => a.v <= ver.v) })}</script>` : ''}
    ${commentsPanel(meta, ver, rel, responses, rendered?.kind === 'md')}
  </div>
  ${toc.aside}
</div>`;
  return layout({
    title: `${ver.title} · ${dname(p)} · mydash`, body, page: 'item',
    crumbs: [{ text: dname(p), href: projectPath(p) }, { text: ver.title }],
    data: { project: p, slug: s, id: `${p}/${s}`, seen: rs.seen, version: ver.v, latest: isLatest ? '1' : '0', mermaid: needs.mermaid ? '1' : '0', pdf: needs.pdf ? '1' : '0' },
  });
}
