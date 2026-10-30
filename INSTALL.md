# Installing mydash: instructions for coding agents

You are a coding agent (Claude Code, Codex, or similar) and the user asked you to install mydash. Follow these steps in order. Every command is safe to re-run. Use `--json` and read the results instead of guessing.

**Rules**

- Talk to the user in their language. Keep it short: say what you are about to do, ask the questions in step 3, and report the URL at the end.
- Never type passwords or approve logins for the user. When a step needs the user (marked **user**), show them exactly what to do and wait.
- Ask before you change anything outside the mydash folders: shell profiles, `~/.claude`, `~/.codex`, package installs that need `sudo`.
- Supported: macOS, Linux (including WSL) and Windows 10/11. On Windows, run `setup.cmd` wherever this guide says `./setup.sh` (it works from PowerShell, cmd and Git Bash), and see [Windows notes](#windows-notes).

## 1. Get the code

```bash
git clone https://github.com/vanmiku/mydash ~/.mydash/src
cd ~/.mydash/src
```

On macOS, keep the checkout out of `~/Documents`, `~/Desktop` and `~/Downloads`: background services cannot read those folders. The installer copies the code to `~/.mydash/app` anyway, so this only matters for `mydash update`.

Windows (PowerShell):

```powershell
git clone https://github.com/vanmiku/mydash $HOME\.mydash\src
cd $HOME\.mydash\src
```

## 2. Check the machine

```bash
./setup.sh check --json
```

It needs Node.js 20 or newer. If `node` is missing, the script prints `{"ok":false,"error":"node-missing",...}`: install Node (macOS: `brew install node`; Windows: `winget install --id OpenJS.NodeJS.LTS -e`, then open a new terminal), then run it again.

Read the result:

- `checks`: one entry per item, each with `ok`, `level` (`required`, `recommended`, `optional`, `info`), `detail` and, when something is missing, `fix`. Entries with `"human": true` need the user.
- `recommend`: suggested values for the install options.
- `questions`: what to ask the user in step 3, with the recommended answer.

Fix every failing `required` check before going on. `optional` ones only switch features off (Office previews, PDF page images, Tailscale access); offer to fix them, but do not insist.

## 3. Ask the user

Ask everything in `questions` in one message, with the recommended answers pre-selected. Typically:

1. **Where should it open?**
   - `local`: only on this computer, at `http://127.0.0.1:4870/`.
   - `tailscale`: on their other devices too, phone included, through the Tailscale they already use, at `http://<this-machine>/`. Recommended when `check` shows Tailscale running.
   - `tailscale-node`: through Tailscale under its own name, `http://mydash/`. This adds one device to their tailnet and needs one approval click. Every device that opens this address needs Tailscale, this computer included; without it, this computer uses `http://127.0.0.1:4870/`. If the tailnet already has a device called `mydash` (an old computer, say), Tailscale names this one `mydash-1`, and that becomes the address. On macOS it builds Tailscale from source, so it needs Go. Not available on Windows.
2. **Same Wi-Fi?** Whether other devices on the same Wi-Fi (or wired network) may open it too. They log in once with an access code; this computer and the tailnet never need it. Add `--lan on` if yes. Recommend it only on a home network the user trusts.
3. **Language** of the pages: `en` or `zh`. Default to the language the user writes in.
4. **Timezone**, only when the server clock is UTC (common on cloud servers). Use an IANA name such as `Europe/London` or `Asia/Shanghai`.
5. **Office previews**, only if LibreOffice is missing: offer to install it (a large download; on Linux it needs `sudo`).

## 4. Install

```bash
./setup.sh install --access <local|tailscale|tailscale-node> [--lan on] --lang <en|zh> [--timezone <tz>] --json
```

It takes 10–60 seconds. Building the Tailscale node on macOS can take several minutes. The result has:

- `ok`, and `url`: the address to give the user. With `tailscale-node` it is `http://127.0.0.1:<port>/` until the device is approved, then switches to the device's real name on its own.
- `localUrl`: the address that always works on this computer.
- `steps`: what was done. Any step with `ok: false` has the reason in `detail`.
- `human`: things only the user can do. Show each one to the user, with its `url` or `command`, and wait for them:
  - `tailscale-node-login`: the user opens the link and approves the new device. Forwarding starts automatically within a minute.
  - `tailscale-node-name`: the name was taken, so the device has a different one. Tell the user the real address and how to get the name back.
  - `tailscale-this-computer`: this computer is not on the tailnet. Tell the user to use `localUrl` here, or to install Tailscale on it.
  - `tailscale-operator` (Linux): the user runs `sudo tailscale set --operator=$USER`, then you run step 4 again.
  - `tailscale-login`: the user logs in to Tailscale, then you run step 4 again.
  - Entries with `"agent": true` you may do yourself after asking. For example, add `~/.local/bin` to `PATH` in their shell profile.
- `next`: suggested follow-ups, usually step 6.

On Linux with systemd, if `check` reported `linger` as disabled, ask the user to run `sudo loginctl enable-linger $USER`. Without it, mydash stops when they log out.

On macOS, mydash starts when the user logs in. For a Mac that should come back after a power cut or restart without anyone logging in (a headless Mac mini, say), install with `--service launchd-boot`; the result then lists a `boot-service` step: the user runs `sudo mydash service boot` once. mydash and its Tailscale node then run at boot, as the user, before login. FileVault must be off for that, because with FileVault on the Mac waits at the unlock screen. `sudo mydash service login` switches back.

## 5. Verify

```bash
mydash doctor --json
```

`ok` must be true. If it is not, follow the `fix` of each failing check, then run doctor again. If `mydash` is not found, use `~/.local/bin/mydash` and fix `PATH` (step 4).

Then publish something real and show it to the user:

```bash
mydash publish README.md --title "mydash is installed" --slug hello --note "test"
```

Give the user the printed URL and ask them to open it on their phone as well, if they chose Tailscale. The install already added a welcome item to the project called `mydash`.

## 6. Connect the agents (ask first)

This teaches the agent to publish here and to bring the user's decisions and to-dos here:

```bash
mydash integrate claude --dry-run     # show the user what would change
mydash integrate claude
mydash integrate codex --dry-run
mydash integrate codex
```

Run it for each agent the user uses (`check` lists which are installed), after they agree to the dry-run output. What it adds:

- **Two short rules** in the agent's global instructions, each between markers: publish deliverables with `mydash publish`; and put choices, approval forms and to-dos for the user through mydash instead of asking in the reply.
- **The `mydash` skill**, with the details: how to publish, how to write an approval form and a to-do list, how to wait for answers.
- **Permissions** so the mydash commands neither prompt nor get blocked by the Codex sandbox.
- **Hooks**:
  - Questions the agent asks also come to mydash. Claude Code's choice questions, plan approvals and permission prompts show in the terminal and in mydash at the same time; whichever the user answers first counts and the other closes. Codex asks its choice questions and command approvals in its own window first; if the user does not answer within 30 seconds, mydash reminds them (they answer in Codex, which cannot take an answer from outside). The settings page can switch either agent to asking in mydash first. The phone is notified if nobody answers within 30 seconds (the settings page changes this or turns it all off).
  - When an agent ends a reply with a question in plain text, it is asked once to put it as a choice question instead.
  - The agent's busy or idle state is noted, so answers submitted on the page wait until it finishes the current turn.
  - Sessions nobody is watching (`claude -p`, the Agent SDK) are left alone: no questions go to mydash and nothing is re-asked, so batch output does not change.

  Leave the hooks out with `--no-hooks`.

| Agent | Files |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` (blocks between `<!-- mydash:begin -->` / `<!-- mydash:end -->` and `<!-- mydash:decide:begin -->` / `<!-- mydash:decide:end -->`), `~/.claude/skills/mydash` (a symlink), `~/.claude/settings.json` (nine `Bash(mydash …:*)` allow rules, and hooks on UserPromptSubmit, Stop, StopFailure, SessionEnd, PreToolUse and PermissionRequest) |
| Codex | `~/.codex/AGENTS.md` (the same blocks), `~/.codex/skills/mydash`, `~/.codex/rules/mydash.rules` and `mydash-ask.rules` (the sandbox blocks writing to `~/.mydash` and connecting to `127.0.0.1`; these let the mydash commands run outside it), `~/.codex/hooks.json` (hooks on UserPromptSubmit, Stop, PreToolUse and PermissionRequest) |

If the instructions file already has the user's own rule for one of the blocks (it mentions `mydash publish`, or `mydash approvals` / `mydash ask`), that block is skipped. `--remove` undoes exactly what was added. Updating mydash brings these up to date. New sessions pick the changes up; the current one may not.

**Codex runs a new hook only after the user trusts it** (**user**). After `mydash integrate codex`, ask the user to open Codex in a terminal (`codex`), type `/hooks`, and trust the mydash hooks: their command runs `~/.mydash/app/bin/agent-ask.mjs` or `agent-state.mjs`. The Codex app uses the same settings, so trusting them once in the terminal covers it; new conversations in the app pick them up. `mydash doctor` shows whether they are trusted.

## Same Wi-Fi access

`--lan on` (or later `mydash lan on`) also opens mydash on this computer's LAN addresses, for example `http://<name>.local:4870/`. Devices there get an access-code page once, then stay logged in for a year. On this computer, the user clicks **Open on another device** at the bottom of the sidebar: it shows a QR code that opens and logs in a phone in one scan. Tell the user the code from `mydash lan --json` only if they ask; `mydash lan reset` changes it and logs every device out; `mydash lan off` closes it again. Requests from public addresses are always refused. If the install result lists a `firewall` step, the user may have to click Allow once.

## Agents on another machine

To let an agent on a second machine (for example a cloud server) publish into this mydash, install only the command there:

```bash
# on the machine that runs mydash
mydash remote token --name cloud-server            # prints a token once
# on the other machine
./setup.sh install --remote http://<this machine> --token <token> --machine "cloud server" --json
```

The other machine must reach this one (same tailnet, or `--lan on` on the same network). `mydash publish`, `ls`, `feedback` and `doctor` there all talk to this mydash. Files already uploaded are not sent again; previews are made here. `mydash remote revoke <name>` cuts a machine off.

## Phone notifications (optional, ask first)

The user can set these up on the settings page (`/settings`, the gear at the top), which has a step-by-step setup guide for each kind and a test button. Point them there if they are unsure how to get a key or a topic. From the command line: `mydash notify bark https://api.day.app/<key>` (iPhone, Bark app), `mydash notify ntfy https://ntfy.sh/<topic>`, and `telegram`, `pushover`, `webhook <url>` (WeCom, Feishu, DingTalk, Slack and Discord bots, recognised by the URL) and `email`. Several can be on at once, including two of the same kind: `--name` labels one, and `mydash notify` lists them with their ids for `mydash notify remove <id>`. Browser push works when mydash is served over HTTPS. A notification goes out whenever an agent publishes (except for muted projects) and when a question waits for the user. `mydash notify daily 21:00` adds one summary a day. Only titles and project names go through the push service.

## Other AI tools

mydash records which tool published each item and shows it on the page (a small mark on each entry, the full name on the item page, and a filter when more than one tool has published). Claude Code and Codex are detected automatically. Any other tool can still publish; to have it labelled, set `MYDASH_AGENT` in its environment, for example `MYDASH_AGENT=gemini mydash publish …`.

Other tools can also ask the user through mydash: `mydash ask "<question>" "<option 1>" "<option 2>"` (`--multi` for several answers) waits until the user answers on the page and prints the answer; exit code 3 means the user wants to answer in the tool itself. Add a line to that tool's instructions telling it to ask this way.

## Windows notes

- Use `setup.cmd` instead of `./setup.sh`. The `mydash` command goes into npm's global folder (`%APPDATA%\npm`), which the Node installer already put on `PATH`; open a new terminal if `mydash` is not found. Both `mydash.cmd` (PowerShell, cmd) and a `mydash` script for Git Bash are installed, because Claude Code on Windows runs commands in Git Bash when it is installed and in PowerShell otherwise.
- mydash starts at sign-in from the Startup folder (`shell:startup`, a small `mydash.server.vbs` that runs it hidden). No administrator rights are needed.
- Optional extras with winget: `winget install --id TheDocumentFoundation.LibreOffice -e` (Word / PowerPoint previews), `winget install --id oschwartz10612.Poppler -e` (PDF page images), and Tailscale from https://tailscale.com/download/windows.
- `--access tailscale-node` is not available; use `--access tailscale` to reach mydash from a phone.

## Updating

```bash
mydash update --json
```

It pulls the checkout recorded at install time, reinstalls with the same options, and lists the new commits in `changes`.

## Uninstalling

```bash
mydash uninstall --json           # services, the command, integrations; keeps published items
mydash uninstall --purge --json   # also deletes ~/.mydash, including every published item (ask first)
```

If mydash was set to start at boot (`launchd-boot`), uninstall stops first and returns a `boot-service-off` step: the user runs that `sudo … service login` command once, then you run uninstall again.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `mydash: command not found` | Use `~/.local/bin/mydash`; add `~/.local/bin` to `PATH` |
| Codex: publish fails with a permission or network error | `mydash integrate codex`, then start a new Codex session |
| doctor: `server` not responding | Look at `~/.mydash/logs/`; run `./setup.sh install --json` again |
| doctor: `tailscale-node` is `NeedsLogin` | The user opens the link in `fix` and approves the device |
| doctor: `tailscale-serve` not forwarding | Run the command in `fix`. On Linux, the user may first need `sudo tailscale set --operator=$USER` |
| The page opens on this machine but not on the phone | Check that the phone is in the same tailnet with Tailscale on; try the full name `http://<name>.<tailnet>.ts.net/` |
| Word / PowerPoint show no preview | Install LibreOffice (see `check`), run `./setup.sh install` again, then `mydash rebuild` |
| Wrong times on the pages | Reinstall with `--timezone <IANA name>` |
| Ports 4870 / 4871 are taken | Reinstall with `--port <n> --content-port <m>` |
