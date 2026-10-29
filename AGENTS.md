# Working on mydash

This file is for coding agents changing mydash itself. To install mydash for a user, follow INSTALL.md instead.

## Layout

| Path | What |
|---|---|
| `server.mjs` | Web server, zero framework. Two ports on 127.0.0.1: the workbench (`port`, default 4870) and a read-only content port (`contentPort`, default 4871) where HTML and SVG run, so their scripts cannot reach the workbench API |
| `bin/mydash.mjs` | CLI entry point and argument parsing |
| `lib/publish.mjs` | `mydash publish` / `rebuild`: copies files into a new version, pulls in files referenced from Markdown, refuses secrets |
| `lib/agents.mjs` | Known agents (`AGENTS`), detecting the Claude Code or Codex session and the folder it started in (the project), `MYDASH_AGENT` for other tools, and the `rebuild --agents` backfill from session logs |
| `lib/office.mjs` | Previews: LibreOffice → PDF, PDF → page images (`pdfpages` on macOS, `pdftoppm` on Linux) |
| `lib/render.mjs`, `lib/views.mjs` | File rendering and page templates |
| `lib/setup.mjs`, `lib/checks.mjs`, `lib/service.mjs`, `lib/tailscale.mjs` | Install, doctor, launchd / systemd / Windows Startup folder / plain process, Tailscale |
| `lib/supervise.mjs` | Windows only: started hidden at sign-in, restarts the server if it exits |
| `lib/sys.mjs` | Cross-platform helpers (`which` that understands `PATHEXT`) |
| `lib/integrate.mjs` | Reversible edits to `~/.claude` and `~/.codex`: two rule blocks, the skill link, permissions and sandbox rules, hooks. `refresh()` brings an existing setup up to date on reinstall; `hookHealth()` feeds doctor |
| `lib/categories.mjs` | Item types (plan / report / other, plus approval and to-do) and the title-based guess |
| `lib/responses.mjs`, `lib/feedback.mjs` | Comments the user leaves on items (`responses.json` per item) and `mydash feedback` |
| `lib/approval.mjs`, `lib/waiting.mjs` | Approval forms in Markdown (```approval blocks); their lifecycle (pending / submitted / done / closed in chat / superseded / expired) and `state/open-items.json` |
| `lib/todo.mjs`, `lib/todocheck.mjs` | To-dos: task lists in to-do items, or in ```todo blocks inside any document, that the user ticks off on the page (`mydash todos`); `<!-- check: cmd -->` items tick themselves |
| `lib/prompts.mjs`, `lib/askcli.mjs`, `bin/agent-ask.mjs`, `bin/agent-state.mjs` | Questions from agents: hooks hand Claude Code / Codex choice questions, plan approvals and permission prompts to mydash (`/prompts/<id>`), `mydash ask` for other tools; busy / idle state, the plain-text-question check at Stop, and reminders |
| `lib/diff.mjs` | Line and word diff between versions |
| `lib/quiet.mjs` | Muted projects, manual and automatic archive |
| `lib/search.mjs` | Full-text search over the latest versions |
| `lib/notify.mjs`, `lib/pushguide.mjs` | Notification channels (Bark, ntfy, Telegram, Pushover, group webhooks, email, web push) and the daily summary; the step-by-step setup guide for each channel on the settings page |
| `lib/remote.mjs` | Publishing from another machine with a token (client, token store); server side is `/api/remote/*` in `server.mjs` |
| `lib/lan.mjs` | Same-Wi-Fi access with an access code |
| `lib/maintain.mjs` | `rebuild --dedup`, `rebuild --categories`, `prune` |
| `lib/i18n.mjs`, `lib/locales/zh.mjs` | Interface language |
| `static/` | `app.css`, `app.js`, `pdf-view.mjs`, icons, Geist fonts |
| `skills/mydash/SKILL.md` | The skill agents get after `mydash integrate` |
| `welcome/<lang>/` | The item published right after install |
| `test/smoke.sh` | Detailed end-to-end test (bash; macOS and Linux) with a temp data folder and temp ports |
| `test/e2e.mjs` | Install → publish → pages → doctor → integrate → uninstall, plain Node, also runs on Windows |

Item folders have two locks: `.lock` for versions and `meta.json` (publish, `rm --version`, rebuild) and `.rlock` for `responses.json` (ticks, answers, comments), so the page stays usable while a slow Office conversion holds `.lock`. Holders refresh the lock every 15 seconds; a lock whose holder is gone is taken over at once. Pages on the workbench port carry a CSP that allows only mydash's own scripts, so script inside an item never runs there; if you add an inline `<script>` to a page template, add its hash to `PAGE_CSP` in `lib/views.mjs`.

Runtime files live in `~/.mydash` (`app/` code copy, `data/` items, `state/` read / pin / name / quiet / tokens / LAN sessions, `logs/`, `config.json`). Data layout: `data/<project>/<slug>/meta.json`, `responses.json` (comments) and `v<N>/<files>`. Unchanged files between versions are hard links; never modify a published version in place. `meta.json` carries `schema`; bump `SCHEMA` in `lib/store.mjs` and migrate if you change its shape.

## Commands

```bash
npm ci
bash test/smoke.sh                # must end with 0 failures; never touches ~/.mydash
node test/i18n-check.mjs          # every UI / CLI string has a Chinese translation
node test/e2e.mjs --service none  # cross-platform install test; CI also runs it on Windows
SMOKE_PORT=4880 bash test/smoke.sh   # if 4878 is busy
```

To try a real install without touching an existing one, use a temp home and a plain process:

```bash
MYDASH_HOME=/tmp/md-test ./setup.sh install --access local --port 4890 --service none --bin-dir /tmp/md-test/bin
MYDASH_HOME=/tmp/md-test /tmp/md-test/bin/mydash uninstall --purge
```

Services installed outside the default `~/.mydash` get a suffixed name (`mydash.server-1a2b3c`), so they never collide with the real one.

## Conventions

- **Strings.** User-facing text goes through `t('English text')` (server, CLI) or `T('English text')` (browser). Add the Chinese to `lib/locales/zh.mjs` under the same key. `'one|other'` is a plural pair, `{name}` a placeholder, and `'key@@context'` separates two meanings of the same English word. Run `node test/i18n-check.mjs`.
- **Agent-facing output.** Commands an installer agent runs need `--json`, with `ok`, `fix` hints and `human` steps. Keep them re-runnable.
- **No new runtime dependencies** without a strong reason. The server is plain `node:http`. Avoid packages that pull in frameworks; check `npm ls` after installing anything.
- **Security.** The server listens on 127.0.0.1 only and checks the `Host` header. Write APIs require `X-Mydash: 1`, JSON, and a same-origin `Origin`. Anything that can run script (HTML, SVG) is served to the browser from the content port; on the workbench port it gets `Content-Security-Policy: sandbox`.
- **Comments** may be in Chinese or English; match the surrounding code.
- **Windows.** Never shell out to Unix-only tools without a fallback; use `which()` from `lib/sys.mjs`. `.cmd` files need `shell: true`. Line endings are pinned in `.gitattributes`.
- **Adding an agent.** Add it to `AGENTS` in `lib/agents.mjs` (name, short name) and give it a colour as `--ag-<id>` in `app.css` (light and dark). Detection goes in `currentAgent()` / `detectSession()`.
- Keep the mobile type scale: 12.5 / 13.5 / 16 / 23–26 px, 34 px controls, inputs at 16 px or more (iOS zooms otherwise). Dark mode hangs off `:root[data-theme="dark"]`; do not use `prefers-color-scheme` in CSS.
