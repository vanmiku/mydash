# Security

mydash is meant for one person's own machine and tailnet. This computer and the tailnet need no login: anyone who can reach the port there can read everything published. Devices on the same Wi-Fi (`--lan on`) log in once with an access code. Keep it on `127.0.0.1` or behind Tailscale, and do not expose it to the internet.

What it does to limit damage:

- The server listens on `127.0.0.1` only and checks the `Host` header (DNS rebinding).
- Write requests need a custom header, a JSON body and a same-origin `Origin`.
- Published HTML and SVG run from a separate port, a different origin, so their scripts cannot call the workbench.
- Workbench pages carry a Content Security Policy that allows only mydash's own scripts; raw `<script>`, `<base>` and `javascript:` links in Markdown and Word documents are neutralised as well.
- To-do auto-checks (`<!-- check: … -->`) run only in explicit to-dos, show their command on the page, have a 15-second limit, and never run for items published from another machine.
- Hooks for Claude Code and Codex leave sessions nobody is watching (`claude -p`, the Agent SDK) alone.
- `mydash publish` refuses `.env` files, private keys and files containing API tokens unless `--allow-secret` is given.

To report a vulnerability, open a [private security advisory](https://github.com/vanmiku/mydash/security/advisories/new) on GitHub rather than a public issue.
