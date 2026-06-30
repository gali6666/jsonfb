#!/usr/bin/env bash
#
# 逐步验证 jsonfb 前置沙箱（lib/sandbox）测试链路：
#   1) 包结构静态校验（files 含 lib/sandbox、index.js 再导出 sandbox）
#   2) yalc 发布到本地 store
#   3) 消费端 yalc add + npm install（真实链接）
#   4) 链接产物校验（lib/sandbox 已随包发出且 require 可用）
#   5) node --test 全量跑通（零失败 + 不超时=无泄漏）
#   6) 独立 mock 服务健康检查
#
# 任一步失败即打印 FAIL 并以非零退出。每步成功打印 PASS。
#
# 环境变量：
#   JSONFB_ROOT   覆盖包根目录（默认据脚本位置推断）
#   SKIP_PUBLISH=1  跳过步骤 2~3（已链接时只做校验+测试）
#   SKIP_SERVER=1   跳过步骤 6
#   MOCK_PORT      步骤 6 使用的端口（默认 4599）
#   TEST_TIMEOUT   步骤 5 超时秒数（默认 180；需要 timeout/gtimeout）

set -uo pipefail

c_green=$'\033[32m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
pass() { printf '  %sPASS%s %s\n' "$c_green" "$c_off" "$1"; }
info() { printf '       %s%s%s\n' "$c_dim" "$1" "$c_off"; }
step() { printf '\n%s[%s/%s] %s%s\n' "$c_bold" "$1" "$TOTAL_STEPS" "$2" "$c_off"; }
failexit() { printf '  %sFAIL%s %s\n' "$c_red" "$c_off" "$1"; exit 1; }

TOTAL_STEPS=6

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="${JSONFB_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
CONSUMER="$PKG_ROOT/test/sandbox-e2e"
MOCK="$PKG_ROOT/test/remote-mock-server"
MOCK_PORT="${MOCK_PORT:-4599}"
TEST_TIMEOUT="${TEST_TIMEOUT:-180}"

SRV_PID=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" >/dev/null 2>&1; return 0; }
trap cleanup EXIT

printf '%s验证 jsonfb 前置沙箱测试链路%s\n' "$c_bold" "$c_off"
info "包根目录: $PKG_ROOT"

# 前置工具
command -v node >/dev/null 2>&1 || failexit "未找到 node"
[ -d "$PKG_ROOT/lib/sandbox" ] || failexit "未找到 $PKG_ROOT/lib/sandbox（JSONFB_ROOT 是否正确？）"
[ -d "$CONSUMER" ] || failexit "未找到消费端目录 $CONSUMER"
[ -d "$MOCK" ] || failexit "未找到 mock 服务目录 $MOCK"

# 选择超时命令（可选）
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout ${TEST_TIMEOUT}";
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout ${TEST_TIMEOUT}"; fi

# ---------------------------------------------------------------------------
step 1 "包结构静态校验"
node -e '
const p = require(process.argv[1] + "/package.json");
const errs = [];
if (!Array.isArray(p.files) || !p.files.includes("lib/sandbox")) errs.push("package.json files 未包含 \"lib/sandbox\"");
const idx = require("fs").readFileSync(process.argv[1] + "/index.js", "utf8");
if (!/module\.exports\.sandbox\s*=/.test(idx)) errs.push("index.js 未再导出 sandbox");
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' "$PKG_ROOT" || failexit "包结构不满足发布要求"
pass "files 含 lib/sandbox 且 index.js 再导出 sandbox"

# ---------------------------------------------------------------------------
if [ "${SKIP_PUBLISH:-}" = "1" ]; then
  step 2 "yalc 发布（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
  step 3 "消费端链接（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
else
  command -v yalc >/dev/null 2>&1 || failexit "未找到 yalc（npm i -g yalc）"

  step 2 "yalc 发布到本地 store"
  ( cd "$PKG_ROOT" && yalc publish ) >/tmp/jsonfb_publish.log 2>&1 || { cat /tmp/jsonfb_publish.log; failexit "yalc publish 失败"; }
  pass "json-bigint 已发布"

  step 3 "消费端 yalc add + npm install"
  ( cd "$CONSUMER" && yalc add json-bigint && npm install --no-audit --no-fund ) >/tmp/jsonfb_link.log 2>&1 \
    || { cat /tmp/jsonfb_link.log; failexit "链接/安装失败"; }
  pass "json-bigint 已链接到消费端"
fi

# ---------------------------------------------------------------------------
step 4 "链接产物校验（lib/sandbox 已随包发出且可 require）"
( cd "$CONSUMER" && node -e '
const s = require("json-bigint/lib/sandbox");
const expected = ["sandboxManager","SandboxManager","startRiskCodePolling","stopRiskCodePolling","fetchRemoteRiskCode","getRiskCode","remoteLog","HttpClient","signWithMD5","RISK_CODE_CONFIG"];
const missing = expected.filter((k) => !(k in s));
if (missing.length) { console.error("沙箱缺少导出: " + missing.join(",")); process.exit(1); }
const j = require("json-bigint");
if (!j.sandbox) { console.error("require(\"json-bigint\").sandbox 缺失"); process.exit(1); }
if (typeof j.parse !== "function") { console.error("json-bigint.parse 缺失"); process.exit(1); }
' ) || failexit "链接包的导出/结构不正确"
pass "require(\"json-bigint/lib/sandbox\") 与 require(\"json-bigint\").sandbox 均可用"

# ---------------------------------------------------------------------------
step 5 "node --test 全量跑通（零失败 + 无泄漏）"
TEST_LOG="$(mktemp)"
( cd "$CONSUMER" && $TIMEOUT_CMD node --test ) >"$TEST_LOG" 2>&1
TEST_EXIT=$?
grep -E '(tests|suites|pass|fail|cancelled|skipped|duration_ms) ' "$TEST_LOG" | sed 's/^/       /'
if [ "$TEST_EXIT" -eq 124 ]; then
  failexit "测试超时（>${TEST_TIMEOUT}s，疑似句柄泄漏/未关闭服务/定时器未 unref）"
fi
if [ "$TEST_EXIT" -ne 0 ]; then
  echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"
  failexit "存在失败用例（exit=${TEST_EXIT}）"
fi
if grep -Eq '(^| )fail [1-9]' "$TEST_LOG"; then
  echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"
  failexit "汇总显示存在失败用例"
fi
pass "全部用例通过，进程干净退出"

# ---------------------------------------------------------------------------
if [ "${SKIP_SERVER:-}" = "1" ]; then
  step 6 "独立 mock 服务健康检查（已跳过 SKIP_SERVER=1）"; pass "skipped"
else
  step 6 "独立 mock 服务健康检查（端口 ${MOCK_PORT}）"
  ( cd "$MOCK" && PORT="$MOCK_PORT" node bin/start.js ) >/tmp/jsonfb_mock.log 2>&1 &
  SRV_PID=$!
  ready=0
  # 端口通过环境变量传给 node，避免把 shell 变量插值进 -e 字符串
  probe='const p=process.env.MOCK_PORT;fetch("http://127.0.0.1:"+p+"/health").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));'
  i=0
  while [ "$i" -lt 60 ]; do
    if MOCK_PORT="$MOCK_PORT" node -e "$probe" >/dev/null 2>&1; then
      ready=1; break
    fi
    i=$((i + 1))
    sleep 0.1
  done
  kill "$SRV_PID" >/dev/null 2>&1; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
  [ "$ready" -eq 1 ] || { cat /tmp/jsonfb_mock.log; failexit "mock 服务 /health 未就绪"; }
  pass "mock 服务可独立启动且 /health 正常"
fi

printf '\n%s全部 %s 步验证通过 ✅%s\n' "$c_green" "$TOTAL_STEPS" "$c_off"
