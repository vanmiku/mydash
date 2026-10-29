#!/bin/bash
# Runs inside the container (see test/linux/Dockerfile).
set -u
cd "$(dirname "$0")/../.."
echo "== smoke test"; bash test/smoke.sh | tail -3; SMOKE=${PIPESTATUS[0]}
echo "== translations"; node test/i18n-check.mjs --missing-only | tail -1
echo "== setup check"; ./setup.sh check --json > /tmp/check.json; node -e "const j=require('/tmp/check.json');console.log('ok', j.ok, JSON.stringify(j.recommend));for(const c of j.checks) if(!c.ok) console.log('  not ok:', c.id, '-', c.detail)"
echo "== install"; ./setup.sh install --access local --lang en --timezone Europe/London --service none --json > /tmp/install.json; node -e "const j=require('/tmp/install.json');console.log('ok', j.ok, j.url);for(const s of j.steps) console.log('  ', s.ok?'✓':'✗', s.id, s.detail);for(const h of j.human) console.log('   human:', h.id)"
export PATH="$HOME/.local/bin:$PATH"
echo "== publish a PDF"; node test/fixtures.mjs /tmp/fx >/dev/null; (cd /tmp/fx && mydash publish report.pdf --slug pdf-check --json) > /tmp/pub.json; node -e "const j=require('/tmp/pub.json');console.log('ok', j.ok, 'pdf pages', j.pdfPages, j.url)"
PAGE=$(curl -s http://127.0.0.1:4870/p/fx/pdf-check)
echo "$PAGE" | grep -q 'pdf-page img' && echo "   page images: yes" || echo "   page images: NO"
curl -sf -o /dev/null http://127.0.0.1:4870/f/fx/pdf-check/v1/_pages/report.pdf/p001.jpg && echo "   p001.jpg served" || echo "   p001.jpg missing"
echo "== doctor"; mydash doctor --json > /tmp/doc.json; node -e "const j=require('/tmp/doc.json');console.log('ok', j.ok);for(const c of j.checks) console.log('  ', c.ok?'✓':(c.level==='required'?'✗':'!'), c.id, '-', c.detail)"
echo "== systemd unit syntax"
# 写出 systemd 用户单元（容器里没有 user bus，systemctl 会失败，但单元文件已经写好），再用 systemd-analyze 校验语法
MYDASH_HOME=/tmp/unit-home node -e "import('./lib/service.mjs').then(s=>s.installService('server',[process.execPath,'/tmp/unit-home/app/server.mjs'],{MYDASH_HOME:'/tmp/unit-home'},'systemd')).then(r=>console.log('   systemctl in container:', r.ok?'ok':'fails as expected'))"
U=$(ls ~/.config/systemd/user/*.service | head -1); echo "   unit: $U"; sed 's/^/     /' "$U"
mkdir -p /tmp/unit-home/app && cp server.mjs /tmp/unit-home/app/
systemd-analyze verify "$U" 2>&1 | grep -v -i "user unit\|DefaultDependencies\|Cannot add dependency" | sed 's/^/   verify: /'; echo "   verify exit: ${PIPESTATUS[0]}"
echo "== uninstall"; mydash uninstall --purge --json | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log('ok', j.ok, j.done.length, 'steps')"; curl -s -m 2 -o /dev/null -w "   server after uninstall: %{http_code}\n" http://127.0.0.1:4870/healthz
exit $SMOKE
