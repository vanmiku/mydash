import { Lexer } from 'marked';

// 条目类型：审批 / 待办 / 方案 / 汇报 / 其他。agent 发布时用 --type 指定；没指定时：
// 含审批表单（```approval 代码块）的是审批，其余按标题和 slug 里的关键词推断，都不像就是"其他"。
// 待办：要用户自己动手的事（agent 做不了的），写成任务清单，用户在网页上勾掉。方案里也可以用 ```todo 块嵌一段待办，类型不变。
export const CATEGORIES = ['approval', 'todo', 'plan', 'report'];
export const CATEGORY_LABEL = { approval: 'Approval', todo: 'To-do', plan: 'Plan', report: 'Report', other: 'Other' };

const TODO_RE = /待办|要你做|你要做|你来做|需要你(做|处理|操作|动手)|手动(操作|完成|处理)|行动项|\b(to-?dos?|action items?|checklist)\b/i;
const PLAN_RE = /方案|计划|规划|提案|设计稿|路线图|策略|\b(plan|planning|proposal|spec|roadmap|design|strategy|rfc)\b/i;
const REPORT_RE = /汇报|报告|进度|总结|周报|日报|月报|复盘|结果|调研|研究|分析|对比|评估|发现|清单|核验|核对|盘点|走查|验收|试点|记录|排查|测试结果|\b(report|summary|status|progress|review|research|analysis|findings|comparison|audit|retro)\b/i;

// 文档里某种语言的代码块内容，按出现顺序。和页面渲染用同一个解析器：缩进在列表里的块也算，代码块里的代码块不算
export function fencedBlocks(md, lang) {
  const out = [];
  const walk = tokens => {
    for (const tk of tokens || []) {
      if (tk.type === 'code') { if (String(tk.lang || '').trim().split(/\s+/)[0].toLowerCase() === lang) out.push(tk.text); continue; }
      if (tk.type === 'list') { for (const it of tk.items) walk(it.tokens); continue; }
      if (tk.tokens) walk(tk.tokens);
    }
  };
  try { walk(Lexer.lex(String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), { gfm: true })); } catch {}
  return out;
}
export const hasApprovalBlock = md => /(```|~~~)\s*approval\b/i.test(String(md || '')) && fencedBlocks(md, 'approval').length > 0;

export function normCategory(v) {
  const s = String(v || '').toLowerCase().trim();
  const map = { approval: 'approval', approve: 'approval', 审批: 'approval', todo: 'todo', 'to-do': 'todo', todos: 'todo', 待办: 'todo', plan: 'plan', 方案: 'plan', 计划: 'plan', report: 'report', 汇报: 'report', 报告: 'report', other: 'other', 其他: 'other' };
  return Object.hasOwn(map, s) ? map[s] : null;
}

export function inferCategory({ title = '', slug = '', md = '' } = {}) {
  if (hasApprovalBlock(md)) return 'approval';
  const text = `${title} ${String(slug).replace(/[-_]+/g, ' ')}`;
  if (TODO_RE.test(text)) return 'todo';
  if (PLAN_RE.test(text)) return 'plan';
  if (REPORT_RE.test(text)) return 'report';
  return 'other';
}
