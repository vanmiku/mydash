#!/usr/bin/env node
// mydash：把编程 agent 的中间产物发布到工作台，按项目归档，打印可访问的网址。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, baseUrl, cleanName, itemDir, readMeta, writeMetaAtomic, withLock, itemPath, projectPath, scanAll, latest } from '../lib/store.mjs';
import { syncOpen } from '../lib/waiting.mjs';
import { displayNameOf } from '../lib/names.mjs';
import { detectProject } from '../lib/agents.mjs';
import { cmdPublish, cmdRebuild, fmtTime, UsageError } from '../lib/publish.mjs';
import { health, printChecks, allRequiredOk } from '../lib/checks.mjs';
import { integrate, hookHealth, status as integrationStatus } from '../lib/integrate.mjs';
import { cmdSetup, uninstall, update, cmdLan, printUninstall } from '../lib/setup.mjs';
import { cmdDedup, cmdPrune, cmdCategories } from '../lib/maintain.mjs';
import { cmdFeedback, cmdApprovals, cmdTodos, cmdAsks } from '../lib/feedback.mjs';
import { cmdAsk } from '../lib/askcli.mjs';
import { search } from '../lib/search.mjs';
import { cmdNotify } from '../lib/setup.mjs';
import { cmdRemote, remoteConfig, remoteGet } from '../lib/remote.mjs';
import { t, lang } from '../lib/i18n.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const HELP = {
  en: `mydash ${VERSION}: publish what your coding agent makes to the mydash workbench

Usage
  mydash publish <files or folders...> [options]   publish (same slug again = new version)
  mydash ls [project] [--all]                      list items (default: the current project)
  mydash search <words> [--project p]              search the text of everything published
  mydash url [project[/slug]]                      print a URL
  mydash rm <project>/<slug> [--version N]         delete an item or one version
  mydash rebuild [project[/slug]] [--agents|--dedup]  add missing previews; --agents: which tool published old items; --dedup: link identical files
  mydash prune [project[/slug]] [--keep N]         keep only the latest N versions of each item (default 5)
  mydash feedback [project[/slug]] [--all] [--json]  the user's open comments; feedback done <id> marks them handled
  mydash doctor [--json]                           check that everything works
  mydash integrate claude|codex|all [--dry-run] [--remove] [--no-hooks]   teach Claude Code / Codex to use mydash
  mydash lan [on|off|reset]                        open it on the same Wi-Fi, with an access code
  mydash notify bark|ntfy|telegram|pushover|webhook|email … [--name n] | remove <id> | daily <HH:MM|off> | test | off   push notifications; several of each kind are fine (or use the settings page)
  mydash update | uninstall [--purge] | setup ...  maintenance (see INSTALL.md)
  sudo mydash service boot | login                 macOS: start at boot, before anyone logs in (after setup install --service launchd-boot) / back to starting at login
  mydash forward <port…> | off                     own Tailscale node only: also forward these ports, e.g. 22 5900 for SSH and Screen Sharing

Decisions and to-dos (agents run these; details in the mydash skill)
  mydash ask "<question>" <option…> [--multi]      ask the user in mydash and wait for the answer
  mydash approvals [project[/slug]] | wait <p/s> | close <p/s> --note "…" | done <id>   answers to approval forms
  mydash todos [project[/slug]] | wait <p/s> | done <p/s> "<item>" | check   to-do lists the user ticks off
  mydash asks [--all] | reply <id> "<answer>"      questions the user asked about an item

publish options
  -t, --title    title; default: the first Markdown heading or the file name
  -s, --slug     stable English ID such as launch-plan; publishing the same slug again makes v2, v3
  -n, --note     one line on what changed, shown at the top of the page
      --type     plan | report | other (default: guessed from the title)
      --resolves <id,id…|all>  mark these comments on this item as handled by this version
  -m, --main     with several files, which one opens first
      --name     file name when publishing stdin: cat x.md | mydash publish - --name plan.md
      --json     machine-readable output
      --force    skip the size limits
      --allow-secret   publish even if a file looks like a key or credentials
  -p, --project  normally leave it out: the project is the folder the agent session started in
      --force-project  only when you really mean another project

Local images and files referenced from Markdown are included automatically.
`,
  zh: `mydash ${VERSION}：把编程 agent 的中间产物发布到 mydash 工作台

用法
  mydash publish <文件或目录...> [选项]           发布（同一 slug 再发 = 新版本）
  mydash ls [项目] [--all]                         列出条目（默认当前项目）
  mydash search <关键词> [--project 项目]          在发布过的所有内容的正文里搜索
  mydash url [项目[/slug]]                         打印网址
  mydash rm <项目>/<slug> [--version N]            删除条目或某个版本
  mydash rebuild [项目[/slug]] [--agents|--dedup]  补齐预览；--agents 补记发布工具；--dedup 相同文件改成链接
  mydash prune [项目[/slug]] [--keep N]            每个条目只留最近 N 个版本（默认 5）
  mydash feedback [项目[/slug]] [--all] [--json]    用户还没处理的批注；feedback done <id> 标记已处理
  mydash doctor [--json]                           检查服务和配置
  mydash integrate claude|codex|all [--dry-run] [--remove] [--no-hooks]   让 Claude Code / Codex 用上 mydash
  mydash lan [on|off|reset]                        同一 WiFi 下的设备凭访问码打开
  mydash notify bark|ntfy|telegram|pushover|webhook|email … [--name 名字] | remove <编号> | daily <HH:MM|off> | test | off   推送到手机，同一种也能加好几个（也可以在设置页里填）
  mydash update | uninstall [--purge] | setup ...  维护（见 INSTALL.md）
  sudo mydash service boot | login                 macOS：开机就启动、不用登录（先 setup install --service launchd-boot）/ 改回登录后启动
  mydash forward <端口…> | off                     只用于独立 Tailscale 节点：顺带转发这些端口，比如 22 5900（SSH、屏幕共享）

拍板和待办（agent 用，详见 mydash skill）
  mydash ask "<问题>" <选项…> [--multi]             在 mydash 上问用户，等答完再返回
  mydash approvals [项目[/slug]] | wait <项目/slug> | close <项目/slug> --note "…" | done <id>   审批单的答复
  mydash todos [项目[/slug]] | wait <项目/slug> | done <项目/slug> "<那一项>" | check   用户要勾的待办
  mydash asks [--all] | reply <id> "<回答>"          用户在某一项上问的问题

publish 选项
  -t, --title    标题，默认取 Markdown 的第一个标题或文件名
  -s, --slug     稳定的英文 ID，例如 battle-plan；同一个 slug 再发会变成 v2、v3
  -n, --note     一句话说明，显示在页面顶部
      --type     plan（方案）| report（汇报）| other（其他），默认按标题推断
      --resolves <id,id…|all>  这一版处理了哪些批注（标记为已处理）
  -m, --main     多个文件时，默认打开哪一个
      --name     从标准输入发布时的文件名，例如：cat x.md | mydash publish - --name plan.md
      --json     以 JSON 输出结果
      --force    跳过大小限制
      --allow-secret   文件看起来像密钥或凭据时仍然发布
  -p, --project  一般不要用：项目 = agent 会话启动时所在的文件夹，会自动识别
      --force-project  确实要发到别的项目时才用

Markdown 里引用的本地图片和本地文件会被自动一起带上。
`,
};

const BOOL = new Set(['help', 'json', 'force', 'yes', 'all', 'dry-run', 'remove', 'purge', 'allow-secret', 'version', 'agents', 'dedup', 'categories', 'done', 'hooks', 'no-hooks', 'undo', 'multi']);
const ALIAS = { t: 'title', s: 'slug', p: 'project', n: 'note', m: 'main', h: 'help' };

function parseArgs(argv) {
  const opts = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opts[k] = a.slice(eq + 1);
      else if (BOOL.has(k)) opts[k] = true;
      else opts[k] = argv[++i];
    } else if (a.length === 2 && a[0] === '-' && a !== '-') {
      const k = ALIAS[a[1]] || a[1];
      if (BOOL.has(k)) opts[k] = true; else opts[k] = argv[++i];
    } else pos.push(a);
  }
  return { opts, pos };
}

function die(msg, code = 1) { process.stderr.write(`mydash: ${msg}\n`); process.exit(code); }

async function cmdLs(pos, opts) {
  const want = opts.all ? '' : (pos[0] || detectProject(process.cwd()).name);
  // 发布到别的机器时，列的是那边的条目
  const rc = remoteConfig();
  if (rc) {
    const list = await remoteGet(rc, `/api/remote/items${want ? `?project=${encodeURIComponent(want)}` : ''}`);
    if (opts.json) { process.stdout.write(JSON.stringify(list) + '\n'); return; }
    if (!list.length) { process.stdout.write(t('(none)') + '\n'); return; }
    for (const m of list) process.stdout.write(`${fmtTime(m.updated)}  v${String(m.version).padEnd(3)} ${(m.project + '/' + m.slug).padEnd(40)} ${m.title}\n`);
    return;
  }
  const items = scanAll().filter(m => !want || m.project === want);
  if (opts.json) { process.stdout.write(JSON.stringify(items.map(m => ({ project: m.project, slug: m.slug, title: m.title, version: latest(m).v, updated: m.updated, url: baseUrl() + itemPath(m.project, m.slug) }))) + '\n'); return; }
  if (!opts.all && !pos[0]) process.stdout.write(t('Items in project {p} (--all for everything):', { p: want }) + '\n');
  if (!items.length) { process.stdout.write(t('(none)') + '\n'); return; }
  for (const m of items) {
    const l = latest(m);
    const disp = displayNameOf(m.project);
    process.stdout.write(`${fmtTime(m.updated)}  v${String(l.v).padEnd(3)} ${(m.project + '/' + m.slug).padEnd(40)} ${m.title}${disp !== m.project ? `  [${disp}]` : ''}\n`);
  }
}

function cmdUrl(pos) {
  const target = pos[0]; const base = remoteConfig()?.url || baseUrl();
  if (!target) { process.stdout.write(base + '/\n'); return; }
  const [project, slug] = target.split('/');
  process.stdout.write(base + (slug ? itemPath(project, slug) : projectPath(project)) + '\n');
}

async function cmdRm(pos, opts) {
  const target = pos[0]; if (!target || !target.includes('/')) die(t('Usage: mydash rm <project>/<slug> [--version N]'));
  const [project, slug] = target.split('/');
  const dir = itemDir(cleanName(project), cleanName(slug));
  if (!dir.startsWith(DATA_DIR + path.sep)) die(t('Invalid path'));
  const meta = readMeta(project, slug); if (!meta) die(t('No such item: {id}', { id: target }));
  if (opts.version) {
    const v = Number(opts.version);
    await withLock(dir, async () => {
      const m = readMeta(project, slug);
      m.versions = m.versions.filter(x => x.v !== v);
      await fsp.rm(path.join(dir, `v${v}`), { recursive: true, force: true });
      if (!m.versions.length) { await fsp.rm(dir, { recursive: true, force: true }); return; }
      const l = m.versions[m.versions.length - 1]; m.title = l.title; m.updated = l.time; m.kind = l.kind;
      await writeMetaAtomic(dir, m);
    });
    process.stdout.write(t('Deleted v{v} of {id}', { v, id: target }) + '\n');
  } else {
    await fsp.rm(dir, { recursive: true, force: true });
    try { if (!fs.readdirSync(path.dirname(dir)).length) fs.rmdirSync(path.dirname(dir)); } catch {}
    process.stdout.write(t('Deleted {id} ({n} version)|Deleted {id} ({n} versions)', { id: target, n: meta.versions.length }) + '\n');
  }
  // 删掉的审批单、待办不能还挂在「还开着的事」里（钩子据此提醒 agent）
  await syncOpen(cleanName(project), cleanName(slug));
}

async function cmdDoctor(opts) {
  // 只装了命令行、发布到别的机器：看那边连不连得上
  const rc = remoteConfig();
  if (rc) {
    let r = null, err = ''; try { r = await remoteGet(rc, '/api/remote/ping'); } catch (e) { err = e.message; }
    const dp = detectProject(process.cwd());
    const res = { ok: Boolean(r), remote: rc.url, host: r?.host || null, error: err || null, project: dp };
    if (opts.json) process.stdout.write(JSON.stringify(res) + '\n');
    else process.stdout.write(`${r ? '✓' : '✗'} remote           ${rc.url}${r ? ` · ${r.host} · ${r.name}` : ` · ${err}`}\n\n${t('Publishing here goes to project: {name} (because: {why})', { name: dp.name, why: dp.source })}\n`);
    if (!r) process.exitCode = 1;
    return;
  }
  const h = await health();
  const dp = detectProject(process.cwd());
  const integ = { claude: integrationStatus('claude'), codex: integrationStatus('codex') };
  for (const a of ['claude', 'codex']) {
    const s = integ[a]; if (!s.present) continue;
    const name = a === 'claude' ? 'Claude Code' : 'Codex';
    const PART = { 'publish-rule': t('the publish rule'), 'decide-rule': t('the rule for choices and to-dos'), skill: t('the skill'), permissions: t('permissions'), rules: t('sandbox rules'), hooks: t('hooks') };
    const partial = !s.integrated && s.missing.length < 5;
    h.checks.push({ id: `integrate-${a}`, ok: s.integrated, level: 'optional', detail: s.integrated ? t('{agent} is set up to use mydash', { agent: name }) : partial ? t('{agent} is set up, but these are missing or old: {list}', { agent: name, list: s.missing.map(m => PART[m]).join(', ') }) : t('{agent} is not set up to use mydash yet', { agent: name }), fix: s.integrated ? undefined : t('Ask the user, then run: mydash integrate {a} (preview with --dry-run)', { a }) });
    // 装过钩子的才查：缺了、指向的文件没了、Codex 里还没信任
    const hh = hookHealth(a); if (!hh) continue;
    const bad = [!hh.complete && t('some mydash hooks are missing or out of date'), hh.missing.length && t('a hook points to a file that no longer exists: {files}', { files: hh.missing.join(', ') }), hh.untrusted && t('{n} mydash hook is not trusted in Codex yet, so it does not run|{n} mydash hooks are not trusted in Codex yet, so they do not run', { n: hh.untrusted })].filter(Boolean);
    h.checks.push({ id: `hooks-${a}`, ok: !bad.length, level: 'recommended', detail: bad.length ? bad.join('; ') : t('{agent}: questions and approvals come to mydash', { agent: a === 'claude' ? 'Claude Code' : 'Codex' }),
      fix: !hh.complete || hh.missing.length ? t('Run ./setup.sh install from the mydash source folder') : hh.untrusted ? t('Open Codex in a terminal, type /hooks and trust the mydash hooks') : undefined });
  }
  const ok = allRequiredOk(h.checks);
  if (opts.json) { process.stdout.write(JSON.stringify({ ok, version: VERSION, ...h, project: dp, integrations: integ }) + '\n'); if (!ok) process.exitCode = 1; return; }
  printChecks(h.checks);
  process.stdout.write(`\n${t('Publishing here goes to project: {name} (because: {why})', { name: dp.name, why: dp.source })}\n${t('Data folder: {dir}', { dir: DATA_DIR })}\n${h.url}/\n`);
  if (!ok) process.exitCode = 1;
}

async function cmdIntegrate(pos, opts) {
  const which = pos[0] === 'all' ? ['claude', 'codex'] : [pos[0]];
  if (!['claude', 'codex'].includes(which[0])) die(t('Usage: mydash integrate claude|codex|all [--dry-run] [--remove]'));
  const res = {};
  for (const a of which) res[a] = integrate(a, { remove: Boolean(opts.remove), dryRun: Boolean(opts['dry-run']), hooks: !opts['no-hooks'] });
  if (opts.json) { process.stdout.write(JSON.stringify({ ok: true, dryRun: Boolean(opts['dry-run']), remove: Boolean(opts.remove), changes: res }) + '\n'); return; }
  for (const [a, plan] of Object.entries(res)) {
    process.stdout.write(`${a === 'claude' ? 'Claude Code' : 'Codex'}${opts['dry-run'] ? ' ' + t('(dry run, nothing changed)') : ''}\n`);
    if (!plan.length) process.stdout.write('  ' + t('nothing to do') + '\n');
    for (const p of plan) process.stdout.write(`  ${p.action.padEnd(18)} ${p.file.replace(process.env.HOME, '~')}${p.detail ? `  ${p.detail}` : ''}\n`);
  }
}

// 输出接到 head / grep -q 时，对方提前关管道属正常情况
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const [cmd, ...rest] = process.argv.slice(2);
const { opts, pos } = parseArgs(rest);
if (cmd === '--version' || cmd === '-v' || cmd === 'version') { process.stdout.write(VERSION + '\n'); process.exit(0); }
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help' || (opts.help && cmd !== 'setup')) { process.stdout.write(HELP[lang()] || HELP.en); process.exit(0); }
try {
  switch (cmd) {
    case 'publish': case 'pub': await cmdPublish(pos, opts); break;
    case 'ls': case 'list': await cmdLs(pos, opts); break;
    case 'url': cmdUrl(pos); break;
    case 'rm': case 'remove': await cmdRm(pos, opts); break;
    case 'doctor': case 'status': await cmdDoctor(opts); break;
    case 'rebuild': if (opts.dedup) await cmdDedup(pos, opts); else if (opts.categories) await cmdCategories(pos, opts); else await cmdRebuild(pos, opts); break;
    case 'prune': await cmdPrune(pos, opts); break;
    case 'feedback': await cmdFeedback(pos, opts); break;
    case 'search': {
      const hits = search(scanAll().filter(m => !opts.project || m.project === opts.project), pos.join(' '));
      const plain = s => s.replace(/<\/?mark>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (opts.json) process.stdout.write(JSON.stringify(hits.map(h => ({ item: `${h.m.project}/${h.m.slug}`, title: h.m.title, url: baseUrl() + itemPath(h.m.project, h.m.slug), hits: h.hits, snippet: plain(h.snippet) }))) + '\n');
      else if (!hits.length) process.stdout.write(t('No matches.') + '\n');
      else for (const h of hits) process.stdout.write(`${h.m.project}/${h.m.slug} · ${h.m.title}\n  ${plain(h.snippet)}\n  ${baseUrl() + itemPath(h.m.project, h.m.slug)}\n`);
      break;
    }
    case 'forward': {
      // mydash forward 22 5900 | off：独立节点（access tailscale-node）上原样转发这些 TCP 端口——重启后还没人登录时，
      // 也能从 tailnet 用屏幕共享（5900）、SSH（22）连进来登录这台机器。不带参数看现在转发了哪些
      const TSm = await import('../lib/tailscale.mjs'); const st = await import('../lib/store.mjs');
      const c = st.readConfig(); const tg = TSm.nodeTarget(); const cur = Array.isArray(c.nodeTcp) ? c.nodeTcp : [];
      if (c.access !== 'tailscale-node') die(t('Only for installs with their own Tailscale node (--access tailscale-node).'));
      let next = cur;
      if (pos[0] === 'off') { for (const p of cur) TSm.serveTcpOff(tg, p); next = []; }
      else if (pos.length) {
        const ports = pos.map(Number);
        if (!ports.every(p => Number.isInteger(p) && p > 0 && p < 65536) || ports.some(p => [80, 443, c.contentPort, 4872].includes(p))) die(t('Usage: mydash forward <port…> | off   (e.g. mydash forward 22 5900)'));
        for (const p of cur.filter(p => !ports.includes(p))) TSm.serveTcpOff(tg, p);
        for (const p of ports) { const r = TSm.serveTcp(tg, p); if (!r.ok) die(r.out.trim()); }
        next = [...new Set(ports)];
      }
      if (next !== cur) st.updateConfig(x => ({ ...x, nodeTcp: next }));
      const host = (TSm.names(TSm.status(tg) || {}).fqdn) || c.hostname || 'mydash';
      process.stdout.write(next.length ? t('Forwarded on {host}: {ports}. Screen Sharing: vnc://{host} · SSH: ssh {user}@{host}', { host, ports: next.join(', '), user: os.userInfo().username }) + '\n' : t('No ports forwarded on the mydash node.') + '\n');
      break;
    }
    case 'service': {
      // sudo mydash service boot | login：开机就启动 / 改回登录后启动（macOS，要管理员权限）
      const { bootServices } = await import('../lib/service.mjs');
      if (!['boot', 'login'].includes(pos[0])) die(t('Usage: sudo mydash service boot | login'));
      const r = bootServices(pos[0]);
      if (opts.json) process.stdout.write(JSON.stringify(r) + '\n');
      else { for (const d of r.done || []) process.stdout.write(`✓ ${d}\n`); if (r.error) process.stdout.write(`✗ ${r.error}${r.fix ? `\n  ${r.fix}` : ''}\n`); if (r.next) process.stdout.write(`${r.next}\n`); }
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'approvals': await cmdApprovals(pos, opts); break;
    case 'todos': await cmdTodos(pos, opts); break;
    case 'asks': await cmdAsks(pos, opts); break;
    case 'ask': await cmdAsk(pos, opts); break;
    case 'setup': await cmdSetup(pos, opts); break;
    case 'integrate': await cmdIntegrate(pos, opts); break;
    case 'lan': await cmdLan(pos, opts); break;
    case 'notify': await cmdNotify(pos, opts); break;
    case 'remote': await cmdRemote(pos, opts); break;
    case 'uninstall': { const r = await uninstall({ purge: Boolean(opts.purge) }); if (opts.json) process.stdout.write(JSON.stringify(r) + '\n'); else printUninstall(r); if (r.ok === false) process.exitCode = 1; break; }
    case 'update': { const r = await update(); if (opts.json) process.stdout.write(JSON.stringify(r) + '\n'); else { process.stdout.write((r.ok ? (r.updated ? t('Updated:') + '\n' + r.changes.map(c => '  ' + c).join('\n') : t('Already up to date; reinstalled.')) : r.error) + '\n'); if (r.url) process.stdout.write(r.url + '\n'); } if (!r.ok) process.exitCode = 1; break; }
    default: die(t('Unknown command: {cmd}; see mydash --help', { cmd }));
  }
} catch (e) {
  if (e instanceof UsageError) die(e.message);
  throw e;
}
