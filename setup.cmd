@echo off
rem mydash setup entry point for Windows: works from cmd, PowerShell (.\setup.cmd) and Git Bash (./setup.cmd).
rem Needs Node.js 20+. Installs npm dependencies, then hands over to `mydash setup`. See INSTALL.md.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo {"ok":false,"error":"node-missing","fix":"winget install --id OpenJS.NodeJS.LTS -e"} & exit /b 3)
node -e "process.exit(+process.versions.node.split(String.fromCharCode(46))[0] >= 20 ? 0 : 1)" || (echo {"ok":false,"error":"node-too-old","fix":"winget install --id OpenJS.NodeJS.LTS -e"} & exit /b 3)
if not exist node_modules\.package-lock.json call npm ci --omit=dev --no-audit --no-fund 1>&2
node bin\mydash.mjs setup %*
