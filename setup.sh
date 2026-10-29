#!/bin/sh
# mydash setup entry point. Needs Node.js 20+. Installs npm dependencies, then hands over to `mydash setup`.
#   ./setup.sh check [--json]      ./setup.sh install [options] [--json]      ./setup.sh uninstall [--purge]
# Meant to be run by a coding agent; see INSTALL.md.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '{"ok":false,"error":"node-missing","fix":"Install Node.js 20 or newer (macOS: brew install node; Linux: https://nodejs.org/en/download)"}'
  exit 3
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "{\"ok\":false,\"error\":\"node-too-old\",\"detail\":\"Node.js $(node -v)\",\"fix\":\"Install Node.js 20 or newer\"}"
  exit 3
fi
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci --omit=dev --no-audit --no-fund >&2
  touch node_modules
fi
exec node bin/mydash.mjs setup "$@"
