#!/usr/bin/env bash
# 一把梭复验：单测 → 起静态服 → 无头 Chrome 真指针通关 → 截图。
#
# 端口与 nikoli-cos 的 verify.sh 错开（那边 5188/9335）：两个仓常常同时复验，
# 撞了端口会静默连到对面的页面上去，那边全绿、这边一无所有。
#
# 不要加 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader：
# 软件光栅会把十几个核打满，而且没有 CDP 客户端时进程不会自己退。
#
#   ./tools/verify.sh                    # 全跑
#   KINDS=slitherlink ./tools/verify.sh # 只复验一种玩法（跳过单测用 SKIP_UNIT=1）
set -u -o pipefail
# pipefail 不是风格问题，是单测那一步的命：`node --test test/ | tail -14 || FAILED=1` 里
# `||` 拿到的是 tail 的退出码，而 tail 读到 EOF 就退 0 —— 套件红透也照样 FAILED=0。
# 本仓的 CI 只有 `bash tools/verify.sh` 这一步跑引擎单测，所以没这条 flag 时，
# "引擎单测过了"这句在 CI 里结构上不可能变红。
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP=${CDP_PORT:-9336}
# 5173 在本机常被别的项目的 dev server 占着，绑失败会静默对旧端口做测试，所以默认另起。
SPORT=${SPORT:-5189}
BASE="http://127.0.0.1:${SPORT}/"
SHOTS=${SHOT_DIR:-$HERE/.playtest}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "找不到 Chrome，请设 CHROME_BIN" >&2; exit 2; }

cd "$HERE"
FAILED=0

if [ -z "${SKIP_UNIT:-}" ]; then
  mkdir -p "$SHOTS"
  echo "=== 单测（引擎纯逻辑，无浏览器）==="
  npm test --silent > "$SHOTS/unit.log" 2>&1
  URC=$?
  # 打印计数行而不是尾 14 行：全绿时输出末尾是两盏 todo 的断言栈，`tail -14` 于是
  # 在 CI 里贴出一段像崩了的栈，而真正该被读回的 tests/pass/fail/todo 一行都看不见。
  # spec 与 tap 两种 reporter 都要认（CI 不是 TTY，走 tap 的 `# tests N`）。
  grep -E '^(ℹ|#) (tests|pass|fail|todo) ' "$SHOTS/unit.log" || tail -14 "$SHOTS/unit.log"
  # 光把 rc 接回来还不够：CI 的 runner 连着四次报 `# tests 1 / # fail 1`（40ms，`test/`
  # 那五个套件一个都没进来），而 `1` 这一项本身退 1 —— 有 rc 也得有人判断"什么都没发现"
  # 是一种红。下限用这条腿自己的输入集数出来（同一个 glob），不抄一个写死的数字。
  FILES=0
  for f in test/*.test.mjs; do [ -e "$f" ] || continue; FILES=$((FILES+1)); done
  T=$(grep -oE '^(ℹ|#) tests [0-9]+' "$SHOTS/unit.log" | head -1 | grep -oE '[0-9]+$')
  if [ -z "$T" ]; then
    echo "  RED 单测没打印出 tests 计数行：reporter 换了形状，这道计数闸自己空了（全文见 $SHOTS/unit.log）"
    FAILED=1
  elif [ "$T" -lt "$FILES" ]; then
    echo "  RED 单测只报了 $T 项，比 test/*.test.mjs 的 $FILES 个套件还少 —— 这一跑基本什么都没发现"
    FAILED=1
  fi
  [ $URC -eq 0 ] || { echo "  RED 单测 rc=$URC（全文见 $SHOTS/unit.log）"
    grep -E '^not ok' "$SHOTS/unit.log" | head -20
    FAILED=1; }
fi

echo "=== 静态服 :$SPORT ==="
node tools/serve.mjs "$SPORT" >/tmp/nikoli-loops-serve.log 2>&1 &
SPID=$!
UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP --user-data-dir=$UDD \
  --window-size=860,640 --no-first-run --no-default-browser-check --mute-audio \
  about:blank >/tmp/nikoli-loops-chrome.log 2>&1 &
CPID=$!
cleanup() { kill $SPID 2>/dev/null; kill -9 $CPID 2>/dev/null; rm -rf $UDD; }
trap cleanup EXIT
# 看门狗要重定向自己的 fd：后台子 shell 会继承脚本 stdout，跑在管道里就会把写端
# 一直握着，测试早就完了下游却还在等。
( sleep ${WD_TIMEOUT:-300}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# 静态服 bind 也要等端点：紧跟着 curl 会在它监听之前就跑完。
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || { echo "静态服没起来：$(cat /tmp/nikoli-loops-serve.log)" >&2; exit 3; }
# 预检必须**按字节**比对，只问"有没有 200"不算预检：$SPORT 若被别的项目已经绑上，
# 本仓的 serve 会因 EADDRINUSE 死掉，而对面那个服务照样回 200 —— 于是"静态服起来了"
# 这一关过了，整趟复验却打在另一个应用的页面上（那边全绿、这边一无所有）。
SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
if [ "$SERVED" != "$(cat "$HERE/index.html")" ]; then
  echo "预检失败：:$SPORT 回的字节不是本仓的 index.html —— 端口被别的服务占了？（serve 日志：$(cat /tmp/nikoli-loops-serve.log)）" >&2
  exit 3
fi
# 页面加载靠的是 ES Module 图：index.html 在、js/ 全 404 会表现成一张白盘，
# 所以入口模块也必须是这条服真的吐出来的。
MODULE=$(curl -fsS -m 5 "${BASE}js/main.js" 2>/dev/null || true)
if [ "$MODULE" != "$(cat "$HERE/js/main.js")" ]; then
  echo "预检失败：$BASE/js/main.js 回的字节与磁盘上的不一致（这条服不是本仓的文档根？）" >&2
  exit 3
fi
# 全新 --user-data-dir 绑定 DevTools 比热档慢，等端点而不是猜 sleep。
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 || {
  echo "DevTools 没在 :$CDP 上监听" >&2; exit 3; }

echo "=== 无头通关（真指针事件）==="
mkdir -p "$SHOTS"
CDP_PORT=$CDP BASE_URL=$BASE SHOT_DIR=$SHOTS node tools/playtest.mjs > "$SHOTS/result.json" 2>&1 || FAILED=1
python3 - "$SHOTS/result.json" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
try:
    i, j = raw.index('{'), raw.rindex('}')
    d = json.loads(raw[i:j + 1])
except Exception:
    print('  无头复验没吐出 JSON：\n' + raw[-800:]); sys.exit(1)
for r in d['rows']:
    print(('  ok   ' if r['pass'] else '  FAIL ') + r['test'] + ('' if r['pass'] else '  ← ' + json.dumps(r['detail'], ensure_ascii=False)[:300]))
print('rows: %d  fail: %s  errors: %s' % (len(d['rows']), d['fail'], d.get('errors')))
# 行数塌了就说明有玩法整段没跑到（注册表脱节、路由进不去），不能只看没有 FAIL
sys.exit(1 if d['fail'] or len(d['rows']) < 15 else 0)
PY
[ $? -ne 0 ] && FAILED=1

kill $WD 2>/dev/null
echo "=== 截图：$SHOTS ==="
ls -1 "$SHOTS" 2>/dev/null | sed 's/^/  /'
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== 上方有失败 ==="
exit $FAILED
