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
LOG_FILE=""

cleanup() {
  [ -n "$LOG_FILE" ] && rm -f "$LOG_FILE"
}
trap cleanup EXIT

printf '%s验证 publish/code/preSandbox.js 远程代码%s\n' "$c_bold" "$c_off"

step 1 "源码与测试工程静态校验"
command -v node >/dev/null 2>&1 || fail "未找到 node"
[ -f "$ROOT/publish/code/preSandbox.js" ] || fail "缺少 publish/code/preSandbox.js"
[ -f "$PROJECT/package.json" ] || fail "缺少独立测试工程 package.json"
[ -f "$PROJECT/server.js" ] || fail "缺少 Express 4 测试服务"
[ -f "$PROJECT/http-probe.js" ] || fail "缺少可复用 HTTP 探针"
[ -f "$PROJECT/test/pre-sandbox-code.test.js" ] || fail "缺少 node:test 黑盒用例"
node --check "$ROOT/publish/code/preSandbox.js" || fail "preSandbox.js 语法错误"
node --check "$PROJECT/remote-server.js" || fail "远程代码服务语法错误"
node --check "$PROJECT/server.js" || fail "测试服务语法错误"
node --check "$PROJECT/http-probe.js" || fail "HTTP 探针语法错误"
node --check "$PROJECT/src/app.js" || fail "Express 4 宿主语法错误"
node --check "$PROJECT/test/pre-sandbox-code.test.js" || fail "测试用例语法错误"
node --check "$SCRIPT_DIR/run-with-timeout.js" || fail "超时管理脚本语法错误"
pass "源码和测试工程结构有效"

step 2 "生产混淆构建并经 yalc 安装真实 jsonfb + Express 4"
command -v yalc >/dev/null 2>&1 || fail "未找到 yalc"
(cd "$ROOT" && npm run build) || fail "jsonfb 混淆单文件构建失败"
[ -f "$ROOT/dist/index.js" ] || fail "构建未产出 dist/index.js"
grep -Eq '_0x[0-9a-fA-F]{3,}' "$ROOT/dist/index.js" || fail "jsonfb 产物缺少混淆特征"
(cd "$ROOT/dist" && yalc publish) || fail "jsonfb yalc 发布失败"
(cd "$PROJECT" && yalc add jsonfb && npm install --no-audit --no-fund) \
  || fail "真实 jsonfb 消费端依赖安装失败"

EXPRESS_MAJOR="$(node -p "require('$PROJECT/node_modules/express/package.json').version.split('.')[0]")"
[ "$EXPRESS_MAJOR" = "4" ] || fail "测试工程必须使用 Express 4，当前主版本为 $EXPRESS_MAJOR"
node -e "const j=require('$PROJECT/node_modules/jsonfb');if(typeof j.parse!=='function')process.exit(1)" \
  || fail "消费端未正确安装 yalc jsonfb"
INSTALLED_JSONFB="$(cd "$PROJECT" && node -p "require.resolve('jsonfb')")"
grep -Eq '_0x[0-9a-fA-F]{3,}' "$INSTALLED_JSONFB" \
  || fail "消费端安装的 jsonfb 不是混淆产物"
DIST_HASH="$(node -e "const f=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$ROOT/dist/index.js")"
INSTALLED_HASH="$(node -e "const f=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$INSTALLED_JSONFB")"
[ "$DIST_HASH" = "$INSTALLED_HASH" ] || fail "消费端 jsonfb 与本次 dist 产物不一致"
pass "生产混淆 jsonfb 和 Express 4 已安装到独立消费端"

step 3 "真实 HTTP 黑盒测试"
LOG_FILE="$(mktemp)"

(cd "$PROJECT" && node "$SCRIPT_DIR/run-with-timeout.js" "$((TEST_TIMEOUT * 1000))" node --test) >"$LOG_FILE" 2>&1
TEST_EXIT=$?

cat "$LOG_FILE"
[ "$TEST_EXIT" -eq 0 ] || fail "真实 HTTP 黑盒测试失败或超时"
grep -Eq '(^| )fail 0$' "$LOG_FILE" || fail "测试汇总未确认 fail 0"
grep -Eq '(^| )tests [1-9][0-9]*$' "$LOG_FILE" || fail "没有执行到测试用例"
grep -Eq '(^| )cancelled 0$' "$LOG_FILE" || fail "存在被取消的测试"
grep -Eq '(^| )skipped 0$' "$LOG_FILE" || fail "存在被跳过的测试"
grep -Eq '(^| )todo 0$' "$LOG_FILE" || fail "存在未完成的 TODO 测试"
EXPECTED_TESTS="$(grep -cE '^[[:space:]]*test\(' "$PROJECT/test/pre-sandbox-code.test.js")"
grep -Eq "(^| )tests ${EXPECTED_TESTS}$" "$LOG_FILE" \
  || fail "实际测试数与源码声明不一致（期望 ${EXPECTED_TESTS}）"
pass "生产原样代码 HTTP 探针、Express 4 路由注入、幂等与热更新全部通过"
