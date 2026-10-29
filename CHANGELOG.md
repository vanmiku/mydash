# Changelog

## 0.1.0 (2026-10)

First public version.

- Publish Markdown, PDF, images, HTML, CSV and Excel, Word and PowerPoint, audio, video and code; read them rendered on a computer or a phone.
- Projects by folder, detected from Claude Code and Codex session records; versions, unread state, pins, search, project renaming, dark mode.
- Shows which tool published each item (Claude Code, Codex, or any tool that sets `MYDASH_AGENT`), with a filter by tool; `mydash rebuild --agents` fills this in for older items.
- Installed by a coding agent: `INSTALL.md`, `setup.sh` / `setup.cmd` with `--json`, `mydash doctor`, `mydash integrate claude|codex` (reversible), `mydash update`, `mydash uninstall`.
- macOS (launchd), Linux (systemd user units) and Windows (Startup folder). Access only on this computer, or over Tailscale.
- HTML and SVG run on a separate port; publishing refuses secrets; English and Chinese interface.
- Comments on items (including on a selected passage) that agents read with `mydash feedback` and close with `--resolves`.
- Item types (plan / report / other) with filters; version comparison; Today page; muting, archiving and automatic archiving.
- Full-text search (`mydash search`); Bark / ntfy notifications; print / save as PDF.
- Publishing from another machine with a token (`mydash remote`, `setup install --remote`).
- Same-Wi-Fi access with an access code (`mydash lan`).
- Unchanged files are hard-linked between versions; `mydash rebuild --dedup` and `mydash prune`.
- Approval forms (```approval blocks), to-do lists the user ticks off (auto-ticked by `<!-- check: -->` commands in explicit to-dos), and "ask about this item" threads; `mydash approvals`, `todos`, `asks`, with `wait` to wake the agent.
- Questions, plan approvals and permission prompts from Claude Code and Codex (CLI and the ChatGPT desktop app) also show in mydash; `mydash ask` for any other tool.
- Notification channels: Bark, ntfy, Telegram, Pushover, group webhooks (WeCom, Feishu, DingTalk, Slack, Discord), email over SMTP and web push; several of each, each with a name and an on/off switch.
- macOS: `--service launchd-boot` starts mydash at boot, before anyone logs in; `mydash forward` passes SSH or Screen Sharing through the dedicated Tailscale node.
- Page language per device; settings save as you change them.
- Each notification channel on the settings page has a step-by-step setup guide (English and Chinese); the email guide fills in the server settings for Gmail, QQ Mail, 163 Mail and iCloud.

Security and robustness, from a code review before release:

- Workbench pages carry a Content Security Policy, and Markdown / Word content can no longer run script there (raw `<script>`, `<base>`, `<meta>` and `javascript:` links are neutralised).
- The LAN login check uses the same normalised path as the router, so a remote-publishing token cannot reach other APIs; path segments with an encoded `/` are refused; the post-login redirect only goes to this site.
- To-do auto-checks run only in explicit to-dos and show their command; a timeout kills the whole process group.
- Item locks are refreshed while held and never removed by someone else; page actions use their own lock; Office conversion no longer blocks the server.
- Uninstalling or updating one install no longer touches another install's rules, hooks or Codex rules; hook updates keep their position (Codex trust is positional); hooks the user removed stay removed; settings files keep their formatting.
- `claude -p` sessions are left alone by the hooks; subagent and parallel permission prompts are matched to the right tool call; the Codex desktop app's `request_user_input_async` is handled.
- `sudo mydash service boot` parses the plists with `plutil` and only touches the caller's own services; uninstalling a boot-time setup asks for that step first.
