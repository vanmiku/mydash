// 审批单：agent 在 Markdown 里写 ```approval 代码块（JSON），网页上渲染成可以点选、输入的表单。
//   { "questions": [ { "id": "go", "type": "choice", "label": "…", "options": ["同意", "不同意"], "required": true },
//                    { "id": "keep", "type": "multi", "label": "…", "options": [{ "value": "a", "label": "A", "hint": "…" }] },
//                    { "id": "note", "type": "text", "label": "…", "placeholder": "…" } ], "submit": "提交" }
// type：choice 单选 · multi 多选 · text 多行文字 · line 一行文字。一份文档里可以有多个代码块，合成一张表单一起提交。
// 单选和多选题都自带「其他」，用户可以写自己的想法；"other": "……" 只改它的名字。agent 自己写的「其他」选项会被它替换掉。
import { t } from './i18n.mjs';
import { fencedBlocks } from './categories.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPES = new Set(['choice', 'multi', 'text', 'line']);
export const OTHER = '__other__';

function normOption(o) { return typeof o === 'object' && o ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? ''), hint: o.hint ? String(o.hint) : '' } : { value: String(o), label: String(o), hint: '' }; }
const OTHER_LABEL_RE = /^\s*(其他|其它|别的|other|others|something else)\s*[:：]?\s*$/i;
function normQuestion(q, i) {
  const type = TYPES.has(q?.type) ? q.type : (Array.isArray(q?.options) ? 'choice' : 'text');
  const choice = type === 'choice' || type === 'multi';
  return {
    id: String(q?.id || `q${i + 1}`).replace(/[^\w.-]/g, '_').slice(0, 40), type, label: String(q?.label || q?.question || `Q${i + 1}`),
    hint: q?.hint ? String(q.hint) : '', required: Boolean(q?.required), other: choice,
    otherLabel: choice && typeof q?.other === 'string' && q.other.trim() ? q.other.trim().slice(0, 60) : '',
    placeholder: q?.placeholder ? String(q.placeholder) : '',
    options: (q?.options || []).map(normOption).filter(o => o.value && !(choice && OTHER_LABEL_RE.test(o.label))),
  };
}
export function parseSpec(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j.questions || [];
  return { questions: list.map(normQuestion), submit: j.submit ? String(j.submit) : '' };
}

// 文档里所有 ```approval 代码块的问题（按出现顺序；id 重复时加后缀）
export function questionsOf(md) {
  const out = []; const seen = new Set();
  let i = 0;
  for (const text of fencedBlocks(md, 'approval')) {
    let spec; try { spec = parseSpec(text); } catch { continue; }
    for (const q of spec.questions) { let id = q.id; while (seen.has(id)) id = `${q.id}_${++i}`; seen.add(id); out.push({ ...q, id }); }
  }
  return out;
}

// 校验并整理答复：{ ok, errors: [id…], answers }
export function validateAnswers(questions, input) {
  const errors = []; const answers = {};
  for (const q of questions) {
    let a = input?.[q.id];
    const values = new Set(q.options.map(o => o.value));
    if (q.type === 'choice') {
      if (a && typeof a === 'object' && a.other != null) a = String(a.other).trim() ? { other: String(a.other).slice(0, 2000) } : null;
      else if (a != null && a !== '') a = values.has(String(a)) ? String(a) : null;
      else a = null;
      if (a && typeof a === 'object' && !q.other) a = null;
    } else if (q.type === 'multi') {
      const arr = Array.isArray(a) ? a : [];
      const picked = arr.filter(x => typeof x === 'string' && values.has(x));
      const other = arr.find(x => x && typeof x === 'object' && x.other != null);
      a = picked.concat(q.other && other && String(other.other).trim() ? [{ other: String(other.other).slice(0, 2000) }] : []);
      if (!a.length) a = null;
    } else {
      a = typeof a === 'string' && a.trim() ? a.slice(0, 10_000) : null;
    }
    if (a == null) { if (q.required) errors.push(q.id); continue; }
    answers[q.id] = a;
  }
  return { ok: errors.length === 0, errors, answers };
}

const showAnswer = (q, a) => {
  const one = x => (x && typeof x === 'object' ? `${q.otherLabel || t('Other@@option')}: ${x.other}` : q.options.find(o => o.value === x)?.label || x);
  return Array.isArray(a) ? a.map(one).join(', ') : one(a);
};
// 给人看、也方便贴给 agent 的文字版
export function summarize(title, v, questions, answers) {
  const lines = [t('Answers to the approval “{title}” (v{v}):', { title, v })];
  for (const q of questions) lines.push(`- ${q.label}: ${answers[q.id] != null ? showAnswer(q, answers[q.id]) : t('(no answer)')}`);
  return lines.join('\n');
}

// 渲染一个代码块里的问题。输入框都挂在页面底部的 <form id="ap-form"> 上（form 属性），所以可以散在正文各处
export function renderBlock(text) {
  let spec; try { spec = parseSpec(text); } catch (e) { return `<div class="ap-error">${esc(t('This approval form is not valid JSON: {msg}', { msg: e.message }))}</div>`; }
  return spec.questions.map(q => {
    const req = q.required ? ` <i class="ap-req" title="${esc(t('Required'))}">*</i>` : '';
    const head = `<legend>${esc(q.label)}${req}</legend>${q.hint ? `<p class="ap-hint">${esc(q.hint)}</p>` : ''}`;
    let body = '';
    if (q.type === 'choice' || q.type === 'multi') {
      const type = q.type === 'choice' ? 'radio' : 'checkbox';
      body = q.options.map(o => `<label class="ap-opt"><input type="${type}" name="${esc(q.id)}" value="${esc(o.value)}" form="ap-form"><span class="ap-mark"></span><span class="ap-text"><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`).join('');
      if (q.other) body += `<label class="ap-opt ap-other"><input type="${type}" name="${esc(q.id)}" value="${OTHER}" form="ap-form"><span class="ap-mark"></span><span class="ap-text"><b>${esc(q.otherLabel || t('Other@@option'))}</b><input type="text" class="ap-other-text" data-for="${esc(q.id)}" form="ap-form" placeholder="${esc(t('Write your own answer'))}" autocomplete="off"></span></label>`;
    } else if (q.type === 'text') body = `<textarea name="${esc(q.id)}" form="ap-form" rows="3" placeholder="${esc(q.placeholder)}"></textarea>`;
    else body = `<input type="text" name="${esc(q.id)}" form="ap-form" placeholder="${esc(q.placeholder)}" autocomplete="off">`;
    return `<fieldset class="ap-q" data-q="${esc(q.id)}" data-type="${q.type}"${q.required ? ' data-required="1"' : ''}>${head}<div class="ap-body ap-${q.type}">${body}</div></fieldset>`;
  }).join('');
}
// 提交按钮的文字：哪个代码块里写了 submit 就用哪个（多个时用最后一个）
export function submitLabel(md) {
  let label = '';
  for (const m of String(md).matchAll(/^\s{0,3}(```|~~~)\s*approval\b[^\n]*\n([\s\S]*?)\n\s{0,3}\1\s*$/gm)) { try { label = parseSpec(m[2]).submit || label; } catch {} }
  return label;
}
