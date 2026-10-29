// End-to-end test that runs on macOS, Linux and Windows (no bash needed):
// install into a temp home → publish → pages and content port → doctor → integrate / remove → uninstall.
// Usage: node test/e2e.mjs [--service none|launchd|systemd|startup] [--port 4890]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const service = arg('--service', 'none');
const port = Number(arg('--port', 4890));
const WIN = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-e2e-'));
const env = { ...process.env, MYDASH_HOME: path.join(tmp, 'home'), MYDASH_CLAUDE_HOME: path.join(tmp, 'claude'), MYDASH_CODEX_HOME: path.join(tmp, 'codex'), MYDASH_CLAUDE_PROJECTS: path.join(tmp, 'none'), MYDASH_LANG: 'en' };
delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID; delete env.MYDASH_PORT; delete env.MYDASH_BASE_URL;
fs.mkdirSync(env.MYDASH_CLAUDE_HOME, { recursive: true }); fs.mkdirSync(env.MYDASH_CODEX_HOME, { recursive: true });
const bin = path.join(tmp, 'bin');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const node = (args, opts = {}) => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 600_000, ...opts });
// the installed command, the way a user's shell would run it
const mydash = (args, opts = {}) => WIN
  ? spawnSync(path.join(bin, 'mydash.cmd'), args, { env, encoding: 'utf8', shell: true, timeout: 300_000, ...opts })
  : spawnSync(path.join(bin, 'mydash'), args, { env, encoding: 'utf8', timeout: 300_000, ...opts });
const json = r => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: false, raw: (r.stdout || '') + (r.stderr || '') }; } };
// node:http instead of fetch: fetch silently ignores a custom Host header
const get = (url, host) => new Promise(resolve => {
  const u = new URL(url);
  const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { Host: host } : {}, timeout: 5000 }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, text, headers: { get: k => res.headers[k.toLowerCase()] } }));
  });
  req.on('error', e => resolve({ status: 0, text: String(e) })); req.on('timeout', () => req.destroy(new Error('timeout')));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = `http://127.0.0.1:${port}`, C = `http://127.0.0.1:${port + 1}`;

console.log(`mydash e2e · ${process.platform} · service=${service} · ${tmp}`);
try {
  console.log('install');
  const ins = json(node([path.join(ROOT, 'bin', 'mydash.mjs'), 'setup', 'install', '--access', 'local', '--port', String(port), '--service', service, '--office', 'no', '--bin-dir', bin, '--lang', 'en', '--json'], { cwd: ROOT }));
  ok('setup install ok', ins.ok, JSON.stringify(ins).slice(0, 400));
  ok('command installed', fs.existsSync(path.join(bin, WIN ? 'mydash.cmd' : 'mydash')));
  if (!WIN) ok('config.json is readable only by the user', (fs.statSync(path.join(env.MYDASH_HOME, 'config.json')).mode & 0o777) === 0o600);
  if (WIN) ok('Git Bash command installed too', fs.existsSync(path.join(bin, 'mydash')));
  ok('workbench port answers', (await get(`${B}/healthz`)).status === 200);
  ok('content port answers', (await get(`${C}/healthz`, `127.0.0.1:${port + 1}`)).status === 200);

  console.log('publish');
  const fx = path.join(tmp, 'fx');
  node([path.join(ROOT, 'test', 'fixtures.mjs'), fx]);
  const p1 = json(mydash(['publish', 'plan.md', '-p', 'e2e', '--slug', 'plan', '--json'], { cwd: fx }));
  ok('publish Markdown', p1.ok && p1.version === 1, JSON.stringify(p1).slice(0, 300));
  ok('Markdown image came along', fs.existsSync(path.join(env.MYDASH_HOME, 'data', 'e2e', 'plan', 'v1', 'img', 'chart.png')));
  const p2 = json(mydash(['publish', 'report.pdf', '-p', 'e2e', '--slug', 'pdf', '--json'], { cwd: fx }));
  ok('publish PDF', p2.ok);
  const p3 = json(mydash(['publish', 'site', '-p', 'e2e', '--slug', 'site', '--json'], { cwd: fx }));
  ok('publish an HTML folder', p3.ok);
  const p4 = json(mydash(['publish', 'plan.md', '-p', 'e2e', '--slug', 'plan', '--note', 'second', '--json'], { cwd: fx }));
  ok('same slug again makes v2', p4.version === 2);
  await sleep(400);

  console.log('pages');
  const home = await get(`${B}/`);
  ok('home lists the item', home.status === 200 && home.text.includes('/p/e2e/plan'));
  const item = await get(`${B}/p/e2e/plan`);
  ok('item page renders', item.status === 200 && item.text.includes('class="prose"'));
  const raw = await get(`${C}/f/e2e/site/v1/index.html`, `127.0.0.1:${port + 1}`);
  ok('HTML served from the content port', raw.status === 200 && /<html/i.test(raw.text));
  const sandboxed = await get(`${B}/f/e2e/site/v1/index.html`);
  ok('HTML on the workbench port is sandboxed', /sandbox/.test(sandboxed.headers?.get?.('content-security-policy') || ''));
  ok('wrong Host is refused', (await get(`${B}/`, 'evil.example')).status === 421);

  console.log('doctor');
  const doc = json(mydash(['doctor', '--json']));
  ok('doctor ok', doc.ok, JSON.stringify(doc.checks?.filter(c => !c.ok)).slice(0, 400));

  console.log('integrate');
  fs.writeFileSync(path.join(env.MYDASH_CLAUDE_HOME, 'CLAUDE.md'), '# mine\n');
  mydash(['integrate', 'claude']); mydash(['integrate', 'codex']);
  ok('Claude Code rule added', fs.readFileSync(path.join(env.MYDASH_CLAUDE_HOME, 'CLAUDE.md'), 'utf8').includes('mydash:begin'));
  ok('skill linked', fs.existsSync(path.join(env.MYDASH_CLAUDE_HOME, 'skills', 'mydash', 'SKILL.md')));
  ok('Codex rules written', fs.existsSync(path.join(env.MYDASH_CODEX_HOME, 'rules', 'mydash.rules')));
  mydash(['integrate', 'claude', '--remove']); mydash(['integrate', 'codex', '--remove']);
  ok('Claude Code rule removed cleanly', fs.readFileSync(path.join(env.MYDASH_CLAUDE_HOME, 'CLAUDE.md'), 'utf8') === '# mine\n');
  ok('Codex rules removed', !fs.existsSync(path.join(env.MYDASH_CODEX_HOME, 'rules', 'mydash.rules')));

  console.log('uninstall');
  const un = json(mydash(['uninstall', '--purge', '--json']));
  ok('uninstall ok', un.ok);
  await sleep(1500);
  ok('server stopped', (await get(`${B}/healthz`)).status === 0);
  ok('home folder removed', !fs.existsSync(env.MYDASH_HOME));
} finally {
  // make sure nothing is left running even if a step failed
  node([path.join(ROOT, 'bin', 'mydash.mjs'), 'uninstall', '--purge', '--json']);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
