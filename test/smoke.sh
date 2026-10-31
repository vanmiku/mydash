#!/bin/bash
# 冒烟测试：用临时数据目录和临时端口跑一遍完整流程，不碰真实数据
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mydash-smoke.XXXXXX")"
PORT="${SMOKE_PORT:-4878}"
if curl -s -m 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then echo "端口 $PORT 已被占用，换一个：SMOKE_PORT=xxxx bash test/smoke.sh"; exit 2; fi
# Telegram / Pushover 的接口指到本机假的推送服务（见"通知"一节）
export MYDASH_TELEGRAM_API="http://127.0.0.1:$((PORT+6))/tg" MYDASH_PUSHOVER_API="http://127.0.0.1:$((PORT+6))/po"
export MYDASH_HOME="$TMP/home" MYDASH_DATA="$TMP/home/data" MYDASH_PORT="$PORT" MYDASH_BASE_URL="http://127.0.0.1:$PORT" MYDASH_LANG="${SMOKE_LANG:-zh}"
mkdir -p "$MYDASH_HOME" "$TMP/fx"
# 不读真实的 Claude Code 会话记录
export MYDASH_CLAUDE_PROJECTS="$TMP/claude-projects"; mkdir -p "$MYDASH_CLAUDE_PROJECTS"; unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID
# 不碰真实的 Claude Code / Codex 配置
export MYDASH_CLAUDE_HOME="$TMP/claude-home" MYDASH_CODEX_HOME="$TMP/codex-home"; mkdir -p "$MYDASH_CLAUDE_HOME" "$MYDASH_CODEX_HOME"
CLI="node $ROOT/bin/mydash.mjs"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

node "$ROOT/test/fixtures.mjs" "$TMP/fx" >/dev/null
iconv -f UTF-8 -t GBK "$TMP/fx/data-utf8.csv" > "$TMP/fx/data-gbk.csv"
command -v textutil >/dev/null && textutil -convert docx "$TMP/fx/doc.html" -output "$TMP/fx/doc.docx" 2>/dev/null

# 一个假的 tailnet 名字，用来测"HTTP 跳 HTTPS"
echo '{"tailnetNames":["smokebox"]}' > "$MYDASH_HOME/config.json"
node "$ROOT/server.mjs" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.25; done
B="http://127.0.0.1:$PORT"

# 实时推送：先挂上监听
curl -sN --max-time 6 "$B/events" > "$TMP/events.txt" &
EV=$!
sleep 0.5

echo "发布"
cd "$TMP/fx"
OUT1=$($CLI publish plan.md -p smoke -t "对战分析方案" -s battle-plan -n "第一版")
check "md 发布打印网址" "echo \"\$OUT1\" | tail -1 | grep -c '/p/smoke/battle-plan$'"
OUT2=$($CLI publish plan.md -p smoke -s battle-plan -n "第二版：补了流程图")
check "同 slug 再发变成 v2" "echo \"\$OUT2\" | grep -c 'v2'"
check "v2 提示是第 2 版" "echo \"\$OUT2\" | grep -c '第 2 版'"
check "md 引用的图片被带上" "test -f '$MYDASH_DATA/smoke/battle-plan/v2/img/chart.png'"
check "md 链接的 PDF 被带上" "test -f '$MYDASH_DATA/smoke/battle-plan/v2/report.pdf'"
check "md 链接的另一份 md 被带上" "test -f '$MYDASH_DATA/smoke/battle-plan/v2/notes.md'"
$CLI publish report.pdf -p smoke -s pdf-report -t "PDF 报告" >/dev/null
$CLI publish report.pdf -p smoke -s pdf-report >/dev/null
check "再发同一 slug 不带标题时沿用上一版标题" "grep -q '\"title\": \"PDF 报告\"' '$MYDASH_DATA/smoke/pdf-report/meta.json'"
$CLI publish site -p smoke -s proto >/dev/null
$CLI publish shots -p smoke -s screens -t "两张截图" >/dev/null
$CLI publish data-gbk.csv -p smoke -s gbk-table >/dev/null
$CLI publish sheet.xlsx -p smoke -s excel >/dev/null
[ -f doc.docx ] && $CLI publish doc.docx -p smoke -s word >/dev/null
$CLI publish config.yaml -p smoke -s yaml >/dev/null
echo "# 从标准输入来的笔记" | $CLI publish - --name 笔记.md -p smoke >/dev/null
JSON=$($CLI publish img/chart.png -p other --json)
check "--json 输出" "echo '$JSON' | node -e 'const j=JSON.parse(require(\"fs\").readFileSync(0));process.exit(j.ok&&j.version===1?0:1)'"
sleep 1

echo "页面"
H=$(curl -s "$B/")
check "首页列出标题" "echo \"\$H\" | grep -c '对战分析方案'"
check "首页有项目印章" "echo \"\$H\" | grep -c 'class=\"proj\"'"
check "中文标题无 slug 时用哈希 slug" "echo \"\$H\" | grep -c '/p/smoke/x-'"
P=$(curl -s "$B/p/smoke")
check "项目页" "echo \"\$P\" | grep -c 'battle-plan'"
I=$(curl -s "$B/p/smoke/battle-plan")
check "条目页标题" "echo \"\$I\" | grep -c '<h1 class=\"doc-title\">对战分析方案'"
check "标题锚点支持中文" "echo \"\$I\" | grep -c 'id=\"背景与目标\"'"
check "表格包裹可横向滚动" "echo \"\$I\" | grep -c 'table-wrap'"
check "Mermaid 块" "echo \"\$I\" | grep -c 'class=\"mermaid\"'"
check "代码高亮" "echo \"\$I\" | grep -c 'hljs-keyword'"
check "图片地址改写到原文件" "echo \"\$I\" | grep -c 'src=\"/f/smoke/battle-plan/v2/img/chart.png\"'"
check "条目内 md 链接改为站内打开" "echo \"\$I\" | grep -c 'f=notes.md'"
check "目录" "echo \"\$I\" | grep -c 'class=\"toc\"'"
check "历史版本" "echo \"\$I\" | grep -c '历史版本 · 2'"
check "备注" "echo \"\$I\" | grep -c '第二版：补了流程图'"
check "frontmatter 收起" "echo \"\$I\" | grep -c '文档属性'"
OLD=$(curl -s "$B/p/smoke/battle-plan?v=1")
check "旧版本横幅" "echo \"\$OLD\" | grep -c '你在看旧版本 v1'"
check "PDF 条目" "curl -s '$B/p/smoke/pdf-report' | grep -c 'pdf-view'"
check "网页条目用 iframe（src 由前端指到内容端口）" "curl -s '$B/p/smoke/proto' | grep '<iframe data-src=\"/f/smoke/proto/v1/index.html\"' >/dev/null"
CP=$((PORT+1)); CB="http://127.0.0.1:$CP"
check "页面告诉前端内容端口" "curl -s '$B/p/smoke/proto' | grep 'name=\"mydash-content-port\" content=\"'$CP'\"' >/dev/null"
check "内容端口能打开网页产物" "curl -sf '$CB/f/smoke/proto/v1/index.html' | grep -i '<html' >/dev/null"
check "内容端口上的网页不加 sandbox" "! curl -sI '$CB/f/smoke/proto/v1/index.html' | grep -i 'content-security-policy' >/dev/null"
check "工作台端口直接打开网页产物带 CSP sandbox" "curl -sI '$B/f/smoke/proto/v1/index.html' | grep -i 'content-security-policy: sandbox' >/dev/null"
check "工作台端口上的图片不加 sandbox" "! curl -sI '$B/f/smoke/screens/v1/home.png' | grep -i 'content-security-policy' >/dev/null"
check "内容端口没有工作台页面" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$CB/')\" = 404"
check "内容端口不接受写请求" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Mydash: 1' -H 'Content-Type: application/json' -d '{}' '$CB/api/read-all')\" = 405"
check "内容端口校验 Host" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:'$CP '$CB/f/smoke/proto/v1/index.html')\" = 421"
check "图片组变成画廊" "curl -s '$B/p/smoke/screens' | grep -c 'class=\"gallery\"'"
check "GBK CSV 正确解码" "curl -s '$B/p/smoke/gbk-table' | grep -c '曼彻斯特'"
check "CSV 引号内逗号" "curl -s '$B/p/smoke/gbk-table' | grep -c '553,230'"
check "Excel 渲染两个工作表" "curl -s '$B/p/smoke/excel' | grep -c 'sheet-1'"
if [ -f doc.docx ]; then
  if [ -x "$HOME/.mydash/lo/LibreOffice.app/Contents/MacOS/soffice" ]; then
    check "Word 发布时生成排版预览" "test -s '$MYDASH_DATA/smoke/word/v1/_preview/doc.docx.pdf'"
    check "Word 默认显示排版版" "curl -s '$B/p/smoke/word' | grep -c '_preview/doc.docx.pdf'"
    check "Word 可切到文字版" "curl -s '$B/p/smoke/word?f=doc.docx&mode=text' | grep -c 'Word 文档里的正文'"
  else
    check "Word 文字渲染" "curl -s '$B/p/smoke/word' | grep -c 'Word 文档里的正文'"
  fi
fi
check "YAML 代码高亮" "curl -s '$B/p/smoke/yaml' | grep -c 'language-yaml'"
check "标准输入发布" "curl -s '$B/p/smoke' | grep -c '从标准输入来的笔记'"

check "每个页面都有项目边栏" "echo \"\$I\" | grep -c 'id=\"side\"'"
check "条目页边栏高亮当前项目" "echo \"\$I\" | grep -c 'class=\"side-proj on\" href=\"/p/smoke\"'"
check "首页边栏高亮全部" "echo \"\$H\" | grep -c 'class=\"side-all on\"'"
check "边栏片段接口" "curl -s '$B/api/sidebar?current=smoke' | grep -c 'side-proj on'"
check "边栏条目数正确" "curl -s '$B/api/sidebar' | grep -c '<em>1</em>'"

echo "已读 / 未读"
POSTJ() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' "$@"; }
POSTB() { curl -s -X POST -H 'Content-Type: application/json' "$@"; }
check "新条目默认未读" "curl -s '$B/' | grep -c 'class=\"entry unread\" data-id=\"smoke/battle-plan\"'"
check "标题带未读数" "curl -s '$B/' | grep -c '<title>([0-9]*) mydash'"
check "缺少 X-Mydash 头被拒（防跨站伪造）" "POSTJ -d '{\"id\":\"smoke/battle-plan\"}' '$B/api/read' | grep -c 403"
check "外站 Origin 被拒" "POSTJ -H 'X-Mydash: 1' -H 'Origin: http://evil.example' -d '{\"id\":\"smoke/battle-plan\"}' '$B/api/read' | grep -c 403"
check "表单类型被拒" "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Mydash: 1' -d 'id=smoke/battle-plan' '$B/api/read' | grep -c 415"
check "标为已读" "POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"smoke/battle-plan\",\"v\":2}' '$B/api/read' | grep -c 200"
check "已读后列表不再标未读" "curl -s '$B/' | grep -c 'class=\"entry\" data-id=\"smoke/battle-plan\"'"
$CLI publish plan.md -p smoke -s battle-plan -n "第三版：改了结论" >/dev/null; sleep 0.3
check "发新版本后重新变成未读" "curl -s '$B/' | grep -c 'class=\"entry unread\" data-id=\"smoke/battle-plan\"'"
check "看过旧版的条目带新版本标签" "curl -s '$B/' | grep -A6 'data-id=\"smoke/battle-plan\"' | grep -c 'new-ver'"
check "条目页提示上次看到 v2" "curl -s '$B/p/smoke/battle-plan' | grep -c '你上次看到 <b>v2</b>'"
check "提示里列出之后的改动" "curl -s '$B/p/smoke/battle-plan' | grep -c '第三版：改了结论'"
check "边栏显示未读数" "curl -s '$B/api/sidebar' | grep -c 'side-unread'"
check "全部标为已读" "POSTJ -H 'X-Mydash: 1' -d '{}' '$B/api/read-all' | grep -c 200"
check "全部已读后没有未读" "! curl -s '$B/' | grep -c 'entry unread'"
check "全部已读后边栏没有未读徽章" "! curl -s '$B/api/sidebar' | grep -c 'side-unread'"
check "标回未读" "POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"smoke/battle-plan\",\"unread\":true}' '$B/api/read' | grep -c 200"
check "标回未读后又出现在未读里" "curl -s '$B/' | grep -c 'class=\"entry unread\" data-id=\"smoke/battle-plan\"'"
check "已读状态存在数据目录外的 state 文件" "test -s '$MYDASH_HOME/state/read.json'"

echo "PDF 逐页图片"
if [ -x "$HOME/.mydash/bin/pdfpages" ]; then
  check "发布 PDF 时生成逐页图片" "test -s '$MYDASH_DATA/smoke/pdf-report/v2/_pages/report.pdf/p002.jpg'"
  check "条目页直接显示页面图片" "curl -s '$B/p/smoke/pdf-report' | grep -c 'class=\"pdf-page img\"'"
  check "有图片时不再加载 pdf.js" "curl -s '$B/p/smoke/pdf-report' | grep -c 'data-pdf=\"0\"'"
  check "列表里显示第一页缩略图" "curl -s '$B/p/smoke' | grep -c 'entry-thumb doc'"
  [ -f doc.docx ] && check "Word 预览也逐页成图" "curl -s '$B/p/smoke/word' | grep -c 'class=\"pdf-page img\"'"
  node -e "const f='$MYDASH_DATA/smoke/pdf-report/meta.json',fs=require('fs');const m=JSON.parse(fs.readFileSync(f));for(const v of m.versions)for(const x of v.files)delete x.pages;fs.writeFileSync(f,JSON.stringify(m))"
  rm -rf "$MYDASH_DATA/smoke/pdf-report/v2/_pages"
  check "没有页面图片时退回浏览器渲染" "curl -s '$B/p/smoke/pdf-report' | grep -c 'data-pdf=\"1\"'"
  $CLI rebuild smoke/pdf-report >/dev/null 2>&1
  check "rebuild 给旧条目补上页面图片" "curl -s '$B/p/smoke/pdf-report' | grep -c 'class=\"pdf-page img\"'"
fi
check "前端错误回报接口" "POSTJ -H 'X-Mydash: 1' -d '{\"page\":\"/t\",\"message\":\"smoke-probe\"}' '$B/api/client-error' | grep -c 200"
sleep 0.3
check "前端错误写进服务日志" "grep -q 'smoke-probe' '$TMP/server.log'"

echo "项目改名（只改显示名）"
check "改名缺少 X-Mydash 头被拒" "POSTJ -d '{\"project\":\"smoke\",\"name\":\"x\"}' '$B/api/project-name' | grep -c 403"
check "不存在的项目改名 404" "POSTJ -H 'X-Mydash: 1' -d '{\"project\":\"nope\",\"name\":\"x\"}' '$B/api/project-name' | grep -c 404"
check "改名成功" "POSTJ -H 'X-Mydash: 1' -d '{\"project\":\"smoke\",\"name\":\"冒烟测试\"}' '$B/api/project-name' | grep -c 200"
check "首页条目显示新名字" "curl -s '$B/' | grep -c '<span class=\"entry-proj\">冒烟测试</span>'"
check "边栏显示新名字" "curl -s '$B/api/sidebar' | grep -c '>冒烟测试</span>'"
check "边栏筛选能搜到新旧两个名字" "curl -s '$B/api/sidebar' | grep -c 'data-search=\"冒烟测试 smoke\"'"
check "项目头像用新名字的第一个字" "curl -s '$B/p/smoke' | grep -c 'class=\"av av-lg\" style=\"--h:[0-9]*\" aria-hidden=\"true\">冒<'"
check "项目页标题是新名字" "curl -s '$B/p/smoke' | grep -c '<span class=\"proj-display\">冒烟测试</span>'"
check "项目页注明原文件夹名" "curl -s '$B/p/smoke' | grep -c '文件夹 <code>smoke</code>'"
check "条目页显示新名字" "curl -s '$B/p/smoke/battle-plan' | grep -c '<span>冒烟测试</span>'"
check "网址不变" "curl -s -o /dev/null -w '%{http_code}' '$B/p/smoke' | grep -c 200"
OUTR=$($CLI publish notes.md -p smoke -s after-rename)
check "Claude Code 照常用文件夹名发布" "test -f '$MYDASH_DATA/smoke/after-rename/meta.json'"
check "命令行输出显示新名字和文件夹名" "echo \"\$OUTR\" | grep -c '冒烟测试（文件夹 smoke）'"
check "名字里的控制字符被清掉" "POSTJ -H 'X-Mydash: 1' -d '{\"project\":\"smoke\",\"name\":\"A\\u0007B\"}' '$B/api/project-name' | grep -c 200 && curl -s '$B/p/smoke' | grep -c '<span class=\"proj-display\">AB</span>'"
check "清空名字恢复成文件夹名" "POSTJ -H 'X-Mydash: 1' -d '{\"project\":\"smoke\",\"name\":\"\"}' '$B/api/project-name' | grep -c 200 && curl -s '$B/p/smoke' | grep -c '<span class=\"proj-display\">smoke</span>'"

echo "标题保留"
printf '# 一级标题甲\n\n正文\n' > "$TMP/fx/t.md"
$CLI publish "$TMP/fx/t.md" -p smoke -s title-keep -t "手动标题" >/dev/null
printf '# 一级标题乙\n\n正文\n' > "$TMP/fx/t.md"
$CLI publish "$TMP/fx/t.md" -p smoke -s title-keep >/dev/null
check "手动指定过的标题，再发时不被一级标题覆盖" "grep -q '\"title\": \"手动标题\"' '$MYDASH_DATA/smoke/title-keep/meta.json'"
$CLI publish "$TMP/fx/t.md" -p smoke -s title-follow >/dev/null
printf '# 一级标题丙\n\n正文\n' > "$TMP/fx/t.md"
$CLI publish "$TMP/fx/t.md" -p smoke -s title-follow >/dev/null
check "标题本来取自一级标题的，跟着新标题走" "grep -q '\"title\": \"一级标题丙\"' '$MYDASH_DATA/smoke/title-follow/meta.json'"

echo "项目按会话的启动文件夹认定"
LP="$TMP/work/launchproj"; mkdir -p "$LP/sub/deeper" "$LP/.claude/worktrees/feat-x"
ENC="$(echo "$LP" | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$MYDASH_CLAUDE_PROJECTS/$ENC"
printf '{"type":"x"}\n{"type":"user","cwd":"%s"}\n' "$LP" > "$MYDASH_CLAUDE_PROJECTS/$ENC/sess-a.jsonl"
cp "$MYDASH_CLAUDE_PROJECTS/$ENC/sess-a.jsonl" "$MYDASH_CLAUDE_PROJECTS/$ENC/sess-b.jsonl"
(cd "$LP/sub/deeper" && CLAUDE_CODE_SESSION_ID=sess-a $CLI publish "$TMP/fx/notes.md" -s from-subdir >/dev/null)
check "会话中途 cd 到子目录，仍归到启动文件夹" "test -f '$MYDASH_DATA/launchproj/from-subdir/meta.json'"
(cd "$LP/.claude/worktrees/feat-x" && CLAUDE_CODE_SESSION_ID=sess-b $CLI publish "$TMP/fx/notes.md" -s from-worktree >/dev/null)
check "另一个会话在 worktree 里，也归到同一个项目" "test -f '$MYDASH_DATA/launchproj/from-worktree/meta.json'"
WT="$TMP/work/wtproj/.claude/worktrees/feat-y"; mkdir -p "$WT"; ENC2="$(echo "$WT" | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$MYDASH_CLAUDE_PROJECTS/$ENC2"
printf '{"type":"user","cwd":"%s"}\n' "$WT" > "$MYDASH_CLAUDE_PROJECTS/$ENC2/sess-c.jsonl"
(cd "$WT" && CLAUDE_CODE_SESSION_ID=sess-c $CLI publish "$TMP/fx/notes.md" -s wt-launch >/dev/null)
check "直接在 worktree 里启动的会话归回主项目" "test -f '$MYDASH_DATA/wtproj/wt-launch/meta.json'"
OUTP=$(cd "$LP/sub" && CLAUDE_CODE_SESSION_ID=sess-a $CLI publish "$TMP/fx/notes.md" -p some-other-name -s ignored-p 2>&1)
check "会话里乱传 --project 会被纠正回文件夹项目" "test -f '$MYDASH_DATA/launchproj/ignored-p/meta.json' && test ! -d '$MYDASH_DATA/some-other-name'"
check "纠正时会说明原因" "echo \"\$OUTP\" | grep -c '忽略了 --project some-other-name'"
(cd "$LP/sub" && CLAUDE_CODE_SESSION_ID=sess-a $CLI publish "$TMP/fx/notes.md" --force-project forced-proj -s forced >/dev/null 2>&1)
check "--force-project 可以强制" "test -f '$MYDASH_DATA/forced-proj/forced/meta.json'"
check "doctor 显示归属依据" "(cd '$LP/sub' && { CLAUDE_CODE_SESSION_ID=sess-a $CLI doctor 2>/dev/null || true; } | grep '进项目：launchproj（依据：Claude Code 会话的启动文件夹' >/dev/null)"
(cd "$LP/sub" && $CLI publish "$TMP/fx/notes.md" -s manual-run >/dev/null)
check "不在会话里手动运行时，按当前目录" "test -f '$MYDASH_DATA/sub/manual-run/meta.json'"

echo "置顶"
check "置顶缺少 X-Mydash 头被拒" "POSTJ -d '{\"kind\":\"item\",\"id\":\"smoke/battle-plan\",\"pinned\":true}' '$B/api/pin' | grep -c 403"
check "置顶不存在的条目 404" "POSTJ -H 'X-Mydash: 1' -d '{\"kind\":\"item\",\"id\":\"smoke/nope\",\"pinned\":true}' '$B/api/pin' | grep -c 404"
check "置顶条目" "POSTJ -H 'X-Mydash: 1' -d '{\"kind\":\"item\",\"id\":\"smoke/battle-plan\",\"pinned\":true}' '$B/api/pin' | grep -c 200"
check "首页出现置顶区并有这条" "curl -s '$B/' | grep -c 'class=\"pinned-sec\"' && curl -s '$B/' | grep -A3 'class=\"card-wrap\"' | grep -c '/p/smoke/battle-plan'"
check "项目页也有置顶区" "curl -s '$B/p/smoke' | grep -c 'class=\"pinned-sec\"'"
check "列表里这条带已置顶标记" "curl -s '$B/p/smoke' | grep -c 'class=\"entry[^\"]*pinned\" data-id=\"smoke/battle-plan\"'"
check "条目页按钮显示已置顶" "curl -s '$B/p/smoke/battle-plan' | grep -c 'class=\"pin-btn label on\"'"
check "置顶项目" "POSTJ -H 'X-Mydash: 1' -d '{\"kind\":\"project\",\"id\":\"smoke\",\"pinned\":true}' '$B/api/pin' | grep -c 200"
check "边栏置顶分组里有这个项目" "curl -s '$B/api/sidebar' | grep -A2 'side-list pinned' | grep -c 'data-search=\"smoke smoke\"'"
check "置顶状态写进 state 文件" "grep -q 'smoke/battle-plan' '$MYDASH_HOME/state/pins.json'"
check "取消置顶条目" "POSTJ -H 'X-Mydash: 1' -d '{\"kind\":\"item\",\"id\":\"smoke/battle-plan\",\"pinned\":false}' '$B/api/pin' | grep -c 200 && ! curl -s '$B/' | grep -c 'class=\"pinned-sec\"'"
check "取消置顶项目" "POSTJ -H 'X-Mydash: 1' -d '{\"kind\":\"project\",\"id\":\"smoke\",\"pinned\":false}' '$B/api/pin' | grep -c 200 && curl -s '$B/api/sidebar' | grep -c 'data-group=\"pinned\" hidden'"

echo "图标与底部导航"
check "favicon.ico 可用" "curl -sI '$B/favicon.ico' | grep -qi 'content-type: image/x-icon\\|content-type: application/octet-stream\\|image/vnd.microsoft.icon' || curl -s -o /dev/null -w '%{http_code}' '$B/favicon.ico' | grep -c 200"
check "favicon.ico 每次重新确认" "curl -sI '$B/favicon.ico' | grep -qi 'cache-control: no-cache'"
check "图标链接带版本号" "curl -s '$B/' | grep 'href=\"/static/icon.svg?b=' >/dev/null"
check "手机底部导航" "curl -s '$B/' | grep -c 'class=\"tabbar\"'"
check "底部导航显示当前项目" "curl -s '$B/p/smoke' | grep -c 'class=\"tb-proj-name\">smoke<'"

echo "电脑端收起边栏"
check "顶栏有收起边栏按钮" "curl -s '$B/' | grep -c 'class=\"side-collapse\"'"
check "渲染前应用收起状态" "curl -s '$B/' | grep -c \"classList.add('side-collapsed')\""
check "网页条目有全屏按钮" "curl -s '$B/p/smoke/proto' | grep -c 'fs-btn'"
check "非网页条目没有全屏按钮" "! curl -s '$B/p/smoke/battle-plan' | grep -c 'fs-btn'"

echo "外观（自动 / 浅色 / 深色）"
check "渲染前就定好深浅色" "curl -s '$B/' | grep -c 'window.mydashTheme=function'"
check "自动模式按时间判断" "curl -s '$B/' | grep -c 'h>=19||h<7'"
check "顶栏有外观按钮和三个选项" "curl -s '$B/' | grep -c 'class=\"theme-btn\"' && [ \"\$(curl -s '$B/' | grep -o 'data-theme-set=' | wc -l | tr -d ' ')\" = 3 ]"
check "代码高亮两套配色都在" "curl -s '$B/p/smoke/battle-plan' | grep -c 'id=\"hl-dark\"'"
check "深色配色挂在 data-theme 上" "curl -s '$B/static/app.css' | grep -c ':root\[data-theme=\"dark\"\] {'"
check "不再直接跟系统深色" "! curl -s '$B/static/app.css' | grep -c 'prefers-color-scheme: dark'"
check "项目页条目用类型图标" "curl -s '$B/p/smoke' | grep -c 'class=\"kind-tile k-'"
check "首页条目仍用项目头像" "curl -s '$B/' | grep -c 'class=\"entry-av\"><span class=\"av'"

echo "原始文件与安全"
check "原图 200 + image/png" "curl -sI '$B/f/smoke/battle-plan/v2/img/chart.png' | grep -qi 'content-type: image/png'"
check "Range 请求 206" "curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-99' '$B/f/smoke/pdf-report/v1/report.pdf' | grep -c 206"
check "HTML 原样输出" "curl -sI '$B/f/smoke/proto/v1/index.html' | grep -qi 'text/html'"
check "模块脚本 MIME" "curl -sI '$B/f/smoke/proto/v1/assets/app.js' | grep -qi 'text/javascript'"
check "陌生 Host 被拒（防 DNS 重绑定）" "curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' '$B/' | grep -c 421"
check "路径穿越被拒" "curl -s --path-as-is -o /dev/null -w '%{http_code}' '$B/f/smoke/battle-plan/v1/../meta.json' | grep -c 404"
check "隐藏文件不暴露" "curl -s -o /dev/null -w '%{http_code}' '$B/f/smoke/battle-plan/v1/.lock' | grep -c 404"
check "vendor 白名单外 404" "curl -s -o /dev/null -w '%{http_code}' '$B/vendor/pdfjs/package.json' | grep -c 404"
check "pdf.js 可加载" "curl -s -o /dev/null -w '%{http_code}' '$B/vendor/pdfjs/build/pdf.min.mjs' | grep -c 200"
check "mermaid 可加载" "curl -s -o /dev/null -w '%{http_code}' '$B/vendor/mermaid.min.js' | grep -c 200"
check "不开放跨域读取" "! curl -sI '$B/api/index' | grep -qi 'access-control-allow-origin'"

echo "Codex 会话"
CX="$TMP/work/codexproj"; mkdir -p "$CX/sub"; CXD="$MYDASH_CODEX_HOME/sessions/2026/10/28"; mkdir -p "$CXD"
printf '{"timestamp":"x","type":"session_meta","payload":{"id":"cx-1","cwd":"%s","originator":"codex_exec"}}\n' "$CX" > "$CXD/rollout-2026-10-28T10-00-00-cx-1.jsonl"
(cd "$CX/sub" && CODEX_THREAD_ID=cx-1 $CLI publish "$TMP/fx/notes.md" -s from-codex >/dev/null)
check "Codex 会话中途 cd 到子目录，仍归到启动文件夹" "test -f '$MYDASH_DATA/codexproj/from-codex/meta.json'"
check "条目记下是 Codex 发布的" "grep '\"agent\": \"codex\"' '$MYDASH_DATA/codexproj/from-codex/meta.json' >/dev/null"
check "条目页显示由 Codex 发布" "curl -s '$B/p/codexproj/from-codex' | grep '由 Codex 发布' >/dev/null"
OUTC=$(cd "$CX" && CODEX_THREAD_ID=cx-1 $CLI publish "$TMP/fx/notes.md" -p wrong-name -s cx-p 2>&1)
check "Codex 会话里乱传 --project 也会被纠正" "test -f '$MYDASH_DATA/codexproj/cx-p/meta.json' && test ! -d '$MYDASH_DATA/wrong-name'"
check "doctor 显示 Codex 归属依据" "(cd '$CX/sub' && { CODEX_THREAD_ID=cx-1 $CLI doctor 2>/dev/null || true; } | grep 'Codex 会话的启动文件夹' >/dev/null)"
check "meta.json 带格式版本" "grep '\"schema\": 1' '$MYDASH_DATA/codexproj/from-codex/meta.json' >/dev/null"

echo "多个 AI 工具：网页上能看出是谁发的"
(cd "$LP/sub" && CLAUDE_CODE_SESSION_ID=sess-a $CLI publish "$TMP/fx/notes.md" -s from-claude >/dev/null)
check "Claude Code 会话发布记下 agent" "grep '\"agent\": \"claude\"' '$MYDASH_DATA/launchproj/from-claude/meta.json' >/dev/null"
HL=$(curl -s "$B/")
check "列表里 Codex 条目带 Codex 小标" "echo \"\$HL\" | grep 'ag-badge ag-codex' >/dev/null"
check "列表里 Claude 条目带 Claude 小标" "echo \"\$HL\" | grep 'ag-badge ag-claude' >/dev/null"
check "条目带按来源筛选用的 data-agent；没有来源记录的（比如手动发的）是空的" "echo \"\$HL\" | grep 'data-agent=\"codex\"' >/dev/null && echo \"\$HL\" | grep 'data-agent=\"\"' >/dev/null"
check "首页有按来源筛选（两种以上来源时）" "echo \"\$HL\" | grep 'class=\"seg agent-seg\"' >/dev/null && echo \"\$HL\" | grep 'data-agent=\"claude\" class=\"ag-claude\"' >/dev/null"
check "只有一种来源的项目页不显示来源筛选" "! curl -s '$B/p/codexproj' | grep 'agent-seg' >/dev/null"
check "条目页写出完整的工具名" "curl -s '$B/p/codexproj/from-codex' | grep 'class=\"agent ag-codex\"' | grep '>Codex<' >/dev/null"
check "按工具名能搜到" "echo \"\$HL\" | grep 'data-search=\"[^\"]*codex' >/dev/null"
(cd "$TMP" && MYDASH_AGENT=Cursor $CLI publish "$TMP/fx/notes.md" -p tools -s from-cursor >/dev/null)
check "其他工具可以用 MYDASH_AGENT 报名字" "grep '\"agent\": \"cursor\"' '$MYDASH_DATA/tools/from-cursor/meta.json' >/dev/null"
check "其他工具显示成中性标签" "curl -s '$B/p/tools/from-cursor' | grep 'class=\"agent ag-other\"' | grep '>cursor<' >/dev/null"
check "来源筛选里的「其他」只算报了名字的别的工具，没有来源记录的不算" "curl -s '$B/' | node -e 'const m=/data-agent=\"other\" class=\"ag-other\">[\\s\\S]*?<em>(\\d+)<\\/em>/.exec(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(m&&m[1]===\"1\"?0:1)'"
# 给旧条目补记来源：会话记录里有当时的 publish 命令
BF="$MYDASH_CLAUDE_PROJECTS/-old-session"; mkdir -p "$BF"
NOW=$(node -e 'console.log(new Date(Date.now()-20000).toISOString())')
printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"mydash publish notes.md --title Old --slug backfill-me"}}]}}\n' "$NOW" > "$BF/old.jsonl"
(cd "$TMP" && $CLI publish "$TMP/fx/notes.md" -p oldproj -s backfill-me >/dev/null)
check "旧条目一开始没有 agent" "! grep '\"agent\"' '$MYDASH_DATA/oldproj/backfill-me/meta.json' >/dev/null"
check "rebuild --agents --dry-run 不改文件" "$CLI rebuild --agents --dry-run >/dev/null && ! grep '\"agent\"' '$MYDASH_DATA/oldproj/backfill-me/meta.json' >/dev/null"
$CLI rebuild --agents >/dev/null
check "rebuild --agents 从会话记录补上 agent" "grep '\"agent\": \"claude\"' '$MYDASH_DATA/oldproj/backfill-me/meta.json' >/dev/null"

echo "同一 WiFi 访问（访问码）"
LANIP=$(node -e "import('$ROOT/lib/lan.mjs').then(m=>console.log(m.lanAddresses()[0]||''))")
if [ -n "$LANIP" ]; then
  LH="$TMP/lan-home"; mkdir -p "$LH"; LPORT=$((PORT+4)); LCP=$((PORT+5))
  printf '{"port":%s,"contentPort":%s,"lan":true,"lang":"zh","access":"local"}\n' $LPORT $LCP > "$LH/config.json"
  (cd "$TMP/fx" && env -u MYDASH_PORT -u MYDASH_BASE_URL MYDASH_HOME="$LH" MYDASH_DATA="$LH/data" $CLI publish site -p secretproj -s lan-site >/dev/null)
  # 先让别的程序占住局域网地址上的内容端口（像 tailscale serve 那样）：服务不能因此挂掉
  node -e "require('net').createServer().listen($LCP, '$LANIP'); setTimeout(()=>{}, 4000)" & BLOCKER=$!; sleep 0.5
  env -u MYDASH_PORT -u MYDASH_BASE_URL MYDASH_HOME="$LH" MYDASH_DATA="$LH/data" node "$ROOT/server.mjs" > "$TMP/server-lan.log" 2>&1 &
  SRV_LAN=$!; for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$LPORT/healthz" >/dev/null && break; sleep 0.25; done
  sleep 1
  check "局域网端口被占也不会让服务挂掉" "kill -0 $SRV_LAN && curl -sf 'http://127.0.0.1:$LPORT/healthz' >/dev/null && curl -sf -H 'Host: 127.0.0.1:$LCP' 'http://127.0.0.1:$LCP/healthz' >/dev/null"
  check "占用的情况记进日志" "grep 'LAN: cannot listen' '$TMP/server-lan.log' >/dev/null"
  kill $BLOCKER 2>/dev/null; wait $BLOCKER 2>/dev/null
  # 30 秒后会自动重试；测试里不等，直接重启一次拿到局域网的内容端口
  kill $SRV_LAN; sleep 0.5
  env -u MYDASH_PORT -u MYDASH_BASE_URL MYDASH_HOME="$LH" MYDASH_DATA="$LH/data" node "$ROOT/server.mjs" > "$TMP/server-lan.log" 2>&1 &
  SRV_LAN=$!; for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$LPORT/healthz" >/dev/null && break; sleep 0.25; done
  LB="http://$LANIP:$LPORT"; LCB="http://$LANIP:$LCP"; JAR="$TMP/jar.txt"
  CODE=$(env -u MYDASH_PORT MYDASH_HOME="$LH" MYDASH_DATA="$LH/data" $CLI lan --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).code||"")')
  check "开启后有访问码" "test -n '$CODE'"
  check "局域网设备没登录时去登录页" "curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Accept: text/html' '$LB/' | grep '^302 .*/login?next=%2F' >/dev/null"
  check "没登录拿不到数据接口" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$LB/api/index')\" = 401"
  check "没登录拿不到实时推送" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$LB/events')\" = 401"
  check "登录页的样式能加载" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$LB/static/app.css')\" = 200"
  check "登录页不泄露项目名" "curl -s '$LB/login' | grep '输入访问码' >/dev/null && ! curl -s '$LB/login' | grep secretproj >/dev/null"
  check "访问码错误被拒" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -d code=AAAA-BBBB '$LB/login')\" = 401"
  check "内容端口没登录被拒" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$LCB/f/secretproj/lan-site/v1/index.html')\" = 401"
  check "访问码正确就登录并记住设备" "curl -s -c '$JAR' -o /dev/null -w '%{http_code}' -d \"code=\$(echo $CODE | tr A-Z a-z)\" '$LB/login' | grep 303 >/dev/null && grep mydash_session '$JAR' >/dev/null"
  check "登录后能看首页" "curl -s -b '$JAR' '$LB/' | grep secretproj >/dev/null"
  check "登录后内容端口也能打开（cookie 同主机共享）" "test \"\$(curl -s -b '$JAR' -o /dev/null -w '%{http_code}' '$LCB/f/secretproj/lan-site/v1/index.html')\" = 200"
  check "登录后能用写接口" "curl -s -b '$JAR' -H 'X-Mydash: 1' -H 'Content-Type: application/json' -H 'Origin: $LB' -d '{\"id\":\"secretproj/lan-site\",\"v\":1}' '$LB/api/read' | grep '\"ok\":true' >/dev/null"
  check "局域网设备看不到访问码" "test \"\$(curl -s -b '$JAR' -o /dev/null -w '%{http_code}' '$LB/api/access')\" = 403"
  check "本机能看到访问码和二维码" "curl -s 'http://127.0.0.1:$LPORT/api/access' | grep '\"lan\":true' | grep '<svg' >/dev/null"
  check "本机不用登录" "test \"\$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$LPORT/')\" = 200"
  check "局域网请求的 Host 也要对" "test \"\$(curl -s -b '$JAR' -o /dev/null -w '%{http_code}' -H 'Host: evil.example:$LPORT' '$LB/')\" = 421"
  check "扫码链接直接登录" "curl -s -o /dev/null -w '%{http_code}' -D - '$LB/login?code=$CODE' | grep -i 'set-cookie: mydash_session' >/dev/null"
  check "边栏有在其他设备上打开" "curl -s 'http://127.0.0.1:$LPORT/' | grep 'class=\"reach-btn\"' >/dev/null"
  env -u MYDASH_PORT MYDASH_HOME="$LH" MYDASH_DATA="$LH/data" $CLI lan reset >/dev/null
  check "换访问码后旧设备要重新登录" "curl -s -b '$JAR' -o /dev/null -w '%{http_code}' -H 'Accept: text/html' '$LB/' | grep 302 >/dev/null"
  for i in $(seq 1 10); do curl -s -o /dev/null -d code=WRONG-0000 "$LB/login"; done
  check "错太多次会被暂时挡住" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -d code=WRONG-0000 '$LB/login')\" = 429"
  kill $SRV_LAN 2>/dev/null
else
  echo "  （没有局域网地址，跳过）"
fi

echo "版本去重、清理旧版本"
DD="$TMP/dedup"; mkdir -p "$DD"; cp "$TMP/fx/report.pdf" "$DD/report.pdf"; printf '# 去重\n\n第一版\n' > "$DD/a.md"
(cd "$DD" && $CLI publish a.md report.pdf -p dd -s pack >/dev/null)
printf '# 去重\n\n第二版\n' > "$DD/a.md"
OUTD=$(cd "$DD" && $CLI publish a.md report.pdf -p dd -s pack 2>&1)
check "没变的文件直接链接（同一个 inode）" "test \"\$(stat -c %i '$MYDASH_DATA/dd/pack/v1/report.pdf' 2>/dev/null || stat -f %i '$MYDASH_DATA/dd/pack/v1/report.pdf')\" = \"\$(stat -c %i '$MYDASH_DATA/dd/pack/v2/report.pdf' 2>/dev/null || stat -f %i '$MYDASH_DATA/dd/pack/v2/report.pdf')\""
check "改了的文件是新的一份" "! cmp -s '$MYDASH_DATA/dd/pack/v1/a.md' '$MYDASH_DATA/dd/pack/v2/a.md'"
check "发布时说明哪些没变" "echo \"\$OUTD\" | grep '和上一版相同' >/dev/null"
check "meta 里记下 sha1" "grep '\"sha1\": \"[0-9a-f]\{40\}\"' '$MYDASH_DATA/dd/pack/meta.json' >/dev/null"
if [ -d "$MYDASH_DATA/dd/pack/v1/_pages" ]; then
  check "没变的 PDF 复用上一版的逐页图片" "echo \"\$OUTD\" | grep '复用了' >/dev/null && test -f '$MYDASH_DATA/dd/pack/v2/_pages/report.pdf/p001.jpg'"
fi
for i in 3 4; do printf '# 去重\n\n第 %s 版\n' $i > "$DD/a.md"; (cd "$DD" && $CLI publish a.md report.pdf -p dd -s pack >/dev/null); done
check "prune --dry-run 不删" "$CLI prune dd --keep 2 --dry-run | grep '2' >/dev/null && test -d '$MYDASH_DATA/dd/pack/v1'"
$CLI prune dd --keep 2 >/dev/null
check "prune 只留最近 2 个版本" "test ! -d '$MYDASH_DATA/dd/pack/v1' && test ! -d '$MYDASH_DATA/dd/pack/v2' && test -d '$MYDASH_DATA/dd/pack/v4'"
check "删掉旧版本后链接的文件还在" "test -s '$MYDASH_DATA/dd/pack/v4/report.pdf'"
check "prune 后 meta 只剩 2 个版本" "node -e 'process.exit(require(\"$MYDASH_DATA/dd/pack/meta.json\").versions.length===2?0:1)'"
check "prune 后条目页正常" "curl -s '$B/p/dd/pack' | grep '第 4 版' >/dev/null"

echo "类型、审批单、批注"
AP="$TMP/ap"; mkdir -p "$AP"
cat > "$AP/go.md" <<'MD'
# 新定价页要不要上线

背景说明……

```approval
{"questions":[{"id":"go","type":"choice","label":"要不要上线？","options":["同意","不同意"],"required":true},
 {"id":"keep","type":"multi","label":"保留哪些","options":["A","B","C","其他"]},
 {"id":"note","type":"text","label":"补充说明"}],"submit":"提交审批"}
```
MD
(cd "$AP" && $CLI publish go.md -p approj -s go-live >/dev/null)
check "含审批表单的自动算审批类" "grep '\"category\": \"approval\"' '$MYDASH_DATA/approj/go-live/meta.json' >/dev/null"
GP=$(curl -s "$B/p/approj/go-live")
check "审批单渲染成可以点选的表单" "echo \"\$GP\" | grep 'class=\"ap-q\" data-q=\"go\" data-type=\"choice\" data-required=\"1\"' >/dev/null && echo \"\$GP\" | grep 'type=\"radio\" name=\"go\" value=\"同意\" form=\"ap-form\"' >/dev/null"
check "有多选和文字题" "echo \"\$GP\" | grep 'type=\"checkbox\" name=\"keep\"' >/dev/null && echo \"\$GP\" | grep '<textarea name=\"note\"' >/dev/null"
check "提交按钮用表单里写的文字" "echo \"\$GP\" | grep '>提交审批</button>' >/dev/null"
check "单选题自带「其他」" "echo \"\$GP\" | grep 'name=\"go\" value=\"__other__\"' >/dev/null"
check "多选题也自带「其他」，agent 写的「其他」选项被它替换" "echo \"\$GP\" | grep 'name=\"keep\" value=\"__other__\"' >/dev/null && ! echo \"\$GP\" | grep 'name=\"keep\" value=\"其他\"' >/dev/null"
check "首页出现等你处理" "curl -s '$B/' | grep '等你处理' >/dev/null && curl -s '$B/' | grep 'ap-row\" href=\"/p/approj/go-live\"' >/dev/null"
check "选了其他但没写内容算没答" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/go-live\",\"v\":1,\"answers\":{\"go\":{\"other\":\"  \"}}}' -o /dev/null -w '%{http_code}' '$B/api/approval')\" = 422"
check "必答题没填会被拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/go-live\",\"v\":1,\"answers\":{\"keep\":[\"A\"]}}' -o /dev/null -w '%{http_code}' '$B/api/approval')\" = 422"
check "选项外的值被拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/go-live\",\"v\":1,\"answers\":{\"go\":\"乱写\"}}' -o /dev/null -w '%{http_code}' '$B/api/approval')\" = 422"
check "提交答复（含其他选项的自填）" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"approj/go-live\",\"v\":1,\"answers\":{\"go\":{\"other\":\"先灰度\"},\"keep\":[\"A\",\"C\"],\"note\":\"下周三前\"}}' '$B/api/approval' | grep '先灰度' >/dev/null"
check "条目页带上已提交的答复" "curl -s '$B/p/approj/go-live' | grep 'id=\"ap-data\"' | grep '先灰度' >/dev/null"
check "答了的进处理记录（已提交），等你处理里没了" "curl -s '$B/p/approj' | grep 'ap-pill ap-submitted' >/dev/null && ! curl -s '$B/' | grep '等你处理' >/dev/null"
AJ=$($CLI approvals approj --json)
check "approvals 能读到答复" "echo \"\$AJ\" | grep '下周三前' >/dev/null"
AID=$(echo "$AJ" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).answers[0].id)')
$CLI approvals done "$AID" >/dev/null
check "标记处理后状态变成已处理" "curl -s '$B/p/approj' | grep 'ap-pill ap-done' >/dev/null"
$CLI approvals wait approj/go-live --timeout 1 >/dev/null 2>&1; WT=$?
check "approvals wait：没人答复时到时退出（退出码 2）" "test $WT = 2"
$CLI approvals wait approj/go-live --json > "$TMP/wait.out" 2>&1 & WP=$!
sleep 1
POSTB -H 'X-Mydash: 1' -d '{"id":"approj/go-live","v":1,"answers":{"go":"同意"}}' "$B/api/approval" >/dev/null
for i in 1 2 3 4 5 6; do kill -0 $WP 2>/dev/null || break; sleep 1; done
check "approvals wait：一提交就退出并打印答复" "! kill -0 $WP 2>/dev/null && grep '同意' '$TMP/wait.out' >/dev/null"
kill $WP 2>/dev/null; $CLI approvals done "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).answers[0].id)' "$TMP/wait.out")" >/dev/null
# agent 正忙时，答复要等它答完这一轮再交过去
echo '{"session_id":"smoke-wait-1"}' | node "$ROOT/bin/agent-state.mjs" busy
CLAUDE_CODE_SESSION_ID=smoke-wait-1 $CLI approvals wait approj/go-live --json > "$TMP/wait2.out" 2>&1 & WP=$!
sleep 1
POSTB -H 'X-Mydash: 1' -d '{"id":"approj/go-live","v":1,"answers":{"go":"不同意"}}' "$B/api/approval" >/dev/null; sleep 3
check "agent 在忙：答复到了也先不打扰它" "kill -0 $WP 2>/dev/null && ! test -s '$TMP/wait2.out'"
echo '{"session_id":"smoke-wait-1"}' | node "$ROOT/bin/agent-state.mjs" idle
for i in 1 2 3 4 5 6; do kill -0 $WP 2>/dev/null || break; sleep 1; done
check "agent 答完这一轮才把答复交给它，并提醒先做完手上的事" "! kill -0 $WP 2>/dev/null && grep '不同意' '$TMP/wait2.out' >/dev/null && grep '\"note\"' '$TMP/wait2.out' >/dev/null"
kill $WP 2>/dev/null; $CLI approvals done "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).answers[0].id)' "$TMP/wait2.out")" >/dev/null
# 结局：同一个会话的新单取代旧单；对话里定了就关单；钩子提醒发单的会话；没人答就过期
mk() { printf '# %s\n\n```approval\n{"questions":[{"id":"a","options":["行","不行"]}]}\n```\n' "$2" > "$AP/$1.md"; }
mk s1 "会话一的第一张"; (cd "$AP" && CLAUDE_CODE_SESSION_ID=sess-ap-1 $CLI publish s1.md -p approj -s s1 >/dev/null)
mk s2 "会话一的第二张"; S2OUT=$(cd "$AP" && CLAUDE_CODE_SESSION_ID=sess-ap-1 $CLI publish s2.md -p approj -s s2 2>&1)
mk t1 "会话二的单子"; (cd "$AP" && CLAUDE_CODE_SESSION_ID=sess-ap-2 $CLI publish t1.md -p approj -s t1 >/dev/null); sleep 1
check "同一个会话的新单取代它的旧单" "echo \"\$S2OUT\" | grep 'approj/s1' >/dev/null && curl -s '$B/p/approj/s1' | grep '\"how\":\"superseded\"' >/dev/null"
check "别的会话的单子不受影响" "curl -s '$B/' | grep 'ap-row\" href=\"/p/approj/t1\"' >/dev/null && curl -s '$B/' | grep 'ap-row\" href=\"/p/approj/s2\"' >/dev/null && ! curl -s '$B/' | grep 'ap-row\" href=\"/p/approj/s1\"' >/dev/null"
check "审批单不进时间线、不算未读" "! curl -s '$B/' | grep 'data-id=\"approj/s2\"' >/dev/null && ! curl -s '$B/p/approj' | grep 'data-id=\"approj/t1\"' >/dev/null"
check "发审批单时告诉 agent 怎么等、怎么关" "echo \"\$S2OUT\" | grep 'approvals wait approj/s2' >/dev/null && echo \"\$S2OUT\" | grep 'approvals close approj/s2' >/dev/null && echo \"\$S2OUT\" | tail -1 | grep '/p/approj/s2$' >/dev/null"
REM=$(echo '{"session_id":"sess-ap-1"}' | node "$ROOT/bin/agent-state.mjs" busy)
check "钩子提醒发单的会话：单子还开着，对话里答了怎么关" "echo \"\$REM\" | grep 'approvals close approj/s2' >/dev/null && ! echo \"\$REM\" | grep 'approj/t1' >/dev/null"
check "没有开着的单子时钩子只提醒一次选择题的规则" "test \"\$(echo '{\"session_id\":\"sess-nobody\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep -c AskUserQuestion)\" = 1 && test -z \"\$(echo '{\"session_id\":\"sess-nobody\"}' | node '$ROOT/bin/agent-state.mjs' busy)\""
CLAUDE_CODE_SESSION_ID=sess-ap-2 $CLI approvals wait approj/t1 --json > "$TMP/wait3.out" 2>&1 & WP=$!
sleep 1
CLAUDE_CODE_SESSION_ID=sess-ap-2 $CLI approvals close --note "对话里说了：不行" >/dev/null
for i in 1 2 3 4 5; do kill -0 $WP 2>/dev/null || break; sleep 1; done
check "对话里定了：approvals close 关掉本会话开着的单子" "curl -s '$B/p/approj/t1' | grep '\"how\":\"chat\"' >/dev/null && curl -s '$B/p/approj/t1' | grep '对话里说了：不行' >/dev/null"
check "关单后，等它的命令也跟着结束" "! kill -0 $WP 2>/dev/null && grep '\"closed\":\"chat\"' '$TMP/wait3.out' >/dev/null"
kill $WP 2>/dev/null
check "关了的单子网页上提交不了" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/t1\",\"v\":1,\"answers\":{\"a\":\"行\"}}' -o /dev/null -w '%{http_code}' '$B/api/approval')\" = 409"
check "关了的单子进处理记录，钩子不再提醒" "curl -s '$B/p/approj' | grep 'ap-pill ap-chat' >/dev/null && test -z \"\$(echo '{\"session_id\":\"sess-ap-2\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep -v AskUserQuestion)\""
check "已经关了的不能再关" "! $CLI approvals close approj/t1 >/dev/null 2>&1"
node -e 'const fs=require("fs"),[f,a]=process.argv.slice(1),m=JSON.parse(fs.readFileSync(f)),t=new Date(Date.now()-4*864e5);m.versions.at(-1).time=t.toISOString();m.updated=t.toISOString();fs.writeFileSync(f,JSON.stringify(m,null,2));fs.utimesSync(a,t,t)' "$MYDASH_DATA/approj/s2/meta.json" "$MYDASH_HOME/state/agents/sess-ap-1.json"; sleep 1
check "没人答、发单的会话也停了 3 天：过期，进处理记录" "! curl -s '$B/' | grep 'ap-row\" href=\"/p/approj/s2\"' >/dev/null && curl -s '$B/p/approj' | grep 'ap-pill ap-expired' >/dev/null && curl -s '$B/p/approj/s2' | grep '\"how\":\"expired\"' >/dev/null"
check "帮助里有 approvals、ask" "$CLI --help | grep 'mydash approvals' >/dev/null && $CLI --help | grep 'mydash ask' >/dev/null"
# 类型
(cd "$AP" && printf '# 下周发布计划\n\n内容\n' > plan.md && $CLI publish plan.md -p approj -s next-plan >/dev/null)
(cd "$AP" && printf '# 杂项\n\n内容\n' > misc.md && $CLI publish misc.md -p approj -s misc --type report >/dev/null)
check "按标题推断成方案" "grep '\"category\": \"plan\"' '$MYDASH_DATA/approj/next-plan/meta.json' >/dev/null"
check "--type 指定的类型" "grep '\"category\": \"report\"' '$MYDASH_DATA/approj/misc/meta.json' >/dev/null"
(cd "$AP" && printf '# 杂项\n\n第二版\n' > misc.md && $CLI publish misc.md -p approj -s misc >/dev/null)
check "再发不带 --type 时保留指定的类型" "node -e 'const m=require(\"$MYDASH_DATA/approj/misc/meta.json\");process.exit(m.versions[1].category===\"report\"?0:1)'"
check "项目页有按类型筛选" "curl -s '$B/p/approj' | grep 'class=\"seg cat-seg\"' >/dev/null && curl -s '$B/p/approj' | grep 'data-cat=\"plan\"' >/dev/null"
check "列表里显示类型" "curl -s '$B/p/approj' | grep 'class=\"cat cat-plan\"' >/dev/null"
check "--type 乱写报错" "! $CLI publish '$AP/misc.md' -p approj -s misc --type nonsense >/dev/null 2>&1"
# 待办
printf '# 上线前要你做的几件事\n\n- [ ] 在 Tailscale 后台批准新节点\n- [ ] 运行 sudo bash enable-autologin.sh\n- [x] 安装 LibreOffice\n' > "$AP/todo.md"
(cd "$AP" && $CLI publish todo.md -p approj -s before-launch >/dev/null)
check "按标题推断成待办" "grep '\"category\": \"todo\"' '$MYDASH_DATA/approj/before-launch/meta.json' >/dev/null"
TP=$(curl -s "$B/p/approj/before-launch")
check "待办渲染成能勾的清单" "test \"\$(echo \"\$TP\" | grep -o 'class=\"todo-item\"' | wc -l | tr -d ' ')\" = 3 && ! echo \"\$TP\" | grep 'disabled=\"\" type=\"checkbox\"' >/dev/null"
check "条目页有进度条" "echo \"\$TP\" | grep 'class=\"td-bar\"' >/dev/null && echo \"\$TP\" | grep '已完成 1/3' >/dev/null"
check "首页等你处理里有没做完的待办" "curl -s '$B/' | grep 'ap-row td-row' | grep '还剩 2 项' >/dev/null"
TJ=$($CLI todos approj --json)
check "todos 能读到待办" "echo \"\$TJ\" | node -e 'const j=JSON.parse(require(\"fs\").readFileSync(0));const x=j.todos.find(t=>t.item===\"approj/before-launch\");process.exit(x&&x.total===3&&x.done===1?0:1)'"
TK=$(echo "$TJ" | node -e 'const j=JSON.parse(require("fs").readFileSync(0));process.stdout.write(j.todos.find(t=>t.item==="approj/before-launch").items[0].key)')
check "勾掉一项" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"approj/before-launch\",\"v\":1,\"key\":\"'$TK'\",\"done\":true}' '$B/api/todo' | grep '\"done\":true' >/dev/null"
check "不存在的待办被拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/before-launch\",\"v\":1,\"key\":\"nope\",\"done\":true}' -o /dev/null -w '%{http_code}' '$B/api/todo')\" = 404"
check "勾掉后进度跟着变" "curl -s '$B/' | grep 'ap-row td-row' | grep '还剩 1 项' >/dev/null && curl -s '$B/p/approj/before-launch' | grep 'id=\"td-data\"' | grep '\"'$TK'\":true' >/dev/null"
printf '# 上线前要你做的几件事\n\n- [ ] 在 Tailscale 后台批准新节点\n- [ ] 运行 sudo bash enable-autologin.sh\n- [x] 安装 LibreOffice\n- [ ] 新加的一项\n' > "$AP/todo.md"
(cd "$AP" && $CLI publish todo.md -p approj -s before-launch >/dev/null)
check "新版本里文字没变的待办保持已勾" "$CLI todos approj/before-launch --json | node -e 'const x=JSON.parse(require(\"fs\").readFileSync(0)).todos[0];process.exit(x.total===4&&x.done===2?0:1)'"
printf '# 迁移方案\n\n- [ ] agent 自己的步骤\n\n```todo\n- [ ] 你来登录云服务器后台\n```\n' > "$AP/mig.md"
(cd "$AP" && $CLI publish mig.md -p approj -s migration >/dev/null)
MP=$(curl -s "$B/p/approj/migration")
check "方案里嵌待办块：类型还是方案" "grep '\"category\": \"plan\"' '$MYDASH_DATA/approj/migration/meta.json' >/dev/null"
check "方案里只有待办块里的能勾" "test \"\$(echo \"\$MP\" | grep -o 'class=\"todo-item\"' | wc -l | tr -d ' ')\" = 1 && echo \"\$MP\" | grep 'class=\"todo-block\"' >/dev/null && echo \"\$MP\" | grep 'disabled=\"\" type=\"checkbox\"' >/dev/null"
check "方案里的待办也进等你处理" "curl -s '$B/' | grep 'ap-row td-row\" href=\"/p/approj/migration\"' >/dev/null"
node -e 'const f=process.argv[1],fs=require("fs"),m=JSON.parse(fs.readFileSync(f));for(const v of m.versions)v.category="todo";m.category="todo";fs.writeFileSync(f,JSON.stringify(m,null,2))' "$MYDASH_DATA/approj/migration/meta.json"; sleep 1
check "改了类型后待办跟着更新（不用旧缓存）" "curl -s '$B/p/approj/migration' | grep '已完成 0/2' >/dev/null"
(cd "$AP" && $CLI publish misc.md -p approj -s misc-todo --type todo >/dev/null)
check "--type todo" "grep '\"category\": \"todo\"' '$MYDASH_DATA/approj/misc-todo/meta.json' >/dev/null"
check "帮助里有 todos、asks" "$CLI --help | grep 'mydash todos' >/dev/null && $CLI --help | grep 'mydash asks' >/dev/null"
check "待办类不进时间线" "! curl -s '$B/' | grep 'data-id=\"approj/before-launch\"' >/dev/null"
check "对话里说做完了：todos done 按开头几个字勾上" "$CLI todos done approj/before-launch '运行 sudo' | grep '3/4' >/dev/null"
check "对不上或对上好几项时报错" "! $CLI todos done approj/before-launch '不存在的一项' >/dev/null 2>&1"
$CLI todos done approj/before-launch '新加的' >/dev/null; sleep 1
check "全勾完的待办离开等你处理，进处理记录" "! curl -s '$B/' | grep 'ap-row td-row\" href=\"/p/approj/before-launch\"' >/dev/null && curl -s '$B/p/approj' | grep 'rec-row' | grep 'before-launch' >/dev/null"
printf '# 要你做的\n\n- [ ] 第一件\n- [ ] 第二件\n' > "$AP/td2.md"; TDOUT=$(cd "$AP" && CLAUDE_CODE_SESSION_ID=sess-td-1 $CLI publish td2.md -p approj -s td2 --type todo 2>&1)
check "发待办时告诉 agent 怎么替用户勾" "echo \"\$TDOUT\" | grep 'todos done approj/td2' >/dev/null"
check "钩子提醒发待办的会话" "echo '{\"session_id\":\"sess-td-1\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep 'todos done approj/td2' >/dev/null"
$CLI todos done approj/td2 '第一件' '第二件' >/dev/null
check "待办勾完后钩子不再提醒" "test -z \"\$(echo '{\"session_id\":\"sess-td-1\"}' | node '$ROOT/bin/agent-state.mjs' busy)\""
# 自动检测：<!-- check: 命令 --> 成功就替用户勾上
printf '# 要你做的三件事\n\n- [ ] 放好第一面旗 <!-- check: test -f "%s/flag-1" -->\n- [ ] 放好第二面旗 <!-- check: test -f "%s/flag-2" -->\n- [ ] 没法检测的一件\n' "$TMP" "$TMP" > "$AP/td3.md"
TD3OUT=$(cd "$AP" && $CLI publish td3.md -p approj -s td3 --type todo 2>&1)
TJ3() { $CLI todos approj/td3 --json --done | node -e "const x=JSON.parse(require('fs').readFileSync(0)).todos[0];process.stdout.write(x.items.map(i=>i.done?1:0).join(''))"; }
check "发待办时告诉 agent 可以加自动检测" "echo \"\$TD3OUT\" | grep 'check:' >/dev/null"
check "带检测的项在网页上标出来" "test \"\$(curl -s '$B/p/approj/td3' | grep -o 'class=\"todo-item has-check\"' | wc -l | tr -d ' ')\" = 2 && curl -s '$B/p/approj/td3' | grep 'class=\"todo-auto\"' >/dev/null"
check "检测项的 key 不受检测命令影响" "test \"\$($CLI todos approj/td3 --json | node -e 'process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0)).todos[0].items[0].text)')\" = '放好第一面旗'"
check "还没做完：自动检测不勾" "$CLI todos check approj/td3 | grep '没有新做完的' >/dev/null && test \"\$(TJ3)\" = 000"
touch "$TMP/flag-1"; $CLI todos check approj/td3 >/dev/null
check "做完了：自动检测替用户勾上，没做完的、没法检测的不动" "test \"\$(TJ3)\" = 100"
TK3=$($CLI todos approj/td3 --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).todos[0].items[0].key)')
POSTB -H 'X-Mydash: 1' -d '{"id":"approj/td3","v":1,"key":"'$TK3'","done":false}' "$B/api/todo" >/dev/null; $CLI todos check approj/td3 >/dev/null
check "用户手动取消过的，不再自动勾回去" "test \"\$(TJ3)\" = 000"
touch "$TMP/flag-2"; sleep 5; curl -s "$B/p/approj/td3" >/dev/null; sleep 3
check "打开这份待办时马上检测一次" "test \"\$(TJ3)\" = 010"
check "页面能拉到最新的勾选状态" "curl -s '$B/api/todos?id=approj/td3' | grep '\"done\"' >/dev/null"
# 「问一下」：在某一项上提问，agent 用一两句话回答，回答挂在那一项下面
TK3B=$($CLI todos approj/td3 --json --done | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).todos[0].items[2].key)')
check "空问题、不存在的项被拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/td3\",\"v\":1,\"kind\":\"todo\",\"key\":\"'$TK3B'\",\"text\":\"  \"}' '$B/api/ask')\" = 400 && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/td3\",\"v\":1,\"kind\":\"todo\",\"key\":\"nope\",\"text\":\"啊\"}' '$B/api/ask')\" = 404"
AQ=$(POSTB -H 'X-Mydash: 1' -d '{"id":"approj/td3","v":1,"kind":"todo","key":"'$TK3B'","text":"这一项具体要做什么？"}' "$B/api/ask")
AQID=$(echo "$AQ" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).ask.id)')
check "在某一项上提问，记下是哪一项" "echo \"\$AQ\" | grep '\"label\":\"没法检测的一件\"' >/dev/null"
check "页面带上提问，agent 能列出来" "curl -s '$B/p/approj/td3' | grep 'id=\"ask-data\"' | grep '这一项具体要做什么' >/dev/null && $CLI asks approj/td3 | grep '$AQID' >/dev/null"
check "发东西的会话不在了：同一个项目里的新会话被提醒去回答" "echo '{\"session_id\":\"sess-new-1\",\"cwd\":\"/somewhere/approj/sub\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep 'asks reply $AQID' >/dev/null"
check "别的项目里的会话不会被提醒" "! echo '{\"session_id\":\"sess-new-2\",\"cwd\":\"/somewhere/otherproj\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep '$AQID' >/dev/null"
check "回答太长被拒（一两句话就够）" "! $CLI asks reply $AQID \"\$(node -e 'process.stdout.write(\"很长\".repeat(300))')\" >/dev/null 2>&1"
check "回答" "$CLI asks reply $AQID '去设置页填一个渠道就行。' | grep '已回答' >/dev/null && curl -s '$B/api/asks?id=approj/td3' | grep '去设置页填一个渠道就行' >/dev/null"
check "回答后提醒没了" "! echo '{\"session_id\":\"sess-new-1\",\"cwd\":\"/somewhere/approj\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep '$AQID' >/dev/null"
$CLI todos wait approj/td3 --json > "$TMP/wait-ask.out" 2>&1 & WP=$!
sleep 1
check "没人问时 todos wait 一直等" "kill -0 $WP 2>/dev/null"
POSTB -H 'X-Mydash: 1' -d '{"id":"approj/td3","v":1,"kind":"todo","key":"'$TK3B'","text":"还是不懂"}' "$B/api/ask" >/dev/null
for i in 1 2 3 4 5 6; do kill -0 $WP 2>/dev/null || break; sleep 1; done
check "有人问了：todos wait 醒来，带上问题" "! kill -0 $WP 2>/dev/null && grep '还是不懂' '$TMP/wait-ask.out' >/dev/null && grep 'asks reply' '$TMP/wait-ask.out' >/dev/null"
kill $WP 2>/dev/null
# 审批题上也能问；发单的会话还在时别的会话不接手，会话关了才接手
printf '# 要不要换库\n\n```approval\n{"questions":[{"id":"db","label":"换哪个？","options":["甲","乙"]}]}\n```\n' > "$AP/apq.md"
(cd "$AP" && CLAUDE_CODE_SESSION_ID=sess-ap-9 $CLI publish apq.md -p approj -s apq >/dev/null)
echo '{"session_id":"sess-ap-9"}' | node "$ROOT/bin/agent-state.mjs" idle
AQ2=$(POSTB -H 'X-Mydash: 1' -d '{"id":"approj/apq","v":1,"kind":"approval","key":"db","text":"甲和乙差在哪？"}' "$B/api/ask")
check "审批题上也能问" "echo \"\$AQ2\" | grep '\"label\":\"换哪个？\"' >/dev/null"
check "关了的审批单不能再问" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/t1\",\"v\":1,\"kind\":\"approval\",\"key\":\"a\",\"text\":\"？\"}' '$B/api/ask')\" = 409"
check "发单的会话还在：提醒它自己回答，别的会话不接手" "echo '{\"session_id\":\"sess-ap-9\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep '甲和乙差在哪' >/dev/null && ! echo '{\"session_id\":\"sess-new-3\",\"cwd\":\"/x/approj\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep '甲和乙差在哪' >/dev/null"
echo '{"session_id":"sess-ap-9"}' | node "$ROOT/bin/agent-state.mjs" ended
check "发单的会话关了：同一个项目里的新会话接手" "echo '{\"session_id\":\"sess-new-3\",\"cwd\":\"/x/approj\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep '甲和乙差在哪' >/dev/null"
# 批注
check "批注：写一条" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"approj/next-plan\",\"v\":1,\"file\":\"plan.md\",\"quote\":\"内容\",\"heading\":\"下周发布计划\",\"text\":\"这里要写具体日期\"}' '$B/api/comment' | grep '具体日期' >/dev/null"
check "空批注被拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"approj/next-plan\",\"v\":1,\"text\":\"  \"}' -o /dev/null -w '%{http_code}' '$B/api/comment')\" = 400"
check "列表显示未处理批注数" "curl -s '$B/p/approj' | grep 'class=\"cm-pill\"' >/dev/null"
check "条目页有批注区" "curl -s '$B/p/approj/next-plan' | grep 'class=\"cm-panel\"' >/dev/null && curl -s '$B/p/approj/next-plan' | grep 'id=\"cm-data\"' | grep '具体日期' >/dev/null"
FB=$($CLI feedback approj --json)
check "feedback 列出批注（带引用的原文）" "echo \"\$FB\" | grep '具体日期' >/dev/null && echo \"\$FB\" | grep '\"quote\":\"内容\"' >/dev/null"
check "feedback 人看的格式" "$CLI feedback approj | grep '这里要写具体日期' >/dev/null"
CID=$(echo "$FB" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).open[0].id)')
(cd "$AP" && printf '# 下周发布计划\n\n周三上线\n' > plan.md && $CLI publish plan.md -p approj -s next-plan --resolves "$CID" >/dev/null)
check "发布时 --resolves 标记已处理" "$CLI feedback approj | grep '没有未处理的批注' >/dev/null && grep '\"resolvedIn\": 2' '$MYDASH_DATA/approj/next-plan/responses.json' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"id":"approj/misc","v":2,"text":"第二条意见"}' "$B/api/comment" >/dev/null
CID2=$($CLI feedback approj --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).open[0].id)')
$CLI feedback done "$CID2" --note "已改" >/dev/null
check "feedback done 标记已处理并记下说明" "grep '\"note\": \"已改\"' '$MYDASH_DATA/approj/misc/responses.json' >/dev/null"
check "已处理的批注不能删" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"approj/misc\",\"cid\":\"'$CID2'\"}' '$B/api/comment/delete' | grep '第二条意见' >/dev/null"

echo "未读太多：静音、归档、今日摘要、版本对比"
check "版本对比：next-plan v1→v2" "curl -s '$B/p/approj/next-plan?diff=1' | grep 'v1 → v2 的改动' >/dev/null && curl -s '$B/p/approj/next-plan?diff=1' | grep 'class=\"dl dl-add\"' >/dev/null"
check "对比时按词标出改动" "curl -s '$B/p/approj/next-plan?diff=1' | grep '<ins>' >/dev/null"
check "条目页有和上一版对比的按钮" "curl -s '$B/p/approj/next-plan' | grep '和 v1 对比' >/dev/null"
check "历史版本里每版能对比" "curl -s '$B/p/approj/next-plan' | grep 'class=\"vd\"' >/dev/null"
check "图片不提供对比" "! curl -s '$B/p/smoke/screens' | grep '对比' >/dev/null"
U0=$(curl -s "$B/p/approj" | grep -o 'class="entry unread' | wc -l | tr -d ' ')
POSTJ -H 'X-Mydash: 1' -d '{"project":"approj","muted":true}' "$B/api/mute" >/dev/null
check "静音后项目里的条目不算未读" "test \"\$(curl -s '$B/p/approj' | grep -o 'class=\"entry unread' | wc -l | tr -d ' ')\" = 0 && test $U0 -gt 0"
check "静音后项目页显示已静音" "curl -s '$B/p/approj' | grep '已静音' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"project":"approj","muted":false}' "$B/api/mute" >/dev/null
check "取消静音后又算未读" "curl -s '$B/p/approj' | grep 'class=\"entry unread' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"id":"approj/misc","archived":true}' "$B/api/archive" >/dev/null
check "归档后不在列表里" "! curl -s '$B/p/approj' | grep 'data-id=\"approj/misc\"' >/dev/null"
check "列表底部提示有归档" "curl -s '$B/p/approj' | grep '已归档 1 份' >/dev/null"
check "?archived=1 能看到归档的" "curl -s '$B/p/approj?archived=1' | grep 'data-id=\"approj/misc\"' >/dev/null"
check "归档的条目页能打开且显示取消归档" "curl -s '$B/p/approj/misc' | grep '取消归档' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"id":"approj/misc","archived":false}' "$B/api/archive" >/dev/null
check "取消归档回到列表" "curl -s '$B/p/approj' | grep 'data-id=\"approj/misc\"' >/dev/null"
# 自动归档：把一个未读条目的时间改到 30 天前
node -e '
const fs=require("fs"),p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));const old=new Date(Date.now()-30*86400e3).toISOString();
m.updated=old;m.versions.forEach(v=>v.time=old);fs.writeFileSync(p,JSON.stringify(m,null,2));' "$MYDASH_DATA/approj/next-plan/meta.json"
# 直接改文件绕过了服务器，像 CLI 发布后那样通知它（Linux 上 fs.watch 对新建的目录会慢一拍）
POSTJ -H 'X-Mydash: 1' -d '{"project":"approj","slug":"next-plan"}' "$B/api/published" >/dev/null
curl -s -X POST -H 'X-Mydash: 1' -H 'Content-Type: application/json' -d '{"id":"approj/next-plan","unread":true}' "$B/api/read" >/dev/null; sleep 1.2
check "超过 14 天没看的未读自动归档" "! curl -s '$B/p/approj' | grep 'data-id=\"approj/next-plan\"' >/dev/null && curl -s '$B/p/approj?archived=1' | grep 'data-id=\"approj/next-plan\"' >/dev/null"
DG=$(curl -s "$B/today")
check "今日摘要页" "echo \"\$DG\" | grep '<h1 class=\"page-title\">今天</h1>' >/dev/null && echo \"\$DG\" | grep 'class=\"dg-list\"' >/dev/null"
check "首页有今日摘要入口" "curl -s '$B/' | grep 'href=\"/today\"' >/dev/null"
check "摘要页的全部已读只标今天的" "echo \"\$DG\" | grep 'data-ids=\"' >/dev/null"

echo "推送通知、全文搜索"
SINKP=$((PORT+6)); SINKF="$TMP/pushes.txt"; : > "$SINKF"
node -e "require('http').createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{require('fs').appendFileSync('$SINKF',q.method+' '+q.url+' '+b+'\n');r.setHeader('Content-Type','application/json');r.end(q.url.includes('getUpdates')?JSON.stringify({ok:true,result:[{message:{chat:{id:4242,first_name:'Van'}}}]}):JSON.stringify({ok:true,status:1,errcode:0,code:0}))})}).listen($SINKP,'127.0.0.1')" & SINK=$!; sleep 0.4
[ -f "$MYDASH_HOME/config.json" ] || echo '{}' > "$MYDASH_HOME/config.json"
check "设置 ntfy 通知会先发一条测试" "$CLI notify ntfy http://127.0.0.1:$SINKP/mydash-test >/dev/null && grep '\"topic\":\"mydash-test\"' '$SINKF' >/dev/null"
: > "$SINKF"
(cd "$AP" && printf '# 通知测试\n\n第一版\n' > n.md && $CLI publish n.md -p notifproj -s note-1 >/dev/null); sleep 1
check "发新条目会推送" "grep 'note-1\|通知测试' '$SINKF' >/dev/null"
check "推送里带条目链接" "grep '\"click\":\"http://127.0.0.1:$PORT/p/notifproj/note-1\"' '$SINKF' >/dev/null"
: > "$SINKF"
(cd "$AP" && sed 's/新定价页要不要上线/通知审批/' go.md > go2.md && $CLI publish go2.md -p notifproj -s go2 >/dev/null); sleep 1
check "审批单推送标题是待你审批" "grep '待你审批' '$SINKF' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"project":"notifproj","muted":true}' "$B/api/mute" >/dev/null; : > "$SINKF"
(cd "$AP" && printf '# 通知测试\n\n第二版\n' > n.md && $CLI publish n.md -p notifproj -s note-1 >/dev/null); sleep 1
check "静音的项目不推送" "! test -s '$SINKF'"
check "notify daily 设置时间" "$CLI notify daily 21:00 | grep '21:00' >/dev/null && grep '\"daily\": \"21:00\"' '$MYDASH_HOME/config.json' >/dev/null"
check "notify daily 格式不对会报错" "! $CLI notify daily 9pm >/dev/null 2>&1"
# 两个渠道同时开
POSTJ -H 'X-Mydash: 1' -d '{"project":"notifproj","muted":false}' "$B/api/mute" >/dev/null
$CLI notify bark "http://127.0.0.1:$SINKP/barkkey" >/dev/null; : > "$SINKF"
check "Bark 和 ntfy 可以同时开" "node -e 'const c=require(\"$MYDASH_HOME/config.json\").notify;process.exit(c.channels.length===2&&c.daily===\"21:00\"?0:1)'"
(cd "$AP" && printf '# 两个渠道\n\n内容\n' > n2.md && $CLI publish n2.md -p notifproj -s note-2 >/dev/null); sleep 1
check "新条目两个渠道都推" "grep '^GET /barkkey/' '$SINKF' >/dev/null && grep '\"topic\":\"mydash-test\"' '$SINKF' >/dev/null"
$CLI notify bark off >/dev/null
check "notify bark off 只关 Bark" "node -e 'const c=require(\"$MYDASH_HOME/config.json\").notify;process.exit(c.channels.length===1&&c.channels[0].type===\"ntfy\"?0:1)'"
# 设置页
check "设置页能打开，渠道一行一个，带密钥的网址只显示前后几位" "curl -s '$B/settings' | grep 'id=\"set-form\"' >/dev/null && curl -s '$B/settings' | grep 'class=\"set-chrow' >/dev/null && curl -s '$B/settings' | grep 'myd…est' >/dev/null && ! curl -s '$B/settings' | grep '/mydash-test' >/dev/null"
check "顶栏有设置入口" "curl -s '$B/' | grep 'class=\"set-link\" href=\"/settings\"' >/dev/null"
check "设置页改了就存：归档天数、每日时间" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"autoArchiveDays\":30,\"daily\":\"08:30\"}' '$B/api/settings')\" = 200 && node -e 'const c=require(\"$MYDASH_HOME/config.json\");process.exit(c.autoArchiveDays===30&&c.notify.daily===\"08:30\"&&c.notify.channels.length===1?0:1)'"
check "设置页加渠道：Bark 和第二个 ntfy" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"add\",\"type\":\"bark\",\"fields\":{\"url\":\"http://127.0.0.1:'$SINKP'/k2\"}}' '$B/api/channels')\" = 200 && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"add\",\"type\":\"ntfy\",\"name\":\"第二个\",\"fields\":{\"url\":\"http://127.0.0.1:'$SINKP'/t2\"}}' '$B/api/channels')\" = 200 && node -e 'const c=require(\"$MYDASH_HOME/config.json\").notify.channels;process.exit(c.length===3&&c.filter(x=>x.type===\"ntfy\").length===2&&c.some(x=>x.name===\"第二个\")?0:1)'"
check "设置页加渠道：网址不对会拒，同一个加两次也拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"add\",\"type\":\"bark\",\"fields\":{\"url\":\"not a url\"}}' '$B/api/channels')\" = 400 && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"add\",\"type\":\"bark\",\"fields\":{\"url\":\"http://127.0.0.1:'$SINKP'/k2\"}}' '$B/api/channels')\" = 409"
check "设置页保存：天数不对会拒" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"autoArchiveDays\":-1,\"bark\":\"\",\"ntfy\":\"\",\"daily\":\"\"}' '$B/api/settings')\" = 400"
: > "$SINKF"
check "设置页上发一条试试（还没存的表单）" "POSTB -H 'X-Mydash: 1' -d '{\"type\":\"ntfy\",\"fields\":{\"url\":\"http://127.0.0.1:'$SINKP'/try\"}}' '$B/api/notify-test' | grep '\"ok\":true' >/dev/null && grep '\"topic\":\"try\"' '$SINKF' >/dev/null"
CHID() { node -e 'const c=require(process.argv[1]).notify.channels.find(x=>x.type===process.argv[2]&&(!process.argv[3]||JSON.stringify(x).includes(process.argv[3])));process.stdout.write(c?c.id:"")' "$MYDASH_HOME/config.json" "$1" "${2:-}"; }
: > "$SINKF"
check "设置页上发一条试试（存好的那一个，按编号）" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"'\$(CHID ntfy t2)'\"}' '$B/api/notify-test' | grep '\"ok\":true' >/dev/null && grep '\"topic\":\"t2\"' '$SINKF' >/dev/null && ! grep '\"topic\":\"mydash-test\"' '$SINKF' >/dev/null"
# 更多渠道：Telegram、Pushover、群机器人、邮件（本机假的 SMTP 服务器）
cat > "$TMP/fake-smtp.cjs" <<'JS'
const [port, out] = process.argv.slice(2); const fs = require('fs');
require('net').createServer(c => {
  let buf = '', data = false; const say = s => c.write(s + '\r\n'); say('220 fake');
  c.on('data', d => { buf += d; let i;
    while ((i = buf.indexOf(data ? '\r\n.\r\n' : '\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + (data ? 5 : 2));
      if (data) { fs.appendFileSync(out, line + '\n---\n'); data = false; say('250 queued'); continue; }
      fs.appendFileSync(out, '> ' + line + '\n');
      const v = line.slice(0, 4).toUpperCase();
      if (v === 'EHLO') { c.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n'); } else if (v === 'AUTH') say('235 ok'); else if (v === 'DATA') { data = true; say('354 go'); }
      else if (v === 'QUIT') { say('221 bye'); c.end(); } else say('250 ok');
    } });
}).listen(Number(port), '127.0.0.1');
JS
SMTPP=$((PORT+7)); SMTPF="$TMP/mail.txt"; : > "$SMTPF"
node "$TMP/fake-smtp.cjs" $SMTPP "$SMTPF" & SMTPD=$!; sleep 0.4; : > "$SINKF"
check "Telegram：设好后先发一条测试" "$CLI notify telegram 123456:ABCDEFGHIJKLMNOPQRSTUVWX 4242 >/dev/null && grep 'POST /tg/bot123456:ABCDEFGHIJKLMNOPQRSTUVWX/sendMessage' '$SINKF' | grep '\"chat_id\":\"4242\"' >/dev/null"
check "Pushover" "$CLI notify pushover uQiRzpo4DXghDmr9QzzfQu27cmVRsG azGDORePK8gMaC0QOYAMyEEuzJnyUi >/dev/null && grep 'POST /po/1/messages.json' '$SINKF' >/dev/null"
check "群机器人：内容带 mydash（钉钉关键词）" "$CLI notify webhook http://127.0.0.1:$SINKP/hook >/dev/null && grep 'POST /hook' '$SINKF' | grep '\[mydash\]' >/dev/null"
check "群机器人按网址认出是哪家" "node -e 'import(\"$ROOT/lib/notify.mjs\").then(n=>process.exit([\"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x\",\"https://open.feishu.cn/open-apis/bot/v2/hook/x\",\"https://oapi.dingtalk.com/robot/send?access_token=x\",\"https://hooks.slack.com/services/x\",\"https://discord.com/api/webhooks/x\"].map(n.webhookKind).join()===\"wecom,feishu,dingtalk,slack,discord\"?0:1))'"
check "邮件：用 SMTP 登录后发出，中文标题编码正确" "$CLI notify email --host 127.0.0.1 --port $SMTPP --secure none --user me@example.com --pass pw-secret --to me@example.com >/dev/null && grep '> AUTH PLAIN' '$SMTPF' >/dev/null && grep '^Subject: mydash' '$SMTPF' >/dev/null && grep 'RCPT TO:<me@example.com>' '$SMTPF' >/dev/null"
check "填了密码类的渠道后，配置文件只给自己读" "test \"\$(stat -c %a '$MYDASH_HOME/config.json' 2>/dev/null || stat -f %Lp '$MYDASH_HOME/config.json')\" = 600"
: > "$SINKF"; : > "$SMTPF"
(cd "$AP" && printf '# 多渠道\n\n内容\n' > n4.md && $CLI publish n4.md -p notifproj -s note-4 >/dev/null); sleep 2
check "几个渠道同时开，新条目每个都推（同一种的两个 ntfy 也都推）" "grep 'sendMessage' '$SINKF' >/dev/null && grep 'messages.json' '$SINKF' >/dev/null && grep 'POST /hook' '$SINKF' >/dev/null && grep '\"topic\":\"t2\"' '$SINKF' >/dev/null && grep '\"topic\":\"mydash-test\"' '$SINKF' >/dev/null && grep '^GET /k2/' '$SINKF' >/dev/null && grep 'DATA' '$SMTPF' >/dev/null"
SP=$(curl -s "$B/settings")
check "设置页不回显密码和令牌，每个渠道一行" "! echo \"\$SP\" | grep 'pw-secret' >/dev/null && ! echo \"\$SP\" | grep 'azGDORePK8gMaC0QOYAMyEEuzJnyUi' >/dev/null && ! echo \"\$SP\" | grep 'ABCDEFGHIJKLMNOPQRSTUVWX' >/dev/null && test \"\$(echo \"\$SP\" | grep -c 'class=\"set-chrow')\" = \"\$(node -e 'process.stdout.write(String(require(\"$MYDASH_HOME/config.json\").notify.channels.length))')\""
check "设置页改渠道：密码、带密钥的网址留空就不改，名字改了" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"update\",\"id\":\"'\$(CHID email)'\",\"name\":\"工作邮箱\",\"fields\":{\"host\":\"127.0.0.1\",\"port\":\"'$SMTPP'\",\"secure\":\"none\",\"user\":\"me@example.com\",\"pass\":\"\",\"to\":\"me@example.com\"}}' '$B/api/channels')\" = 200 && grep '\"pass\": \"pw-secret\"' '$MYDASH_HOME/config.json' >/dev/null && grep '工作邮箱' '$MYDASH_HOME/config.json' >/dev/null && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"update\",\"id\":\"'\$(CHID bark)'\",\"fields\":{\"url\":\"\"}}' '$B/api/channels')\" = 200 && grep '/k2' '$MYDASH_HOME/config.json' >/dev/null"
check "设置页删一个渠道：只删那一个" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"remove\",\"id\":\"'\$(CHID pushover)'\"}' '$B/api/channels')\" = 200 && ! grep 'pushover' '$MYDASH_HOME/config.json' >/dev/null && grep 'telegram' '$MYDASH_HOME/config.json' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"op":"toggle","id":"'$(CHID ntfy mydash-test)'","on":false}' "$B/api/channels" >/dev/null; : > "$SINKF"
(cd "$AP" && printf '# 关掉一个\n\n内容\n' > n5.md && $CLI publish n5.md -p notifproj -s note-5 >/dev/null); sleep 2
check "设置页关掉一个渠道（不删）：它不再推，别的照推" "node -e 'process.exit(require(\"$MYDASH_HOME/config.json\").notify.channels.find(x=>x.url&&x.url.includes(\"mydash-test\")).off===true?0:1)' && ! grep '\"topic\":\"mydash-test\"' '$SINKF' >/dev/null && grep '\"topic\":\"t2\"' '$SINKF' >/dev/null"
check "命令行：同一种再加一个、起名字，列表里带编号，按编号删" "$CLI notify bark http://127.0.0.1:$SINKP/k3 --name 太太 >/dev/null && $CLI notify | grep '太太' >/dev/null && test \"\$(node -e 'process.stdout.write(String(require(\"$MYDASH_HOME/config.json\").notify.channels.filter(x=>x.type===\"bark\").length))')\" = 2 && $CLI notify remove \$(CHID bark k3) >/dev/null && ! grep '/k3' '$MYDASH_HOME/config.json' >/dev/null"
check "推送渠道：每一种都带一份点开才显示的设置教程，网页推送也有" "test \"\$(curl -s '$B/settings' | grep -o 'class=\"set-guide\"' | wc -l | tr -d ' ')\" = 7 && curl -s '$B/settings' | grep -q '怎么设置？看一步步的教程' && curl -s '$B/settings' | grep -q '@BotFather'"
check "教程按页面语言显示（这台设备选了英文就是英文）" "curl -s -b 'mydash_lang=en' '$B/settings' | grep -q 'How to set it up, step by step' && ! curl -s -b 'mydash_lang=en' '$B/settings' | grep -q '怎么设置？看一步步的教程'"
check "邮箱教程里有「填入这些设置」：Gmail、QQ、163 用 465 + TLS，iCloud 用 587 + STARTTLS" "curl -s '$B/settings' | grep -q 'data-host=\"smtp.gmail.com\" data-port=\"465\" data-secure=\"tls\"' && curl -s '$B/settings' | grep -q 'data-host=\"smtp.mail.me.com\" data-port=\"587\" data-secure=\"starttls\"'"
check "Telegram：改已有的渠道时，用它保存的 token 找出 chat id" "POSTB -H 'X-Mydash: 1' -d '{\"token\":\"\",\"id\":\"'\$(CHID telegram)'\"}' '$B/api/telegram-chat' | grep '\"chat\":\"4242\"' >/dev/null"
check "Telegram：新加的（没有编号）不借用别的渠道保存的 token" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"token\":\"\"}' '$B/api/telegram-chat')\" = 400"
check "设置页发一条试试：改的时候密码留空就用保存的" "POSTB -H 'X-Mydash: 1' -d '{\"id\":\"'\$(CHID email)'\",\"fields\":{\"host\":\"127.0.0.1\",\"port\":\"'$SMTPP'\",\"secure\":\"none\",\"user\":\"me@example.com\",\"pass\":\"\",\"to\":\"me@example.com\"}}' '$B/api/notify-test' | grep '\"ok\":true' >/dev/null && tail -20 '$SMTPF' | grep '> AUTH PLAIN' >/dev/null"
check "这台设备的语言：cookie 选英文，整页就是英文，浏览器端译文也跟着换" "curl -s -H 'Cookie: mydash_lang=en' '$B/' | grep '<html lang=\"en\"' >/dev/null && curl -s -H 'Cookie: mydash_lang=en' '$B/' | grep 'i18n.js?l=en' >/dev/null && curl -s '$B/i18n.js?l=en' | grep 'window.__LANG=\"en\"' >/dev/null && curl -s '$B/' | grep '<html lang=\"zh-CN\"' >/dev/null && curl -s '$B/' | grep 'class=\"lang-btn\" data-lang=\"en\"' >/dev/null"
check "边栏的收起按钮在边栏里" "curl -s '$B/' | node -e 'const h=require(\"fs\").readFileSync(0,\"utf8\");const a=h.indexOf(\"<aside\"),b=h.indexOf(\"</aside>\"),c=h.indexOf(\"class=\\\"side-collapse\\\"\");process.exit(a<c&&c<b?0:1)'"
check "手机上的「筛选」和「⋯」按钮" "curl -s '$B/' | grep 'class=\"filter-btn\"' >/dev/null && curl -s '$B/p/notifproj/note-5' | grep 'more-btn' >/dev/null"
kill $SMTPD 2>/dev/null
# 网页推送：脚本扮演浏览器（订阅、解密）和推送服务（收请求、验签名）
cat > "$TMP/wp-test.mjs" <<'JS'
import crypto from 'node:crypto'; import http from 'node:http';
const [B, port] = process.argv.slice(2);
const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(b) }).then(r => r.json());
let got = null;
const srv = http.createServer((q, r) => { const ch = []; q.on('data', d => ch.push(d)); q.on('end', () => {
  if (q.url.includes('gone')) { r.statusCode = 410; return r.end(); }
  got = { headers: q.headers, body: Buffer.concat(ch) }; r.statusCode = 201; r.end(); }); }).listen(Number(port), '127.0.0.1');
const sub = path => ({ endpoint: `http://127.0.0.1:${port}/push/${path}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
const fail = m => { console.log('FAIL', m); process.exit(1); };
if (!(await post('/api/webpush/subscribe', { subscription: { endpoint: 'ftp://x', keys: {} } })).error) fail('accepted a bad subscription');
await post('/api/webpush/subscribe', { subscription: sub('ok') });
const n = (await post('/api/webpush/subscribe', { subscription: sub('gone') })).devices; if (n !== 2) fail('devices ' + n);
const t = await post('/api/notify-test', { type: 'webpush' });
if (!got) fail('nothing received ' + JSON.stringify(t));
if (got.headers['content-encoding'] !== 'aes128gcm') fail('encoding');
const [, jwt, k] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/) || [];
const { publicKey } = await (await fetch(B + '/api/webpush')).json(); if (k !== publicKey) fail('k');
const [h, p, sig] = jwt.split('.'); const pub = Buffer.from(k, 'base64url');
const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
if (!crypto.verify('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))) fail('jwt');
const b = got.body, salt = b.subarray(0, 16), asPub = b.subarray(21, 21 + b[20]), ct = b.subarray(21 + b[20]);
const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
d.setAuthTag(ct.subarray(-16)); const msg = JSON.parse(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).subarray(0, -1).toString());
if (msg.title !== 'mydash') fail('payload ' + JSON.stringify(msg));
const left = (await (await fetch(B + '/api/webpush')).json()).devices; if (left !== 1) fail('410 not removed: ' + left);
console.log('OK'); srv.close(); process.exit(0);
JS
check "网页推送：订阅、加密发送、签名都对，失效的订阅会删掉" "node '$TMP/wp-test.mjs' '$B' $((PORT+8)) | grep -x OK >/dev/null"
check "service worker 放在根路径，能管整个网站" "curl -sI '$B/sw.js' | grep -i 'service-worker-allowed: /' >/dev/null && curl -s '$B/sw.js' | grep 'showNotification' >/dev/null"
check "推送那一块可以收起，收起时写明开了哪些" "curl -s '$B/settings' | grep '<details class=\"set-sec set-fold\" id=\"set-push\">' >/dev/null && curl -s '$B/settings' | grep 'class=\"set-sum\">已开启：' | grep '网页推送' >/dev/null"
check "设置页有网页推送这一块，显示已订阅的设备" "curl -s '$B/settings' | grep 'class=\"set-ch set-wp\"' >/dev/null && curl -s '$B/settings' | grep '1 台设备' >/dev/null"
check "没开 HTTPS 时 tailnet 名字照常打开" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: smokebox' '$B/')\" = 200"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.httpsUrl="https://smokebox.tail0.ts.net";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "开了 HTTPS：用 tailnet 名字走 HTTP 打开网页，跳到 HTTPS 的同一页" "curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: smokebox' '$B/p/smoke?x=1' | grep -x '302 https://smokebox.tail0.ts.net/p/smoke?x=1' >/dev/null"
check "已经是 HTTPS 转发来的不再跳（不会来回跳）" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: smokebox' -H 'X-Forwarded-Proto: https' '$B/')\" = 200"
check "本机地址、/api/ 都不跳" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$B/')\" = 200 && test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: smokebox' '$B/api/webpush')\" = 200"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.httpsRedirect=false;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "httpsRedirect: false 可以关掉跳转" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: smokebox' '$B/')\" = 200"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));delete c.httpsUrl;delete c.httpsRedirect;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "HTTPS 用的内容端口（内容端口 + 1）也认" "curl -sf -H 'Host: 127.0.0.1:'$((CP+1)) '$CB/f/smoke/proto/v1/index.html' | grep -i '<html' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"autoArchiveDays":14,"bark":"","ntfy":"","daily":""}' "$B/api/settings" >/dev/null
$CLI notify off >/dev/null; kill $SINK 2>/dev/null
check "全文搜索：正文里的词" "curl -s \"$B/api/search?q=\$(node -e 'process.stdout.write(encodeURIComponent(\"批准新节点\"))')\" | grep 'approj/before-launch' >/dev/null"
check "全文搜索：找到发布过的正文" "curl -s \"$B/api/search?q=\$(node -e 'process.stdout.write(encodeURIComponent(\"背景说明\"))')\" | grep 'approj/go-live' >/dev/null"
check "全文搜索结果高亮" "curl -s \"$B/api/search?q=\$(node -e 'process.stdout.write(encodeURIComponent(\"背景说明\"))')\" | grep '<mark>' >/dev/null"
check "mydash search 命令" "$CLI search 背景说明 | grep 'approj/go-live' >/dev/null"
check "太短的词不搜" "test \"\$(curl -s '$B/api/search?q=a')\" = '[]'"

echo "终端里的提问"
# 这一段测「先在 mydash 答，终端等着」（hold）；默认的「两边同时问」在后面
export MYDASH_PROMPT_MODE=hold
PID1() { curl -s "$B/api/prompts" | node -e 'const j=JSON.parse(require("fs").readFileSync(0));process.stdout.write((j.prompts.at(-1)||{}).id||"")'; }
waitgone() { for i in 1 2 3 4 5 6 7 8; do kill -0 $1 2>/dev/null || return 0; sleep 1; done; }
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"sess-pr-1","cwd":"/x/prproj","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"午饭吃什么？","header":"午饭","multiSelect":false,"options":[{"label":"面","description":"牛肉面"},{"label":"饭","description":""}]},{"question":"喝什么？","header":"饮料","multiSelect":true,"options":[{"label":"茶","description":""},{"label":"咖啡","description":""}]}]}}' > "$TMP/pr-q.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-q.json" > "$TMP/pr-q.out" 2>&1 & AP1=$!
sleep 1; PQ=$(PID1)
check "终端的选择题到了 mydash，出现在等你处理" "test -n '$PQ' && curl -s '$B/' | grep 'href=\"/prompts/$PQ\"' >/dev/null"
check "答题页能打开：选项、说明、回终端答" "curl -s '$B/prompts/$PQ' | grep '牛肉面' >/dev/null && curl -s '$B/prompts/$PQ' | grep 'data-act=\"release\"' >/dev/null"
check "每道题都要答" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"answers\":{\"午饭吃什么？\":\"面\"}}' '$B/api/prompts/$PQ/answer')\" = 422"
POSTJ -H 'X-Mydash: 1' -d '{"answers":{"午饭吃什么？":"面","喝什么？":["茶","可乐"]}}' "$B/api/prompts/$PQ/answer" >/dev/null; waitgone $AP1
check "答完：钩子把答案交回 Claude Code（多选用逗号连起来）" "node -e 'const h=JSON.parse(require(\"fs\").readFileSync(process.argv[1])).hookSpecificOutput;process.exit(h.permissionDecision===\"allow\"&&h.updatedInput.answers[\"午饭吃什么？\"]===\"面\"&&h.updatedInput.answers[\"喝什么？\"]===\"茶, 可乐\"&&h.updatedInput.questions.length===2?0:1)' '$TMP/pr-q.out'"
check "答过的不能再答" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"answers\":{}}' '$B/api/prompts/$PQ/answer')\" = 409"
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"sess-pr-1","cwd":"/x/prproj","tool_name":"ExitPlanMode","tool_input":{"plan":"# 计划\n\n1. 改 A\n2. 改 B"}}' > "$TMP/pr-p.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-p.json" > "$TMP/pr-p.out" 2>&1 & AP2=$!; sleep 1; PP=$(PID1)
check "计划确认：答题页显示计划" "curl -s '$B/prompts/$PP' | grep '改 B' >/dev/null && curl -s '$B/prompts/$PP' | grep 'data-act=\"approve\"' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"approve":false,"feedback":"先别改 B"}' "$B/api/prompts/$PP/answer" >/dev/null; waitgone $AP2
check "计划要改：拒绝并带上要改什么" "grep '\"permissionDecision\":\"deny\"' '$TMP/pr-p.out' >/dev/null && grep '先别改 B' '$TMP/pr-p.out' >/dev/null"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"sess-pr-1","cwd":"/x/prproj","tool_name":"Bash","tool_input":{"command":"rm -rf build","description":"清掉构建目录"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -rf build"}],"behavior":"allow","destination":"localSettings"}]}' > "$TMP/pr-b.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-b.json" > "$TMP/pr-b.out" 2>&1 & AP3=$!; sleep 1; PB=$(PID1)
check "权限确认：页面上有命令和以后都允许" "curl -s '$B/prompts/$PB' | grep 'data-act=\"always\"' >/dev/null && curl -s '$B/prompts/$PB' | grep 'rm -rf build' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"decision":"always"}' "$B/api/prompts/$PB/answer" >/dev/null; waitgone $AP3
check "以后都允许：带上 Claude Code 建议的放行规则" "grep '\"behavior\":\"allow\"' '$TMP/pr-b.out' >/dev/null && grep 'updatedPermissions' '$TMP/pr-b.out' >/dev/null"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-q.json" > "$TMP/pr-r.out" 2>&1 & AP4=$!; sleep 1; PR=$(PID1)
POSTJ -H 'X-Mydash: 1' -d '{}' "$B/api/prompts/$PR/release" >/dev/null; waitgone $AP4
check "回终端答：钩子什么都不输出，终端照常问" "! kill -0 $AP4 2>/dev/null && test ! -s '$TMP/pr-r.out' && curl -s '$B/prompts/$PR' | grep 'pr-status pr-released' >/dev/null"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-q.json" > /dev/null 2>&1 & AP5=$!; sleep 1; PC=$(PID1); kill -TERM $AP5; sleep 1.5
check "终端那边取消了：mydash 上标成取消" "curl -s '$B/prompts/$PC' | grep 'pr-status pr-cancelled' >/dev/null"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"thr-1","cwd":"/x/prproj","tool_name":"Bash","tool_input":{"command":"touch x"}}' > "$TMP/pr-c.json"
node "$ROOT/bin/agent-ask.mjs" codex < "$TMP/pr-c.json" > "$TMP/pr-c.out" 2>&1 & AP6=$!; sleep 1; PX=$(PID1)
POSTJ -H 'X-Mydash: 1' -d '{"decision":"deny","message":"别动"}' "$B/api/prompts/$PX/answer" >/dev/null; waitgone $AP6
check "Codex 的命令审批：在 mydash 上拒绝" "grep '\"behavior\":\"deny\"' '$TMP/pr-c.out' >/dev/null && grep '别动' '$TMP/pr-c.out' >/dev/null"
# Codex（命令行和桌面版）的选择题 request_user_input：钩子没法填答案，就拦下这次调用、把答案写进理由
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"thr-2","cwd":"/x/prproj","tool_name":"request_user_input","tool_use_id":"call_1","tool_input":{"questions":[{"header":"饮品","id":"drink","question":"茶还是咖啡？","options":[{"label":"咖啡 (Recommended)","description":"提神"},{"label":"茶","description":""}]}]}}' > "$TMP/pr-cq.json"
node "$ROOT/bin/agent-ask.mjs" codex < "$TMP/pr-cq.json" > "$TMP/pr-cq.out" 2>&1 & AP10=$!; sleep 1; PCQ=$(PID1)
check "Codex 的选择题到了 mydash，页面上写「回 Codex 里答」" "curl -s '$B/prompts/$PCQ' | grep '茶还是咖啡' >/dev/null && curl -s '$B/prompts/$PCQ' | grep '回 Codex 里答' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"answers":{"茶还是咖啡？":"茶"}}' "$B/api/prompts/$PCQ/answer" >/dev/null; waitgone $AP10
check "Codex 的选择题答完：拦下这次调用，理由里带上答案" "node -e 'const h=JSON.parse(require(\"fs\").readFileSync(process.argv[1])).hookSpecificOutput;process.exit(h.permissionDecision===\"deny\"&&h.permissionDecisionReason.includes(\"茶还是咖啡？ (id: drink): 茶\")?0:1)' '$TMP/pr-cq.out'"
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"thr-2","cwd":"/x/prproj","tool_name":"request_user_input","tool_input":{"questions":[{"question":"q"}]}}' | node "$ROOT/bin/agent-ask.mjs" claude > "$TMP/pr-cq2.out" 2>&1
check "request_user_input 只认 Codex 的钩子" "test ! -s '$TMP/pr-cq2.out' && test -z \"\$(curl -s '$B/api/prompts' | node -e 'const j=JSON.parse(require(\"fs\").readFileSync(0));process.stdout.write(j.prompts.filter(p=>p.status===\"pending\").map(p=>p.id).join(\"\"))')\""
# 权限确认的对话框和钩子同时开着：用户在终端先答了，会话记录里出现这次调用的结果，钩子自己退出，mydash 上标成「在终端答了」
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_smoke1","name":"Bash","input":{"command":"touch x"}}]}}' > "$TMP/pr-tr.jsonl"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"sess-pr-2","cwd":"/x/prproj","tool_name":"Bash","tool_input":{"command":"touch x"},"transcript_path":"'"$TMP/pr-tr.jsonl"'"}' > "$TMP/pr-t.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-t.json" > "$TMP/pr-t.out" 2>&1 & AP9=$!; sleep 1; PT=$(PID1)
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_smoke1","content":"ok"}]}}' >> "$TMP/pr-tr.jsonl"; waitgone $AP9
check "终端先答了：钩子自己退出、不输出，mydash 上标成在终端答了" "! kill -0 $AP9 2>/dev/null && test ! -s '$TMP/pr-t.out' && curl -s '$B/prompts/$PT' | grep 'pr-status pr-terminal' >/dev/null"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"sess-pr-2","cwd":"/x/prproj","tool_name":"AskUserQuestion","tool_input":{"questions":[]}}' | node "$ROOT/bin/agent-ask.mjs" claude > "$TMP/pr-dup.out" 2>&1
check "选择题的权限那一步不再重复出一道题" "test ! -s '$TMP/pr-dup.out' && test -z \"\$(PID1)\""
$CLI ask "选哪个？" 甲 乙 --json > "$TMP/pr-ask.out" 2>/dev/null & AP7=$!; sleep 1.5; PA=$(PID1)
POSTJ -H 'X-Mydash: 1' -d '{"answers":{"选哪个？":"乙"}}' "$B/api/prompts/$PA/answer" >/dev/null; waitgone $AP7
check "mydash ask：别的工具也能问，答完拿到答案" "grep '\"answer\":\"乙\"' '$TMP/pr-ask.out' >/dev/null"
check "等你处理里不再有答完的题" "! curl -s '$B/' | grep 'href=\"/prompts/' >/dev/null"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.prompts={enabled:false};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-q.json" > "$TMP/pr-off.out" 2>&1 & AP8=$!; sleep 1
check "总开关关掉：钩子马上退出，终端照常问" "! kill -0 $AP8 2>/dev/null && test ! -s '$TMP/pr-off.out' && test -z \"\$(PID1)\""
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));delete c.prompts;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "设置页有终端提问的总开关" "curl -s '$B/settings' | grep 'name=\"promptsOn\"' >/dev/null"
unset MYDASH_PROMPT_MODE

echo "Claude Code：终端和 mydash 同时问（默认）"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/pr-q.json" > "$TMP/par-pre.out" 2>&1
check "选择题不再在 PreToolUse 拦下：钩子马上退出、不出题" "test ! -s '$TMP/par-pre.out' && test -z \"\$(PID1)\""
sed 's/"PreToolUse"/"PermissionRequest"/' "$TMP/pr-q.json" > "$TMP/par-q.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/par-q.json" > "$TMP/par-q.out" 2>&1 & AP11=$!; sleep 1; PQ2=$(PID1)
check "终端对话框开着的同时，mydash 上也出一份，页面写明两边都能答、没有交回按钮" "test -n '$PQ2' && curl -s '$B/prompts/$PQ2' | grep '那边也同时在问' >/dev/null && ! curl -s '$B/prompts/$PQ2' | grep 'data-act=\"release\"' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"answers":{"午饭吃什么？":"面","喝什么？":["茶"]}}' "$B/api/prompts/$PQ2/answer" >/dev/null; waitgone $AP11
check "在 mydash 答了：PermissionRequest 放行并带上答案，终端那边随之关掉" "node -e 'const h=JSON.parse(require(\"fs\").readFileSync(process.argv[1])).hookSpecificOutput;process.exit(h.hookEventName===\"PermissionRequest\"&&h.decision.behavior===\"allow\"&&h.decision.updatedInput.answers[\"午饭吃什么？\"]===\"面\"&&h.decision.updatedInput.questions.length===2?0:1)' '$TMP/par-q.out'"
sed 's/"PreToolUse"/"PermissionRequest"/' "$TMP/pr-p.json" > "$TMP/par-p.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/par-p.json" > "$TMP/par-p.out" 2>&1 & AP12=$!; sleep 1; PP2=$(PID1)
POSTJ -H 'X-Mydash: 1' -d '{"approve":true}' "$B/api/prompts/$PP2/answer" >/dev/null; waitgone $AP12
check "计划在 mydash 批准：放行并带上原计划（不带的话 Claude Code 不认）" "node -e 'const h=JSON.parse(require(\"fs\").readFileSync(process.argv[1])).hookSpecificOutput;process.exit(h.decision.behavior===\"allow\"&&/改 B/.test(h.decision.updatedInput.plan)?0:1)' '$TMP/par-p.out'"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.prompts={mode:"hold"};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$TMP/par-q.json" > "$TMP/par-hold.out" 2>&1
check "设置里切回「先在这里答」：权限那一步不再出题" "test ! -s '$TMP/par-hold.out' && test -z \"\$(PID1)\""
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));delete c.prompts;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "设置页能选两种问法" "curl -s '$B/settings' | grep 'name=\"promptsMode\"' >/dev/null"

echo "Codex：软件里先问，mydash 只提醒（默认）"
printf '%s\n' '{"type":"session_meta","payload":{"cwd":"/x/prproj"}}' > "$TMP/cx-roll.jsonl"
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"thr-3","cwd":"/x/prproj","tool_name":"request_user_input","tool_use_id":"call_app1","transcript_path":"'"$TMP/cx-roll.jsonl"'","tool_input":{"questions":[{"id":"d","question":"选哪条路？","options":[{"label":"甲","description":""},{"label":"乙","description":""}]}]}}' > "$TMP/cx-app.json"
node "$ROOT/bin/agent-ask.mjs" codex < "$TMP/cx-app.json" > "$TMP/cx-app.out" 2>&1; sleep 1; PCA=$(PID1)
check "钩子马上退出、不输出（Codex 照常在软件里弹出），mydash 上记一份" "test ! -s '$TMP/cx-app.out' && test -n '$PCA'"
check "这份只能看：页面写明到 Codex 里答，选项不能点，也不能从这里提交" "curl -s '$B/prompts/$PCA' | grep 'pr-app' >/dev/null && curl -s '$B/prompts/$PCA' | grep 'disabled' >/dev/null && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"answers\":{\"选哪条路？\":\"甲\"}}' '$B/api/prompts/$PCA/answer')\" = 409"
sleep 50
check "后台小进程一直在问着，过了 45 秒也不会被当成没人等" "curl -s '$B/api/prompts' | grep '$PCA' >/dev/null"
printf '%s\n' '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_app1","output":"甲"}}' >> "$TMP/cx-roll.jsonl"; sleep 4
check "在 Codex 里答了：mydash 那份自己关掉（标成在 Codex 里答了）" "curl -s '$B/prompts/$PCA' | grep 'pr-status pr-terminal' >/dev/null && ! pgrep -f 'agent-ask.mjs watch $PCA' >/dev/null"
node "$ROOT/bin/agent-ask.mjs" codex < "$TMP/cx-app.json" > /dev/null 2>&1; sleep 1; PCB=$(PID1)
printf '%s\n' '{"type":"event_msg","payload":{"type":"turn_aborted"}}' >> "$TMP/cx-roll.jsonl"; sleep 4
check "这一轮被打断了：mydash 那份也关掉" "curl -s '$B/prompts/$PCB' | grep 'pr-status pr-terminal' >/dev/null"
check "设置页能选 Codex 的问法" "curl -s '$B/settings' | grep 'name=\"promptsCodex\"' >/dev/null"

echo "跨机器发布"
TOKEN=$($CLI remote token --name testbox --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).token)')
check "生成令牌" "echo '$TOKEN' | grep '^md_' >/dev/null"
check "令牌列表里有名字（不显示令牌本身）" "$CLI remote tokens --json | grep testbox >/dev/null && ! $CLI remote tokens --json | grep '$TOKEN' >/dev/null"
check "没带令牌被拒" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$B/api/remote/ping')\" = 401"
check "错误令牌被拒" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer md_wrongwrongwrongwrongwrong' '$B/api/remote/ping')\" = 401"
CH2="$TMP/client-home"; mkdir -p "$CH2"; RC="env -u MYDASH_DATA -u MYDASH_PORT -u MYDASH_BASE_URL MYDASH_HOME=$CH2 $CLI"
check "setup install --remote 令牌不对时报错且不安装" "! env -u MYDASH_DATA MYDASH_HOME=$CH2 node '$ROOT/bin/mydash.mjs' setup install --remote '$B' --token md_wrongwrongwrongwrongwrong --json >/dev/null 2>&1 && test ! -d '$CH2/app'"
check "remote set 连上" "$RC remote set '$B' --token '$TOKEN' --machine 云服务器 | grep '已连上' >/dev/null"
RD="$TMP/remote-src"; mkdir -p "$RD"; cp "$TMP/fx/report.pdf" "$RD/"; printf '# 远程方案\n\n第一版\n' > "$RD/plan.md"
R1=$(cd "$RD" && $RC publish plan.md report.pdf -p rproj -s remote-plan --json)
check "从别的机器发布成功" "echo \"\$R1\" | grep '\"ok\":true' >/dev/null && test -f '$MYDASH_DATA/rproj/remote-plan/v1/report.pdf'"
check "第一次两个文件都上传" "echo \"\$R1\" | grep '\"uploaded\":2' >/dev/null"
printf '# 远程方案\n\n第二版\n' > "$RD/plan.md"
R2=$(cd "$RD" && $RC publish plan.md report.pdf -p rproj -s remote-plan --json)
check "第二次只传改了的文件" "echo \"\$R2\" | grep '\"uploaded\":1' >/dev/null && echo \"\$R2\" | grep '\"version\":2' >/dev/null"
check "没传的文件在服务端也是链接" "test -s '$MYDASH_DATA/rproj/remote-plan/v2/report.pdf'"
check "记下是哪台机器发的" "grep '\"host\": \"云服务器\"' '$MYDASH_DATA/rproj/remote-plan/meta.json' >/dev/null"
printf '# 远程来的待办\n\n- [ ] 一件 <!-- check: touch "%s/ran-remote" -->\n' "$TMP" > "$RD/td.md"
(cd "$RD" && $RC publish td.md -p rproj -s remote-todo --type todo >/dev/null)
curl -s "$B/p/rproj/remote-todo" >/dev/null; sleep 2; $CLI todos check rproj/remote-todo >/dev/null
check "别的机器传来的待办：检测命令一律不跑" "grep '\"remote\": true' '$MYDASH_DATA/rproj/remote-todo/meta.json' >/dev/null && test ! -e '$TMP/ran-remote'"
check "网页上标出机器名" "curl -s '$B/p/rproj' | grep 'class=\"host-tag\"' | grep '云服务器' >/dev/null"
check "远程 ls" "$RC ls rproj | grep 'rproj/remote-plan' >/dev/null"
POSTJ -H 'X-Mydash: 1' -d '{"id":"rproj/remote-plan","v":2,"text":"远程能看到这条吗"}' "$B/api/comment" >/dev/null
RF=$(cd "$RD" && $RC feedback rproj --json)
check "远程 feedback 读到这边的批注" "echo \"\$RF\" | grep '远程能看到这条吗' >/dev/null"
RCID=$(echo "$RF" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).open[0].id)')
$RC feedback done "$RCID" >/dev/null
check "远程 feedback done 标记已处理" "grep '\"status\": \"resolved\"' '$MYDASH_DATA/rproj/remote-plan/responses.json' >/dev/null"
check "远程 doctor" "$RC doctor | grep '✓ remote' >/dev/null"
check "remote off 改回本机" "$RC remote off >/dev/null && ! grep remote '$CH2/config.json' >/dev/null"
$CLI remote revoke testbox >/dev/null
check "作废令牌后不能再用" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $TOKEN' '$B/api/remote/ping')\" = 401"

echo "防误发密钥"
SEC="$TMP/sec"; mkdir -p "$SEC/dir"
printf 'API_KEY=abc\n' > "$SEC/.env"; printf 'API_KEY=\n' > "$SEC/.env.example"
printf '# 配置\n\nkey: sk-ant-api03-%s\n' "$(printf 'x%.0s' $(seq 1 90))" > "$SEC/leak.md"
printf '# 正常\n\n看 [密钥](id_ed25519)\n' > "$SEC/dir/readme.md"; printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' > "$SEC/dir/id_ed25519"
check "拒绝发布 .env" "! $CLI publish '$SEC/.env' -p sec -s envfile >/dev/null 2>&1 && test ! -d '$MYDASH_DATA/sec/envfile'"
check "拒绝发布含 API key 的 md" "! $CLI publish '$SEC/leak.md' -p sec -s leak >/dev/null 2>&1"
check "md 引用的私钥也会被拦下" "! $CLI publish '$SEC/dir/readme.md' -p sec -s refkey >/dev/null 2>&1"
check "拒绝时说明是哪个文件" "{ $CLI publish '$SEC/leak.md' -p sec -s leak 2>&1 || true; } | grep 'leak.md' >/dev/null"
check ".env.example 可以发" "$CLI publish '$SEC/.env.example' -p sec -s envexample >/dev/null 2>&1"
check "--allow-secret 可以强制" "$CLI publish '$SEC/leak.md' -p sec -s leak --allow-secret >/dev/null 2>&1 && test -d '$MYDASH_DATA/sec/leak'"

echo "接入 Claude Code / Codex（可撤销）"
CH="$MYDASH_CLAUDE_HOME"; XH="$MYDASH_CODEX_HOME"
# 更新时的刷新（lib/integrate.mjs 的 refresh），以及 doctor 里某一项的结果（ok / bad / none）
refreshj() { node -e 'import(process.argv[1]).then(m=>process.stdout.write(JSON.stringify(m.refresh(process.argv[2]))))' "$ROOT/lib/integrate.mjs" "$1"; }
hookchk() { $CLI doctor --json 2>/dev/null | node -e 'const c=JSON.parse(require("fs").readFileSync(0)).checks.find(x=>x.id===process.argv[1]);process.stdout.write(c?(c.ok?"ok":"bad"):"none")' "$1"; }
printf '# 我的规则\n\n- 用中文\n' > "$CH/CLAUDE.md"; cp "$CH/CLAUDE.md" "$TMP/claude-orig.md"
printf '{\n  "permissions": { "allow": ["Bash(ls:*)"] },\n  "theme": "dark"\n}\n' > "$CH/settings.json"
DRY=$($CLI integrate claude --dry-run)
check "dry-run 不改文件" "cmp -s '$CH/CLAUDE.md' '$TMP/claude-orig.md' && test ! -e '$CH/skills/mydash'"
check "dry-run 列出要改的文件" "echo \"\$DRY\" | grep 'CLAUDE.md' >/dev/null"
$CLI integrate claude >/dev/null; $CLI integrate claude >/dev/null
check "规则包在标记块里：发布一段、拍板和待办一段，重复运行不重复加" "grep -c 'mydash:begin' '$CH/CLAUDE.md' | grep -qx 1 && grep -c 'mydash:decide:begin' '$CH/CLAUDE.md' | grep -qx 1 && grep 'AskUserQuestion' '$CH/CLAUDE.md' >/dev/null"
check "默认就装上钩子和全部放行" "grep 'agent-ask.mjs' '$CH/settings.json' >/dev/null && node -e 'const a=require(\"$CH/settings.json\").permissions.allow;process.exit(a.includes(\"Bash(mydash ask:*)\")&&a.includes(\"Bash(mydash approvals:*)\")?0:1)'"
check "原有内容保留" "grep '用中文' '$CH/CLAUDE.md' >/dev/null"
check "skill 链接到安装目录" "test -L '$CH/skills/mydash'"
check "权限加进 settings.json 且保留原有项" "node -e 'const j=require(\"$CH/settings.json\");process.exit(j.permissions.allow.includes(\"Bash(mydash publish:*)\")&&j.permissions.allow.includes(\"Bash(ls:*)\")&&j.theme===\"dark\"?0:1)'"
$CLI integrate claude --remove >/dev/null
check "撤销后 CLAUDE.md 恢复原样（两段都删掉）" "cmp -s '$CH/CLAUDE.md' '$TMP/claude-orig.md'"
check "撤销后钩子也没了" "! grep 'agent-' '$CH/settings.json' >/dev/null"
check "撤销后只删自己加的权限" "node -e 'const j=require(\"$CH/settings.json\");process.exit(!j.permissions.allow.some(p=>p.includes(\"mydash\"))&&j.permissions.allow.includes(\"Bash(ls:*)\")?0:1)'"
check "撤销后 skill 链接没了" "test ! -e '$CH/skills/mydash'"
printf '# 已有规则\n用 mydash publish 发布\n' > "$CH/CLAUDE.md"; $CLI integrate claude >/dev/null
check "自己写过 mydash 发布规则时不重复加，拍板那段照加" "! grep 'mydash:begin' '$CH/CLAUDE.md' >/dev/null && grep 'mydash:decide:begin' '$CH/CLAUDE.md' >/dev/null"
printf '# 已有规则\n用 mydash publish 发布\n要我选就用 mydash approvals 审批单\n' > "$CH/CLAUDE.md"; $CLI integrate claude >/dev/null
check "两段都自己写过：一段都不加" "! grep 'mydash:' '$CH/CLAUDE.md' >/dev/null"
node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f));j.hooks={Stop:[{hooks:[{type:"command",command:"other-tool stop"}]}]};fs.writeFileSync(f,JSON.stringify(j,null,2))' "$CH/settings.json"
$CLI integrate claude --no-hooks >/dev/null
check "--no-hooks：不装钩子，别人的钩子保留，doctor 不再催" "! grep 'agent-' '$CH/settings.json' >/dev/null && grep 'other-tool stop' '$CH/settings.json' >/dev/null && $CLI integrate claude --no-hooks --dry-run | grep -v add-hooks >/dev/null && node -e 'import(process.argv[1]).then(m=>process.exit(m.status(\"claude\").hooks===\"off\"?0:1))' '$ROOT/lib/integrate.mjs'"
$CLI integrate claude >/dev/null; $CLI integrate claude --hooks >/dev/null
check "--hooks 也接上选择题、计划确认、权限确认" "node -e 'const h=require(\"$CH/settings.json\").hooks;process.exit(h.PreToolUse.some(g=>g.matcher===\"AskUserQuestion|ExitPlanMode\"&&/agent-ask/.test(g.hooks[0].command)&&g.hooks[0].timeout>=86400)&&h.PermissionRequest.some(g=>/agent-ask/.test(g.hooks[0].command))?0:1)'"
check "--hooks 装上忙闲钩子，别人的钩子保留，重复运行不重复加" "node -e 'const h=require(\"$CH/settings.json\").hooks;const ours=g=>g.hooks.some(x=>/agent-state/.test(x.command));process.exit(h.Stop.length===2&&h.Stop.filter(ours).length===1&&h.Stop.some(g=>g.hooks[0].command===\"other-tool stop\")&&h.UserPromptSubmit.filter(ours).length===1?0:1)'"
check "--hooks 顺带放行 approvals / todos，免得在后台等答复时卡在权限确认" "node -e 'const a=require(\"$CH/settings.json\").permissions.allow;process.exit(a.includes(\"Bash(mydash approvals:*)\")&&a.includes(\"Bash(mydash todos:*)\")?0:1)'"
check "钩子命令能跑：新会话只提醒一次规则，之后什么都不输出" "echo '{\"session_id\":\"smoke-hook-1\"}' | node '$ROOT/bin/agent-state.mjs' busy | grep AskUserQuestion >/dev/null && test -z \"\$(echo '{\"session_id\":\"smoke-hook-1\"}' | node '$ROOT/bin/agent-state.mjs' busy)\" && grep '\"busy\"' '$MYDASH_HOME/state/agents/smoke-hook-1.json' >/dev/null"
# 回复末尾用文字问用户：拦一次，让它改用选择题（文字里的问题到不了 mydash）
stopq() { printf '%s' "{\"session_id\":\"$1\",\"stop_hook_active\":$2,\"last_assistant_message\":\"$3\"}" | node "$ROOT/bin/agent-state.mjs" idle ${4:-}; }
check "回复末尾用文字问：让它接着用 AskUserQuestion 再问（Claude 用 additionalContext，不显示成错误），状态还算忙" "stopq smoke-stop-1 false '做好了。要不要我接着把 B 也改了？' | grep '\"hookEventName\":\"Stop\"' | grep AskUserQuestion >/dev/null && grep '\"busy\"' '$MYDASH_HOME/state/agents/smoke-stop-1.json' >/dev/null"
check "已经拦过一次（stop_hook_active）就不再拦，记成闲" "test -z \"\$(stopq smoke-stop-1 true '要不要？')\" && grep '\"idle\"' '$MYDASH_HOME/state/agents/smoke-stop-1.json' >/dev/null"
check "没有问题、问号只在代码和网址里：不拦" "test -z \"\$(stopq smoke-stop-2 false '见 https://x.y/a?b=1 和 \`a?b\`，做完了。')\""
check "Codex：拦下（decision: block），让它用 request_user_input 或 mydash ask" "stopq smoke-stop-3 false '用哪个？' codex | grep '\"decision\":\"block\"' | grep 'mydash ask' >/dev/null"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.prompts={chat:false};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "设置里关掉就不拦" "test -z \"\$(stopq smoke-stop-4 false '要不要？')\""
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));delete c.prompts;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$MYDASH_HOME/config.json"
check "doctor：钩子指向的脚本不在了，会报出来" "test \"\$(hookchk hooks-claude)\" = bad"
# 真实安装里钩子指向 ~/.mydash/app/bin 下的脚本；这里只有源码，放两个空文件代替
mkdir -p "$MYDASH_HOME/app/bin" && touch "$MYDASH_HOME/app/bin/agent-state.mjs" "$MYDASH_HOME/app/bin/agent-ask.mjs"
check "doctor：装过钩子才查，齐了就是好的" "test \"\$(hookchk hooks-claude)\" = ok"
# 模拟老版本装的：少一个钩子、少一条放行，更新（setup install 里的 refresh）时补上
node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f));delete j.hooks.PermissionRequest;j.permissions.allow=j.permissions.allow.filter(x=>x!=="Bash(mydash ask:*)");fs.writeFileSync(f,JSON.stringify(j,null,2))' "$CH/settings.json"
node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f));s.claude.hookIds=s.claude.hookIds.filter(x=>x!=="PermissionRequest");s.claude.permissionsAdded=s.claude.permissionsAdded.filter(x=>x!=="Bash(mydash ask:*)");fs.writeFileSync(f,JSON.stringify(s,null,2))' "$MYDASH_HOME/state/integrations.json"
check "doctor：缺了钩子会报出来" "test \"\$(hookchk hooks-claude)\" = bad"
refreshj claude > "$TMP/refresh-c.json"
check "更新时补上新钩子和新放行，别人的钩子不动" "node -e 'const j=require(\"$CH/settings.json\");process.exit(j.hooks.PermissionRequest.some(g=>/agent-ask/.test(g.hooks[0].command))&&j.permissions.allow.includes(\"Bash(mydash ask:*)\")&&j.hooks.Stop.some(g=>g.hooks[0].command===\"other-tool stop\")?0:1)' && test \"\$(hookchk hooks-claude)\" = ok"
check "已经是最新的就什么都不改" "test \"\$(refreshj claude)\" = '{\"changes\":[],\"codexTrust\":false}'"
# 用户自己删掉的钩子和放行：更新时不加回来，doctor 也不算缺
node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f));delete j.hooks.PermissionRequest;j.permissions.allow=j.permissions.allow.filter(x=>x!=="Bash(mydash ask:*)");fs.writeFileSync(f,JSON.stringify(j,null,2))' "$CH/settings.json"
check "用户自己删掉的钩子和放行，更新时不加回来" "refreshj claude >/dev/null; node -e 'const j=require(\"$CH/settings.json\");process.exit(!j.hooks.PermissionRequest&&!j.permissions.allow.includes(\"Bash(mydash ask:*)\")?0:1)' && test \"\$(hookchk hooks-claude)\" = ok"
$CLI integrate claude --remove >/dev/null
check "撤销后钩子只删自己的" "node -e 'const h=require(\"$CH/settings.json\").hooks;process.exit(!h.UserPromptSubmit&&h.Stop.length===1&&h.Stop[0].hooks[0].command===\"other-tool stop\"?0:1)'"
mkdir -p "$TMP/ch2"; MYDASH_CLAUDE_HOME="$TMP/ch2" $CLI integrate claude >/dev/null
check "原来没有 settings.json：接入时新建" "test -e '$TMP/ch2/settings.json' && test -e '$TMP/ch2/CLAUDE.md'"
MYDASH_CLAUDE_HOME="$TMP/ch2" $CLI integrate claude --remove >/dev/null
check "撤销后我们新建的 settings.json、CLAUDE.md 和空的 skills 文件夹都删掉" "test -z \"\$(ls -A '$TMP/ch2')\""
$CLI integrate codex --hooks >/dev/null; $CLI integrate codex --hooks >/dev/null
check "Codex：命令审批的钩子写进 hooks.json，不重复" "node -e 'const h=require(\"$XH/hooks.json\").hooks;process.exit(h.PermissionRequest.length===1&&/agent-ask\\.mjs\"? codex$/.test(h.PermissionRequest[0].hooks[0].command)?0:1)'"
check "Codex：选择题的钩子也写进去（命令行版的 request_user_input、桌面版的 request_user_input_async）" "node -e 'const h=require(\"$XH/hooks.json\").hooks;const m=new RegExp(h.PreToolUse[0].matcher);process.exit(h.PreToolUse.length===1&&m.test(\"request_user_input\")&&m.test(\"request_user_input_async\")&&!m.test(\"request_user_input_x\")&&/agent-ask\\.mjs\"? codex$/.test(h.PreToolUse[0].hooks[0].command)?0:1)'"
check "Codex：装钩子时提醒要在 Codex 里信任" "rm -f '$XH/hooks.json'; $CLI integrate codex --hooks | grep '/hooks' >/dev/null"
check "doctor：Codex 里还没信任，会报出来" "test \"\$(hookchk hooks-codex)\" = bad"
# Codex 记信任时用的是规整过的绝对路径（临时目录可能带 //）
XHJ=$(node -p 'require("path").join(process.argv[1],"hooks.json")' "$XH")
for ev in user_prompt_submit stop pre_tool_use permission_request; do printf '[hooks.state."%s:%s:0:0"]\ntrusted_hash = "x"\n\n' "$XHJ" "$ev"; done > "$XH/config.toml"
check "doctor：四条都信任了就是好的" "test \"\$(hookchk hooks-codex)\" = ok"
node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f));delete j.hooks.PreToolUse;fs.writeFileSync(f,JSON.stringify(j,null,2))' "$XH/hooks.json"
node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f));s.codex.hookIds=s.codex.hookIds.filter(x=>x!=="PreToolUse");fs.writeFileSync(f,JSON.stringify(s,null,2))' "$MYDASH_HOME/state/integrations.json"
check "Codex：更新时补上新加的选择题钩子，并提醒重新信任" "refreshj codex | grep '\"codexTrust\":true' >/dev/null && node -e 'process.exit(require(\"$XH/hooks.json\").hooks.PreToolUse?0:1)'"
check "Codex：--hooks 时 mydash ask 等也能从沙盒里连出来" "grep 'prefix_rule(pattern=\\[\"mydash\", \\[\"ask\"' '$XH/rules/mydash-ask.rules' >/dev/null"
if command -v codex >/dev/null; then check "Codex 认得 ask 的放行规则" "codex execpolicy check --rules '$XH/rules/mydash-ask.rules' mydash ask hi | grep '\"decision\":\"allow\"' >/dev/null"; fi
check "Codex 规则写进 AGENTS.md" "grep 'mydash:begin' '$XH/AGENTS.md' >/dev/null"
check "Codex 沙盒放行规则" "grep 'prefix_rule(pattern=\[\"mydash\", \"publish\"\]' '$XH/rules/mydash.rules' >/dev/null"
if command -v codex >/dev/null; then check "Codex 认得这份规则" "codex execpolicy check --rules '$XH/rules/mydash.rules' mydash publish a.md | grep '\"decision\":\"allow\"' >/dev/null"; fi
$CLI integrate codex --remove >/dev/null
check "Codex 撤销干净" "test ! -e '$XH/rules/mydash.rules' && test ! -e '$XH/rules/mydash-ask.rules' && ! grep mydash '$XH/AGENTS.md' >/dev/null 2>&1 && ! grep agent-ask '$XH/hooks.json' >/dev/null 2>&1"
check "Codex：hooks.json 是我们建的，撤销时整个删掉" "test ! -e '$XH/hooks.json'"
check "撤销后空了的 skills、rules 文件夹也删掉" "test ! -e '$XH/rules' && test ! -e '$XH/skills'"
check "撤销以后不会被更新又加回来" "test \"\$(refreshj codex)\" = '{\"changes\":[],\"codexTrust\":false}' && test ! -e '$XH/hooks.json'"

if [ "$(uname)" = Darwin ]; then
echo "开机就启动（launchd-boot）"
BH="$TMP/boot-home"; mkdir -p "$BH"
MYDASH_HOME="$BH" node -e 'import(process.argv[1]).then(async m=>{const r=await m.installService("server",[process.execPath,"/x/server.mjs"],{MYDASH_HOME:process.argv[2]},"launchd-boot");process.stdout.write(JSON.stringify(r))})' "$ROOT/lib/service.mjs" "$BH" > "$TMP/boot.json"
BP=$(ls "$BH"/state/boot/*.plist 2>/dev/null | head -1)
check "要装进系统的服务先放好：格式对、以本人身份运行、不是 root" "grep '\"needsRoot\":true' '$TMP/boot.json' >/dev/null && plutil -lint '$BP' >/dev/null && grep \"<key>UserName</key><string>\$(id -un)</string>\" '$BP' >/dev/null && ! grep '<string>root</string>' '$BP' >/dev/null"
check "不用 sudo 跑 service boot：说清楚要管理员权限，什么都不改" "! $CLI service boot >/dev/null 2>&1 && { $CLI service boot 2>&1 || true; } | grep 'needs root' >/dev/null"
fi

echo "代码审查修复（2026-10-29）"
RV="$TMP/rv"; mkdir -p "$RV"
fmode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
loc() { curl -s -D - -o /dev/null "$1" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}'; }
pstatus() { node -e 'const j=require(process.argv[1]);const items=Array.isArray(j)?j:j.items;const p=items.find(x=>x.id===process.argv[2]);process.stdout.write(p?p.status:"none")' "$MYDASH_HOME/state/prompts.json" "$1"; }
# --- 页面安全 ---
cat > "$RV/xss.md" <<'EOF'
# 脚本测试

<script>window.__x=1</script>
<img src="x.png" onerror="window.__x=2">
<base href="https://evil.example/">

[点我](javascript:alert(1)) 和 <a href='javascript:alert(2)'>二</a>
EOF
(cd "$RV" && $CLI publish xss.md -p revproj -s xss >/dev/null)
curl -s "$B/p/revproj/xss" > "$RV/xss.html"
check "Markdown 里的 <script>、<base> 原样显示成文字，javascript: 链接换成 #" "! grep -q '<script>window.__x' '$RV/xss.html' && ! grep -q '<base href' '$RV/xss.html' && ! grep -qi 'javascript:' '$RV/xss.html' && grep -q '&lt;script&gt;' '$RV/xss.html'"
check "工作台页面带 CSP：只放行本站脚本，不能被别的页面嵌进去" "curl -sI '$B/p/revproj/xss' | grep -i '^content-security-policy' | grep \"script-src 'self' 'sha256-\" | grep -q \"frame-ancestors 'self'\""
csp_ok() { curl -s "$1" > "$RV/page.html"; curl -sI "$1" | grep -i '^content-security-policy' > "$RV/page.csp"; node -e '
const fs=require("fs"),c=require("crypto");const html=fs.readFileSync(process.argv[1],"utf8"),csp=fs.readFileSync(process.argv[2],"utf8");
const inl=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
process.exit(inl.length&&inl.every(s=>csp.includes("sha256-"+c.createHash("sha256").update(s).digest("base64")))?0:1)' "$RV/page.html" "$RV/page.csp"; }
check "页面里的内联脚本都在 CSP 的放行哈希里（首屏配色照常）" "csp_ok '$B/' && csp_ok '$B/settings'"
check "网址里用 %2F 拼出来的路径段一律不认" "test \"\$(curl -s -o /dev/null -w '%{http_code}' '$B/f/revproj/xss/v1/x%2F..%2Fxss.md')\" = 400 && test \"\$(curl -s -o /dev/null -w '%{http_code}' '$B/p/revproj%2F..%2Fsmoke/x')\" = 400"
check "登录后只跳本站：/\\evil、带 Tab 的都改回首页" "test \"\$(loc '$B/login?next=/%5Cevil.example')\" = / && test \"\$(loc '$B/login?next=/%09/evil.example')\" = / && test \"\$(loc '$B/login?next=/p/smoke')\" = /p/smoke"
node -e 'process.stdout.write(JSON.stringify({tool:"claude",kind:"plan",session:"",cwd:"/x/revproj",payload:{plan:"计划".repeat(9000)}}))' > "$RV/big.json"
BIGID=$(POSTB -H 'X-Mydash: 1' --data-binary @"$RV/big.json" "$B/api/prompts" | node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0)).id||"")}catch{}')
check "长计划（50 KB）也能交给 mydash" "test -n '$BIGID'"
[ -n "$BIGID" ] && POSTJ -H 'X-Mydash: 1' -d '{}' "$B/api/prompts/$BIGID/cancel" >/dev/null
check "分类名写成 __proto__、toString 这类不会查出怪东西（远程发布不经过命令行的检查）" "node -e 'import(process.argv[1]).then(c=>process.exit(c.normCategory(\"__proto__\")===null&&c.normCategory(\"toString\")===null&&c.normCategory(\"待办\")===\"todo\"?0:1))' '$ROOT/lib/categories.mjs'"
chmod 000 "$MYDASH_DATA/revproj/xss/v1/xss.md"; curl -s -o /dev/null "$B/f/revproj/xss/v1/xss.md"; chmod 644 "$MYDASH_DATA/revproj/xss/v1/xss.md"
check "发布的文件读不了时只这一个请求失败，服务不崩" "curl -sf '$B/healthz' >/dev/null"
# 删掉读过的版本、再用同一个版本号重发：算新的
(cd "$RV" && printf '# 已读\n\n一\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null && printf '# 已读\n\n二\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null)
POSTJ -H 'X-Mydash: 1' -d '{"id":"revproj/rs","v":2}' "$B/api/read" >/dev/null; sleep 1.1
$CLI rm revproj/rs --version 2 >/dev/null; (cd "$RV" && printf '# 已读\n\n三\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null); sleep 1.2
check "读过的版本删了又用同一个号重发：显示成没读" "curl -s '$B/p/revproj' | grep -E 'class=\"entry unread[^\"]*\" data-id=\"revproj/rs\"' >/dev/null"
# 远程上传：文件和目录同名不会让服务崩；主文件必须是传上来的文件之一
RT=$($CLI remote token --name rvbox --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).token)')
RS='{"project":"revproj","slug":"up","main":"zzz.md","files":[{"path":"a/b","sha1":"11f6ad8ec52a2984abaafd7c3b516503785c2072","size":1},{"path":"a","sha1":"11f6ad8ec52a2984abaafd7c3b516503785c2072","size":1}]}'
UPID=$(POSTB -H "Authorization: Bearer $RT" -d "$RS" "$B/api/remote/start" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).uploadId||"")')
curl -s -X PUT -H "Authorization: Bearer $RT" -H 'Content-Type: application/octet-stream' --data-binary x "$B/api/remote/$UPID/file?path=a%2Fb" >/dev/null
check "远程上传：先传 a/b 再传 a，只报错，服务不崩" "test \"\$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Authorization: Bearer $RT' -H 'Content-Type: application/octet-stream' --data-binary x '$B/api/remote/$UPID/file?path=a')\" = 400 && curl -sf '$B/healthz' >/dev/null"
check "远程发布：主文件不在传上来的文件里，拒绝" "test \"\$(POSTJ -H 'Authorization: Bearer $RT' -d '{}' '$B/api/remote/$UPID/finish')\" = 400"
$CLI remote revoke rvbox >/dev/null 2>&1
# --- 锁 ---
lock_dead() { printf '999999 %s x' "$(hostname)" > "$MYDASH_DATA/revproj/rs/.lock"; local t0=$(date +%s); (cd "$RV" && printf '# 已读\n\n四\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null) && test $(( $(date +%s) - t0 )) -lt 8; }
check "上次发布的进程已经没了、锁还在：马上接手，不用等一分钟" "lock_dead"
lock_live() { sleep 30 & local lp=$!; printf '%s %s x' "$lp" "$(hostname)" > "$MYDASH_DATA/revproj/rs/.lock"; local code; code=$(POSTJ -H 'X-Mydash: 1' -d '{"id":"revproj/rs","v":4,"text":"发布中也能批注"}' "$B/api/comment"); rm -rf "$MYDASH_DATA/revproj/rs/.lock"; kill $lp 2>/dev/null; test "$code" = 200; }
check "正在发布（持着条目锁）时，批注、勾待办、交审批照常" "lock_live"
check "持锁的人还活着就不抢：另一次发布等着（不会两份同时写）" "printf '%s %s x' \"\$\$\" \"\$(hostname)\" > '$MYDASH_DATA/revproj/rs/.lock' && (cd '$RV' && node -e 'import(process.argv[1]).then(async s=>{const t0=Date.now();const p=s.withLock(process.argv[2],async()=>1,{waitMs:1500}).then(()=>1,()=>0);process.exit((await p)===0&&Date.now()-t0>=1400?0:1)})' '$ROOT/lib/store.mjs' '$MYDASH_DATA/revproj/rs'); r=\$?; rm -rf '$MYDASH_DATA/revproj/rs/.lock'; test \$r = 0"
check "老版本留下的锁目录：过期了照样接手" "mkdir -p '$MYDASH_DATA/revproj/rs/.lock' && touch -t 202001010000 '$MYDASH_DATA/revproj/rs/.lock' && (cd '$RV' && printf '# 已读\n\n六\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null) && test ! -e '$MYDASH_DATA/revproj/rs/.lock'"
check "发布崩溃留下的 .tmp-v* 目录下次发布时清掉" "mkdir -p '$MYDASH_DATA/revproj/rs/.tmp-v9-12345' && (cd '$RV' && printf '# 已读\n\n五\n' > rs.md && $CLI publish rs.md -p revproj -s rs >/dev/null) && test ! -e '$MYDASH_DATA/revproj/rs/.tmp-v9-12345'"
# --- 待办自动检测只认明确的待办 ---
printf '# Release checklist\n\n- [ ] 第一步 <!-- check: touch "%s/ran-guess" -->\n' "$TMP" > "$RV/guess.md"
printf '# 要你做的\n\n- [ ] 第一步 <!-- check: touch "%s/ran-flag" -->\n' "$TMP" > "$RV/flag.md"
printf '# 方案\n\n```todo\n- [ ] 块里的 <!-- check: touch "%s/ran-block" -->\n```\n' "$TMP" > "$RV/block.md"
(cd "$RV" && $CLI publish guess.md -p revproj -s guess-todo >/dev/null && $CLI publish flag.md -p revproj -s flag-todo --type todo >/dev/null && $CLI publish block.md -p revproj -s block-plan --type plan >/dev/null)
for s in guess-todo flag-todo block-plan; do curl -s "$B/p/revproj/$s" >/dev/null; $CLI todos check "revproj/$s" >/dev/null 2>&1; done; sleep 1
check "按标题猜出来的待办：里面的检测命令不跑，页面上也不标" "grep -q '\"category\": \"todo\"' '$MYDASH_DATA/revproj/guess-todo/meta.json' && test ! -e '$TMP/ran-guess' && ! curl -s '$B/p/revproj/guess-todo' | grep -q 'todo-cmd'"
check "--type todo 发布的待办：检测命令照跑，页面上直接显示命令" "test -e '$TMP/ran-flag' && curl -s '$B/p/revproj/flag-todo' | grep 'class=\"todo-cmd\"' | grep -q 'ran-flag'"
check "方案里 \`\`\`todo 块的检测命令照跑" "test -e '$TMP/ran-block'"
# --- 防误发密钥 ---
mkdir -p "$RV/fh/.kube" "$RV/fh/.mydash" "$RV/docs"; printf 'apiVersion: v1\nusers:\n- user:\n    client-key-data: abc\n' > "$RV/fh/.kube/config"; ln -sfn "$RV/fh/.kube" "$RV/docs/k8s"
printf '{"notify":{"channels":[{"type":"telegram","token":"1:x"}]}}' > "$RV/fh/.mydash/config.json"
printf '# 文档\n\n[配置](docs/k8s/config)\n' > "$RV/kube.md"; printf '# 文档\n\n[配置](%s)\n' "$RV/fh/.mydash/config.json" > "$RV/mdcfg.md"
check "引用的文件经过符号链接指向 ~/.kube：照样拦下" "! (cd '$RV' && $CLI publish kube.md -p revproj -s kube >/dev/null 2>&1) && test ! -d '$MYDASH_DATA/revproj/kube'"
check "mydash 自己的 config.json（推送密码、令牌）也拦" "! (cd '$RV' && $CLI publish mdcfg.md -p revproj -s mdcfg >/dev/null 2>&1) && test ! -d '$MYDASH_DATA/revproj/mdcfg'"
printf '# 教程\n\n```html\n<img src="/etc/hosts">\n```\n\n行内 `![x](/etc/hosts)` 只是示例。\n' > "$RV/code.md"
(cd "$RV" && $CLI publish code.md -p revproj -s code >/dev/null)
check "代码块和行内代码里的引用是示例：不收集、不改写" "! ls '$MYDASH_DATA/revproj/code/v1/_assets' >/dev/null 2>&1 && grep -q '<img src=\"/etc/hosts\">' '$MYDASH_DATA/revproj/code/v1/code.md' && grep -q '(/etc/hosts)' '$MYDASH_DATA/revproj/code/v1/code.md'"
# --- 审批单 ---
printf '# 旧版的答复\n\n```approval\n{"questions":[{"id":"go","type":"choice","label":"做吗？","options":["做","不做"],"required":true}]}\n```\n' > "$RV/apold.md"
(cd "$RV" && $CLI publish apold.md -p revproj -s ap-old >/dev/null)
POSTJ -H 'X-Mydash: 1' -d '{"id":"revproj/ap-old","v":1,"answers":{"go":"做"}}' "$B/api/approval" >/dev/null
(cd "$RV" && printf '# 旧版的答复\n\n补了一句。\n\n```approval\n{"questions":[{"id":"go","type":"choice","label":"做吗？","options":["做","不做"],"required":true}]}\n```\n' > apold.md && $CLI publish apold.md -p revproj -s ap-old >/dev/null)
check "答了 v1、agent 没看到又发了 v2：v1 的答复照样交给 agent" "$CLI approvals revproj/ap-old --json | grep '\"go\":\"做\"' >/dev/null"
printf '# 列表里的审批块\n\n- 先看这一段\n\n    ```approval\n    {"questions":[{"id":"budget","type":"line","label":"预算？","required":true}]}\n    ```\n\n```approval\n{"questions":[{"id":"a","type":"line","label":"A？"}]}\n```\n' > "$RV/apind.md"
(cd "$RV" && $CLI publish apind.md -p revproj -s ap-indent >/dev/null)
check "列表里缩进的审批块：页面上显示的题，答案也存得下、必答也检查" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"revproj/ap-indent\",\"v\":1,\"answers\":{\"a\":\"x\"}}' '$B/api/approval')\" = 422 && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"id\":\"revproj/ap-indent\",\"v\":1,\"answers\":{\"a\":\"x\",\"budget\":\"100\"}}' '$B/api/approval')\" = 200 && grep -q '\"budget\": \"100\"' '$MYDASH_DATA/revproj/ap-indent/responses.json'"
# --- 设置页 ---
chadd() { POSTB -H 'X-Mydash: 1' -d "$1" "$B/api/channels"; }
chadd '{"op":"add","type":"bark","fields":{"url":"http://127.0.0.1:1/AbCdEfGhIjKlMnOpQr/"}}' > "$RV/ch1.json"
check "Bark 网址末尾带 / 时设备 key 也遮住" "grep -q '\"ok\"\\|channels' '$RV/ch1.json' && ! grep -q 'AbCdEfGhIjKlMnOpQr' '$RV/ch1.json' && ! curl -s '$B/settings' | grep -q 'AbCdEfGhIjKlMnOpQr'"
check "改设置后 config.json 仍然只给自己读" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"autoArchiveDays\":14}' '$B/api/settings')\" = 200 && test \"\$(fmode '$MYDASH_HOME/config.json')\" = 600"
chadd '{"op":"add","type":"webhook","fields":{"url":"http://127.0.0.1:1/hook","secret":"sek-123456"}}' >/dev/null
WHID=$(CHID webhook 127.0.0.1:1/hook)
check "webhook 的签名密钥可以单独清掉" "grep -q 'sek-123456' '$MYDASH_HOME/config.json' && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"op\":\"update\",\"id\":\"'$WHID'\",\"fields\":{\"url\":\"\",\"secret\":\"\"},\"clear\":[\"secret\"]}' '$B/api/channels')\" = 200 && ! grep -q 'sek-123456' '$MYDASH_HOME/config.json' && grep -q '127.0.0.1:1/hook' '$MYDASH_HOME/config.json'"
POSTJ -H 'X-Mydash: 1' -d '{"op":"remove","id":"'"$WHID"'"}' "$B/api/channels" >/dev/null; POSTJ -H 'X-Mydash: 1' -d '{"op":"remove","id":"'"$(CHID bark AbCdEf)"'"}' "$B/api/channels" >/dev/null
(cd "$RV" && printf '# Summary\n\n正文\n' > dup.md && $CLI publish dup.md -p revproj -s dup --title 'Weekly summary report for October' >/dev/null)
check "正文的短标题只是页面标题的一小部分时照常显示" "curl -s '$B/p/revproj/dup' | grep -q '<h1 id=\"summary\">'"
# --- 钩子 ---
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"p-batch-1","cwd":"/x/revproj","tool_name":"Bash","tool_input":{"command":"ls"}}' > "$RV/p-batch.json"
CLAUDE_CODE_ENTRYPOINT=sdk-cli node "$ROOT/bin/agent-ask.mjs" claude < "$RV/p-batch.json" > "$RV/p-batch.out" 2>&1 & PBJ=$!; sleep 1.5
check "claude -p（没人看着）：权限请求不接，钩子马上退出，那边按默认拒绝" "! kill -0 $PBJ 2>/dev/null && test ! -s '$RV/p-batch.out' && test -z \"\$(PID1)\""
printf '%s' '{"session_id":"p-batch-2","last_assistant_message":"为什么会进化？"}' | CLAUDE_CODE_ENTRYPOINT=sdk-cli node "$ROOT/bin/agent-state.mjs" idle > "$RV/p-state.out"
check "claude -p：问号结尾也不拦，不改批量任务的输出" "test ! -s '$RV/p-state.out' && test ! -e '$MYDASH_HOME/state/agents/p-batch-2.json'"
printf '%s' '{"hook_event_name":"StopFailure","session_id":"stopfail-1","last_assistant_message":"要不要？"}' | node "$ROOT/bin/agent-state.mjs" idle > "$RV/sf.out"
check "这一轮因为 API 出错结束（StopFailure）：记成闲，不拦" "test ! -s '$RV/sf.out' && grep -q '\"idle\"' '$MYDASH_HOME/state/agents/stopfail-1.json'"
# 一条消息里并行两个 Bash：按命令对上是哪一个
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_par_a","name":"Bash","input":{"command":"touch a"}},{"type":"tool_use","id":"toolu_par_b","name":"Bash","input":{"command":"touch b"}}]}}' > "$RV/par-tr.jsonl"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"sess-par","cwd":"/x/revproj","tool_name":"Bash","tool_input":{"command":"touch a"},"transcript_path":"'"$RV/par-tr.jsonl"'"}' > "$RV/par-a.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$RV/par-a.json" > "$RV/par-a.out" 2>&1 & PPA=$!; sleep 1; PPAID=$(PID1)
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_par_b","content":"ok"}]}}' >> "$RV/par-tr.jsonl"; sleep 3
check "并行的另一个调用先有结果：这一个还在等" "kill -0 $PPA 2>/dev/null && test \"\$(pstatus $PPAID)\" = pending"
node -e 'process.stdout.write(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"toolu_par_a",content:"x".repeat(400000)}]}})+"\n")' >> "$RV/par-tr.jsonl"; waitgone $PPA
check "它自己的结果到了（哪怕这一行有 400 KB）：标成在终端答了" "! kill -0 $PPA 2>/dev/null && test \"\$(pstatus $PPAID)\" = terminal"
# 子 agent 里的权限请求：看子 agent 自己的记录，主会话里早就完成的同名调用不算
mkdir -p "$RV/sub/sess-sub/subagents"
printf '%s\n%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_main_old","name":"Bash","input":{"command":"ls"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_main_old","content":"ok"}]}}' > "$RV/sub/sess-sub.jsonl"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_sub_1","name":"Bash","input":{"command":"ls"}}]}}' > "$RV/sub/sess-sub/subagents/agent-ag1.jsonl"
printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"sess-sub","agent_id":"ag1","cwd":"/x/revproj","tool_name":"Bash","tool_input":{"command":"ls"},"transcript_path":"'"$RV/sub/sess-sub.jsonl"'"}' > "$RV/sub.json"
node "$ROOT/bin/agent-ask.mjs" claude < "$RV/sub.json" > "$RV/sub.out" 2>&1 & PSB=$!; sleep 3; PSBID=$(PID1)
check "子 agent 的权限请求：不会被主会话里早就完成的同名调用误判成答了" "kill -0 $PSB 2>/dev/null && test \"\$(pstatus $PSBID)\" = pending"
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_sub_1","content":"ok"}]}}' >> "$RV/sub/sess-sub/subagents/agent-ag1.jsonl"; waitgone $PSB
check "子 agent 在终端答了：标成在终端答了" "test \"\$(pstatus $PSBID)\" = terminal"
# 终端里批准了一条要跑很久的命令：一开始跑就知道（不用等它跑完、结果写进记录）
node -e '
const fs=require("fs"),[dir]=process.argv.slice(1);
const cmd="echo '"'"'it'"'"'\"'"'"'\"'"'"'s'"'"' && sleep 6 # long-mark\necho two";
fs.writeFileSync(dir+"/long-tr.jsonl",JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"toolu_long",name:"Bash",input:{command:cmd}}]}})+"\n");
fs.writeFileSync(dir+"/long.json",JSON.stringify({hook_event_name:"PermissionRequest",session_id:"sess-long",cwd:"/x/revproj",tool_name:"Bash",tool_input:{command:cmd},transcript_path:dir+"/long-tr.jsonl"}));
// Claude Code 起 shell 的样子：eval 后面是单引号包起来的原命令，里面的单引号写成 '"'"'
fs.writeFileSync(dir+"/long.sh","true && eval "+"'"'"'"+cmd.replace(/'"'"'/g,"'"'"'\"'"'"'\"'"'"'")+"'"'"'"+" < /dev/null && pwd -P >| /dev/null");
' "$RV"
node "$ROOT/bin/agent-ask.mjs" claude < "$RV/long.json" > "$RV/long.out" 2>&1 & HL=$!; sleep 1.5; LID=$(PID1)
sh -c 'true && eval '"'"'sleep 5 # other-mark'"'"' < /dev/null' & OTH=$!; sleep 3
check "终端里跑起来的是别的命令：这道题还在等" "kill -0 $HL 2>/dev/null && test \"\$(pstatus $LID)\" = pending"
sh -c "$(cat "$RV/long.sh")" >/dev/null 2>&1 & SL=$!; waitgone $HL
check "终端批准了一条要跑很久的命令：一开始跑就标成在终端答了，不等它跑完" "! kill -0 $HL 2>/dev/null && kill -0 $SL 2>/dev/null && test \"\$(pstatus $LID)\" = terminal && test ! -s '$RV/long.out'"
kill $SL $OTH 2>/dev/null; wait $SL $OTH 2>/dev/null
# Codex 桌面版的 request_user_input_async：工具马上返回，答案是之后用户发来的消息
printf '%s\n' '{"type":"session_meta","payload":{"cwd":"/x/revproj"}}' > "$RV/cx-async.jsonl"
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"thr-async","cwd":"/x/revproj","tool_name":"request_user_input_async","tool_use_id":"call_async1","transcript_path":"'"$RV/cx-async.jsonl"'","tool_input":{"questions":[{"title":"桌面版问的哪条路？","options":["甲","乙"]},{"title":"还有什么要补充？"}]}}' > "$RV/cx-async.json"
node "$ROOT/bin/agent-ask.mjs" codex < "$RV/cx-async.json" > "$RV/cx-async.out" 2>&1; sleep 1; PAS=$(PID1)
check "Codex 桌面版的选择题（request_user_input_async）也到了 mydash" "test ! -s '$RV/cx-async.out' && curl -s '$B/prompts/$PAS' | grep -q '桌面版问的哪条路' && curl -s '$B/prompts/$PAS' | grep -q '还有什么要补充'"
printf '%s\n%s\n' '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_async1","output":"queued"}}' '{"type":"event_msg","payload":{"type":"task_complete"}}' >> "$RV/cx-async.jsonl"; sleep 4
check "桌面版：工具马上返回、这一轮结束了，题还在等用户" "test \"\$(pstatus $PAS)\" = pending"
printf '%s\n' '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<send_user_message_question_reply>[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_async1\\\",0]\",\"answer\":\"甲\"}]</send_user_message_question_reply>"}]}}' >> "$RV/cx-async.jsonl"; sleep 4
check "桌面版：用户在软件里答了，mydash 那份关掉" "test \"\$(pstatus $PAS)\" = terminal"
# --- 接入：只动这一份安装装过的东西 ---
printf '# 我的规则\n' > "$CH/CLAUDE.md"; $CLI integrate claude >/dev/null
MYDASH_HOME="$RV/other-home" node "$ROOT/bin/mydash.mjs" integrate claude --remove >/dev/null 2>&1
check "另一份安装（没接入过）卸载时，不动主安装写进去的规则段和钩子" "grep -q 'mydash:begin' '$CH/CLAUDE.md' && grep -q 'agent-ask.mjs' '$CH/settings.json'"
MYDASH_HOME="$RV/other-home" node -e 'import(process.argv[1]).then(m=>process.stdout.write(JSON.stringify(m.refresh("claude"))))' "$ROOT/lib/integrate.mjs" > "$RV/other-refresh.json"
check "另一份安装更新时也不改主安装的文件" "grep -q '\"changes\":\[\]' '$RV/other-refresh.json'"
$CLI integrate claude --remove >/dev/null
mkdir -p "$RV/ch3"; printf '{\n    "theme": "dark",\n    "hooks": {}\n}' > "$RV/ch3/settings.json"; printf '我自己的规则' > "$RV/ch3/CLAUDE.md"
cp "$RV/ch3/settings.json" "$RV/settings.orig"; cp "$RV/ch3/CLAUDE.md" "$RV/claude.orig"
MYDASH_CLAUDE_HOME="$RV/ch3" $CLI integrate claude >/dev/null; MYDASH_CLAUDE_HOME="$RV/ch3" $CLI integrate claude --remove >/dev/null
check "接入再撤销：settings.json（4 格缩进、末尾没换行、原来的空 hooks）和 CLAUDE.md 一字不差" "cmp -s '$RV/ch3/settings.json' '$RV/settings.orig' && cmp -s '$RV/ch3/CLAUDE.md' '$RV/claude.orig'"
# Codex：更新钩子时原地换，用户排在后面的钩子位置不变（Codex 的信任按位置记）
$CLI integrate codex >/dev/null
node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f));j.hooks.Stop.push({hooks:[{type:"command",command:"my-stop.py"}]});const g=j.hooks.Stop.find(g=>/agent-state/.test(g.hooks[0].command));g.hooks[0].timeout=99;fs.writeFileSync(f,JSON.stringify(j,null,2))' "$XH/hooks.json"
refreshj codex >/dev/null
check "Codex：更新钩子后，用户自己的钩子还在原来的位置" "node -e 'const s=require(\"$XH/hooks.json\").hooks.Stop;process.exit(s.length===2&&/agent-state/.test(s[0].hooks[0].command)&&s[0].hooks[0].timeout===5&&s[1].hooks[0].command===\"my-stop.py\"?0:1)'"
$CLI integrate codex --remove >/dev/null
# --- 安装 ---
check "--service 写错了直接报错，不装" "! MYDASH_HOME='$RV/svc-home' node '$ROOT/bin/mydash.mjs' setup install --service launchagent --access local --port $((PORT+40)) --json >'$RV/svc.out' 2>&1 && grep -q -- '--service' '$RV/svc.out' && test ! -d '$RV/svc-home/app'"
pid_ok() { sleep 60 & local sp=$!; local h="$RV/pid-home"; mkdir -p "$h/run"; local label; label=$(MYDASH_HOME="$h" node -e 'import(process.argv[1]).then(s=>process.stdout.write(s.SERVICES.server.launchd))' "$ROOT/lib/service.mjs"); echo $sp > "$h/run/$label.pid"; MYDASH_HOME="$h" node -e 'import(process.argv[1]).then(s=>s.removeService("server","none"))' "$ROOT/lib/service.mjs"; local alive=1; kill -0 $sp 2>/dev/null || alive=0; kill $sp 2>/dev/null; test $alive = 1; }
check "pid 文件里记的进程号被别的程序用了：不会误杀它" "pid_ok"

echo "英文界面"
EP=$((PORT+2)); EN_HOME="$TMP/en-home"; mkdir -p "$EN_HOME"
MYDASH_LANG=en MYDASH_PORT=$EP MYDASH_CONTENT_PORT=$((PORT+3)) MYDASH_BASE_URL="http://127.0.0.1:$EP" node "$ROOT/server.mjs" > "$TMP/server-en.log" 2>&1 &
SRV_EN=$!; for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$EP/healthz" >/dev/null && break; sleep 0.25; done
EH=$(curl -s "http://127.0.0.1:$EP/")
check "英文首页" "echo \"\$EH\" | grep '<html lang=\"en\"' >/dev/null && echo \"\$EH\" | grep 'All items' >/dev/null"
check "英文首页没有中文界面文字" "! echo \"\$EH\" | grep -E '全部产物|只有 tailnet|切换项目|标为已读' >/dev/null"
check "英文浏览器端没有中文译文" "curl -s 'http://127.0.0.1:$EP/i18n.js' | grep 'window.__T={}' >/dev/null"
check "中文浏览器端带译文" "curl -s '$B/i18n.js' | grep '刚刚' >/dev/null"
check "英文命令行输出" "MYDASH_LANG=en $CLI publish '$TMP/fx/notes.md' -p smoke -s en-cli | grep '^Published: ' >/dev/null"
kill $SRV_EN 2>/dev/null
check "译文齐全" "node '$ROOT/test/i18n-check.mjs' --missing-only"
check "网页字体本地加载" "! echo \"\$EH\" | grep 'fonts.googleapis' >/dev/null && curl -sf -o /dev/null '$B/static/fonts/Geist-Variable.woff2'"

echo "实时推送"
wait $EV 2>/dev/null
check "SSE 收到变更事件" "grep -q 'event: change' '$TMP/events.txt'"
check "SSE 事件带条目 ID" "grep -q 'battle-plan' '$TMP/events.txt'"

echo "命令"
check "ls" "$CLI ls smoke | grep -c 'smoke/battle-plan'"
check "ls --all 列出全部项目" "$CLI ls --all | grep -c 'other/'"
$CLI rm smoke/battle-plan --version 1 >/dev/null
check "rm 单个版本" "test ! -d '$MYDASH_DATA/smoke/battle-plan/v1' && test -d '$MYDASH_DATA/smoke/battle-plan/v2'"
$CLI rm other/chart >/dev/null
check "rm 整个条目" "test ! -d '$MYDASH_DATA/other/chart'"
(cd "$TMP" && printf '# 临时待办\n\n- [ ] 一件事\n' > rmtodo.md && CLAUDE_CODE_SESSION_ID=sess-rm $CLI publish rmtodo.md -p rmproj -s rm-todo --type todo >/dev/null)
check "删掉的待办不再挂在「还开着的事」里" "grep -q 'rmproj/rm-todo' '$MYDASH_HOME/state/open-items.json' && $CLI rm rmproj/rm-todo >/dev/null && ! grep -q 'rmproj/rm-todo' '$MYDASH_HOME/state/open-items.json'"
check "服务日志无报错" "! grep -i 'error' '$TMP/server.log' | grep -v smoke-probe | grep -c ."

echo "新版本（只跟正式版本的标签）"
check "版本号比较和挑最新的标签" "node -e 'import(\"$ROOT/lib/update.mjs\").then(m=>process.exit(m.latestTag([\"v0.1.0\",\"v0.10.0\",\"v0.9.9\",\"v1.0.0-rc1\",\"main\"])===\"v0.10.0\"&&m.cmpVer(\"0.1.10\",\"0.1.9\")>0&&m.cmpVer(\"v1.0.0\",\"1.0.0\")===0?0:1))'"
UG="$TMP/upd"; mkdir -p "$UG"
git init -q --bare -b main "$UG/origin.git"
git init -q -b main "$UG/work" && git -C "$UG/work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one && git -C "$UG/work" tag v0.0.1 \
  && git -C "$UG/work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two && git -C "$UG/work" tag v99.0.0 \
  && git -C "$UG/work" push -q "$UG/origin.git" main --tags 2>/dev/null
git clone -q -b main "$UG/origin.git" "$UG/src" 2>/dev/null && git -C "$UG/src" reset -q --hard v0.0.1
OLD=$(git -C "$UG/src" rev-parse HEAD)
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.source=process.argv[2];c.sourceRemote=process.argv[3];require("fs").writeFileSync(f,JSON.stringify(c))' "$MYDASH_HOME/config.json" "$UG/src" "$UG/origin.git"
check "设置页能看有没有新版本：问远端的标签" "POSTJ -H 'X-Mydash: 1' -d '{\"action\":\"check\"}' '$B/api/update' >/dev/null; curl -s '$B/api/update' | node -e 'const s=JSON.parse(require(\"fs\").readFileSync(0));process.exit(s.available&&s.latest.version===\"99.0.0\"&&s.canUpdate?0:1)'"
check "mydash update --check 也看得到" "$CLI update --check --json | grep -q '\"available\":true'"
check "首页顶上出现「可以更新了」和更新按钮" "curl -s '$B/' | grep -q 'upd-available' && curl -s '$B/' | grep -q 'data-upd=\"start\"'"
check "设置页有更新一栏" "curl -s '$B/settings' | grep -q 'id=\"update\"'"
check "doctor 里有版本这一行" "$CLI doctor --json | grep -q '可以更新到 99.0.0'"
check "设置：有新版本时怎么做（只认三种）" "test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"updateMode\":\"auto\"}' '$B/api/settings')\" = 200 && grep -q '\"mode\": \"auto\"' '$MYDASH_HOME/config.json' && test \"\$(POSTJ -H 'X-Mydash: 1' -d '{\"updateMode\":\"weekly\"}' '$B/api/settings')\" = 400"
POSTJ -H 'X-Mydash: 1' -d '{"updateMode":"notify"}' "$B/api/settings" >/dev/null
check "开始更新要带 X-Mydash 头" "test \"\$(POSTJ -d '{\"action\":\"start\"}' '$B/api/update')\" = 403"
# 真的点「更新」：更新进程和服务脱开跑；这个假仓库里没有 package.json，装不上，源码目录要退回原来的版本
POSTJ -H 'X-Mydash: 1' -d '{"action":"start"}' "$B/api/update" >/dev/null
for i in $(seq 1 120); do curl -s "$B/api/update" | grep -q '"last":{' && ! curl -s "$B/api/update" | grep -q '"running":{' && break; sleep 0.5; done
check "更新失败：记下结果，说明退回了" "curl -s '$B/api/update' | node -e 'const s=JSON.parse(require(\"fs\").readFileSync(0));process.exit(!s.running&&s.last&&s.last.ok===false&&s.last.rolledBack&&s.last.to===\"99.0.0\"&&!s.last.seen?0:1)'"
check "更新失败：源码目录退回原来的提交，还在分支上" "[ \"\$(git -C '$UG/src' rev-parse HEAD)\" = '$OLD' ] && git -C '$UG/src' symbolic-ref -q HEAD >/dev/null"
check "首页显示更新失败" "curl -s '$B/' | grep -q 'upd-failed'"
check "点「知道了」收起结果" "POSTJ -H 'X-Mydash: 1' -d '{\"action\":\"seen\"}' '$B/api/update' >/dev/null && ! curl -s '$B/' | grep -q 'upd-failed'"
git -C "$UG/src" -c user.name=t -c user.email=t@t commit -q --allow-empty -m mine
check "源码目录里有自己的提交：不动它" "! $CLI update --json > '$UG/div.json' && grep -q 'v99.0.0' '$UG/div.json' && git -C '$UG/src' log -1 --format=%s | grep -qx mine"
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));delete c.source;delete c.sourceRemote;require("fs").writeFileSync(f,JSON.stringify(c))' "$MYDASH_HOME/config.json"
rm -f "$MYDASH_HOME/state/update.json"

echo "独立 Tailscale 节点的地址（假的 tailscale 命令）"
fake_node() { # 目录 状态JSON
  mkdir -p "$1/ts/bin" "$1/ts/state"; printf '%s' "$2" > "$1/fake-status.json"
  cat > "$1/ts/bin/tailscale" <<EOF
#!/bin/sh
for a in "\$@"; do case "\$a" in status) cat "$1/fake-status.json"; exit 0;; serve) case "\$*" in *"serve status"*) echo '{}';; esac; exit 0;; up) exit 0;; esac; done
EOF
  printf '#!/bin/sh\nsleep 1\n' > "$1/ts/bin/tailscaled"; chmod +x "$1/ts/bin/tailscale" "$1/ts/bin/tailscaled"; : > "$1/ts/tailscaled.sock"
}
node_install() { # 目录 端口
  env -u MYDASH_DATA -u MYDASH_PORT -u MYDASH_BASE_URL -u MYDASH_CONTENT_PORT MYDASH_HOME="$1" node "$ROOT/bin/mydash.mjs" setup install --access tailscale-node --hostname mdfakenode --lang en --port "$2" --content-port "$(($2+1))" --service none --bin-dir "$1/bin" --json 2>/dev/null > "$1/install.json"
  env -u MYDASH_DATA -u MYDASH_PORT -u MYDASH_BASE_URL -u MYDASH_CONTENT_PORT MYDASH_HOME="$1" node "$ROOT/bin/mydash.mjs" uninstall >/dev/null 2>&1
}
jq_js() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(eval(process.argv[2])?0:1)' "$1" "$2"; }
NN="$TMP/node-tests"; mkdir -p "$NN"
fake_node "$NN/pending" '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/fake"}'
node_install "$NN/pending" $((PORT+50))
check "还没批准：安装给的是本机地址，不是打不开的短名" "jq_js '$NN/pending/install.json' 'r.url===\"http://127.0.0.1:$((PORT+50))/\"'"
check "还没批准：列出批准链接" "jq_js '$NN/pending/install.json' 'r.human.some(h=>h.id===\"tailscale-node-login\"&&h.url)'"
fake_node "$NN/taken" '{"BackendState":"Running","Self":{"DNSName":"mdfakenode-1.tailfake.ts.net."},"MagicDNSSuffix":"tailfake.ts.net"}'
node_install "$NN/taken" $((PORT+54))
check "名字被占用：安装给的是真实名字" "jq_js '$NN/taken/install.json' 'r.url===\"http://mdfakenode-1/\"&&r.localUrl===\"http://127.0.0.1:$((PORT+54))/\"'"
check "名字被占用：告诉用户" "jq_js '$NN/taken/install.json' 'r.human.some(h=>h.id===\"tailscale-node-name\")'"
# 服务开着时批准、或者名字变了：地址和放行的主机名自动跟上
LV="$NN/live"; fake_node "$LV" '{"BackendState":"Running","Self":{"DNSName":"mdfakenode-1.tailfake.ts.net."}}'
LP=$((PORT+58))
echo "{\"access\":\"tailscale-node\",\"hostname\":\"mdfakenode\",\"tailnetNames\":[\"mdfakenode\"],\"allowedHosts\":[\"mdfakenode\"],\"port\":$LP,\"contentPort\":$((LP+1)),\"baseUrl\":\"http://mdfakenode\"}" > "$LV/config.json"
env -u MYDASH_DATA -u MYDASH_PORT -u MYDASH_BASE_URL -u MYDASH_CONTENT_PORT MYDASH_HOME="$LV" node "$ROOT/server.mjs" > "$NN/live.log" 2>&1 &
LVP=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$LP/healthz" >/dev/null && break; sleep 0.25; done
for i in $(seq 1 40); do grep -q 'mdfakenode-1' "$LV/config.json" && break; sleep 0.25; done
sleep 0.2
check "节点改名后配置里的地址跟上" "jq_js '$LV/config.json' 'r.baseUrl===\"http://mdfakenode-1\"&&r.tailnetNames.join()===\"mdfakenode-1\"&&!r.allowedHosts.includes(\"mdfakenode\")'"
check "节点改名后真实名字能打开" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: mdfakenode-1' http://127.0.0.1:$LP/)\" = 200 ]"
check "节点改名后内容端口也认真实名字" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: mdfakenode-1:$((LP+1))' http://127.0.0.1:$((LP+1))/healthz)\" != 421 ]"
check "节点改名后旧名字不再放行" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: mdfakenode' http://127.0.0.1:$LP/)\" = 421 ]"
kill $LVP 2>/dev/null

echo
echo "通过 ${PASS}，失败 ${FAIL}"
[ $FAIL -gt 0 ] && { echo "--- 服务日志 ---"; tail -20 "$TMP/server.log"; }
[ $FAIL -eq 0 ]
