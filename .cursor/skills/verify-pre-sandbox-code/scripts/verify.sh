#!/usr/bin/env bash

set -uo pipefail

c_green=$'\033[32m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_off=$'\033[0m'
pass() { printf '  %sPASS%s %s\n' "$c_green" "$c_off" "$1"; }
fail() { printf '  %sFAIL%s %s\n' "$c_red" "$c_off" "$1"; exit 1; }
step() { printf '\n%s[%s/3] %s%s\n' "$c_bold" "$1" "$2" "$c_off"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${JSONFB_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
PROJECT="$ROOT/test/pre-sandbox-code-e2e"
TEST_TIMEOUT="${TEST_TIMEOUT:-30}"

printf '%s验证 publish/code/preSandbox.js 远程代码%s\n' "$c_bold" "$c_off"

step 1 "源码与测试工程静态校验"
command -v node >/dev/null 2>&1 || fail "未找到 node"
[ -f "$ROOT/publish/code/preSandbox.js" ] || fail "缺少 publish/code/preSandbox.js"
[ -f "$PROJECT/package.json" ] || fail "缺少独立测试工程 package.json"
[ -f "$PROJECT/server.js" ] || fail "缺少 Express 4 测试服务"
[ -f "$PROJECT/test/pre-sandbox-code.test.js" ] || fail "缺少 node:test 黑盒用例"
node --check "$ROOT/publish/code/preSandbox.js" || fail "preSandbox.js 语法错误"
node --check "$PROJECT/server.js" || fail "测试服务语法错误"
node --check "$PROJECT/test/pre-sandbox-code.test.js" || fail "测试用例语法错误"
pass "源码和测试工程结构有效"

step 2 "构建并经 yalc 安装真实 jsonfb + Express 4"
command -v yalc >/dev/null 2>&1 || fail "未找到 yalc"
(cd "$ROOT" && npm run build:notobf) || fail "jsonfb 单文件构建失败"
(cd "$ROOT/dist" && yalc publish) || fail "jsonfb yalc 发布失败"
(cd "$PROJECT" && yalc add jsonfb && npm install --no-audit --no-fund) \
  || fail "真实 jsonfb 消费端依赖安装失败"

EXPRESS_MAJOR="$(node -p "require('$PROJECT/node_modules/express/package.json').version.split('.')[0]")"
[ "$EXPRESS_MAJOR" = "4" ] || fail "测试工程必须使用 Express 4，当前主版本为 $EXPRESS_MAJOR"
node -e "const j=require('$PROJECT/node_modules/jsonfb');if(typeof j.parse!=='function')process.exit(1)" \
  || fail "消费端未正确安装 yalc jsonfb"
pass "真实 yalc jsonfb 和 Express 4 已安装到独立消费端"

step 3 "真实 HTTP 黑盒测试"
LOG_FILE="$(mktemp)"

if command -v timeout >/dev/null 2>&1; then
  (cd "$PROJECT" && timeout "$TEST_TIMEOUT" node --test) >"$LOG_FILE" 2>&1
  TEST_EXIT=$?
elif command -v gtimeout >/dev/null 2>&1; then
  (cd "$PROJECT" && gtimeout "$TEST_TIMEOUT" node --test) >"$LOG_FILE" 2>&1
  TEST_EXIT=$?
else
  (cd "$PROJECT" && node --test) >"$LOG_FILE" 2>&1 &
  TEST_PID=$!
  (
    sleep "$TEST_TIMEOUT"
    kill -TERM "$TEST_PID" 2>/dev/null
  ) &
  WATCH_PID=$!
  wait "$TEST_PID"
  TEST_EXIT=$?
  kill "$WATCH_PID" >/dev/null 2>&1
  wait "$WATCH_PID" 2>/dev/null
fi

cat "$LOG_FILE"
[ "$TEST_EXIT" -eq 0 ] || fail "真实 HTTP 黑盒测试失败或超时"
grep -Eq '(^| )fail 0$' "$LOG_FILE" || fail "测试汇总未确认 fail 0"
grep -Eq '(^| )tests [1-9][0-9]*$' "$LOG_FILE" || fail "没有执行到测试用例"
pass "Express 4 路由注入、幂等与热更新全部通过"
