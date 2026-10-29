// mydash ask "问题" [选项 …] [--multi] [--json] [--timeout 秒]
// 给别的 AI 工具和脚本用：要用户做选择时调它，题目出现在 mydash（按设置推送到手机），用户答完才返回答案。
// 和 Claude Code / Codex 的终端提问走同一套（lib/prompts.mjs）。退出码：0 答了 · 2 取消或超时 · 3 用户要在对话里答
import { readConfig } from './store.mjs';
import { currentAgent, currentSessionId, detectProject } from './agents.mjs';
import { t } from './i18n.mjs';

export async function cmdAsk(pos, opts) {
  const [question, ...options] = pos;
  if (!question) { process.stderr.write(t('Usage: mydash ask "<question>" [option …] [--multi] [--json] [--timeout seconds]') + '\n'); process.exitCode = 1; return; }
  const base = `http://127.0.0.1:${process.env.MYDASH_PORT || readConfig().port || 4870}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(b), signal: AbortSignal.timeout(5000) }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
  const out = (o, text, code) => { if (opts.json) process.stdout.write(JSON.stringify(o) + '\n'); else process.stdout.write(text + '\n'); process.exitCode = code; };
  let created;
  try {
    created = await post('/api/prompts', { tool: currentAgent() || 'cli', kind: 'question', session: currentSessionId() || '', cwd: process.cwd(), project: detectProject(process.cwd()).name,
      payload: { questions: [{ question, header: '', multiSelect: Boolean(opts.multi), options }] } });
  } catch (e) { return out({ ok: false, error: e.message }, t('mydash is not responding: {err}', { err: e.message }), 2); }
  if (!created.id) return out({ ok: false, error: created.error }, t('mydash did not take the question: {err}', { err: created.error || created.status }), 2);
  if (!opts.json) process.stderr.write(t('Waiting for the answer in mydash: {url}', { url: created.url }) + '\n');
  const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
  // mydash 中途停了：等它重启（大约两分钟），一直连不上就放弃；有 --timeout 时，最后一次等待也不超过截止时间
  for (let fails = 0; ;) {
    if (Date.now() > deadline) { await post(`/api/prompts/${created.id}/cancel`, {}).catch(() => {}); return out({ ok: false, status: 'timeout' }, t('No answer yet; stopped waiting.'), 2); }
    let r = null;
    try { r = await (await fetch(`${base}/api/prompts/${created.id}/wait`, { signal: AbortSignal.timeout(Math.max(1000, Math.min(40_000, deadline - Date.now()))) })).json(); fails = 0; }
    catch (e) {
      if (e.name === 'TimeoutError' && Date.now() > deadline) continue;
      if (++fails > 40) return out({ ok: false, status: 'unreachable' }, t('mydash stopped responding; stopped waiting.'), 2);
      await new Promise(x => setTimeout(x, 3000)); continue;
    }
    if (r.status === 'pending') continue;
    if (r.status === 'answered') { const a = Object.values(r.answer.answers || {})[0]; return out({ ok: true, status: 'answered', answer: a }, Array.isArray(a) ? a.join('\n') : String(a), 0); }
    if (r.status === 'released') return out({ ok: false, status: 'released' }, t('The user chose to answer in the conversation instead.'), 3);
    return out({ ok: false, status: r.status }, t('The question was cancelled.'), 2);
  }
}
