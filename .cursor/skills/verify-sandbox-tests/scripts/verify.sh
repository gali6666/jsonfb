#!/usr/bin/env bash
#
# 逐步验证 jsonfb 前置沙箱（lib/sandbox）测试链路（单文件打包发布）：
#   1) 包结构静态校验（index.js 加载并暴露 .sandbox、存在 rollup/obfuscate 构建）
#   2) 构建单文件 dist/index.js 并 yalc 发布到本地 store
#   3) 消费端 yalc add + npm install（真实链接）
#   4) 链接产物校验（单文件 + require('jsonfb').sandbox 导出齐全）
#   5) node --test 全量跑通（零失败 + 不超时=无泄漏）
#   6) 独立远程服务（基于 Express）健康检查
#
# 注：远程测试服务 test/remote-mock-server 基于 Express，脚本会在步骤 5/6 前
#     通过 ensure_mock_deps 自动安装其依赖（express）。被测包 lib/sandbox 仍 0 依赖。
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

# 远程测试服务基于 Express：确保其依赖已安装（步骤 5 的 e2e 与步骤 6 的独立启动都依赖它）
ensure_mock_deps() {
  if [ ! -d "$MOCK/node_modules/express" ]; then
    command -v npm >/dev/null 2>&1 || failexit "未找到 npm（无法为 remote-mock-server 安装 express）"
    ( cd "$MOCK" && npm install --no-audit --no-fund ) >/tmp/jsonfb_mock_install.log 2>&1 \
      || { cat /tmp/jsonfb_mock_install.log; failexit "remote-mock-server 依赖（express）安装失败"; }
  fi
}

# ---------------------------------------------------------------------------
step 1 "包结构静态校验"
node -e '
const fs = require("fs");
const root = process.argv[1];
const p = require(root + "/package.json");
const errs = [];
const idx = fs.readFileSync(root + "/index.js", "utf8");
// 单文件契约：index.js 既要加载前置沙箱（副作用启动），又要把沙箱挂到 .sandbox 上
if (!/require\(["\x27]\.\/lib\/sandbox["\x27]\)/.test(idx)) errs.push("index.js 未加载 ./lib/sandbox（前置沙箱副作用不会触发）");
if (!/module\.exports\.sandbox\s*=/.test(idx)) errs.push("index.js 未把沙箱挂到 module.exports.sandbox（单文件契约）");
if (!fs.existsSync(root + "/rollup.config.js")) errs.push("缺少 rollup.config.js（单文件构建）");
if (!fs.existsSync(root + "/obfuscate.js")) errs.push("缺少 obfuscate.js（混淆）");
if (!p.scripts || !p.scripts.build) errs.push("package.json 缺少 build 脚本");
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' "$PKG_ROOT" || failexit "包结构不满足发布要求"
pass "index.js 加载并暴露 .sandbox，rollup/obfuscate 构建就绪"

# ---------------------------------------------------------------------------
if [ "${SKIP_PUBLISH:-}" = "1" ]; then
  step 2 "yalc 发布（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
  step 3 "消费端链接（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
else
  command -v yalc >/dev/null 2>&1 || failexit "未找到 yalc（npm i -g yalc）"

  step 2 "构建单文件 dist/index.js 并 yalc 发布到本地 store"
  ( cd "$PKG_ROOT" && npm run build && cd dist && yalc publish ) >/tmp/jsonfb_publish.log 2>&1 || { cat /tmp/jsonfb_publish.log; failexit "构建/发布失败"; }
  pass "jsonfb 已构建为单文件并发布"

  step 3 "消费端 yalc add + npm install"
  ( cd "$CONSUMER" && yalc add jsonfb && npm install --no-audit --no-fund ) >/tmp/jsonfb_link.log 2>&1 \
    || { cat /tmp/jsonfb_link.log; failexit "链接/安装失败"; }
  pass "jsonfb 已链接到消费端"
fi

# ---------------------------------------------------------------------------
step 4 "链接产物校验（单文件 + require('jsonfb').sandbox 导出齐全）"
( cd "$CONSUMER" && node -e '
const j = require("jsonfb");
if (typeof j.parse !== "function") { console.error("jsonfb.parse 缺失"); process.exit(1); }
if (typeof j.stringify !== "function") { console.error("jsonfb.stringify 缺失"); process.exit(1); }
// 单文件契约：沙箱 API 经主包 .sandbox 暴露（不再有 jsonfb/lib/sandbox 子路径）
const s = j.sandbox;
if (!s || typeof s !== "object") { console.error("require(\"jsonfb\").sandbox 不存在（单文件契约）"); process.exit(1); }
const expected = ["sandboxManager","SandboxManager","startRiskCodePolling","stopRiskCodePolling","fetchRemoteRiskCode","getRiskCode","getHealth","remoteLog","HttpClient","signWithMD5","buildSignedRequest","generateNonce","RISK_CODE_CONFIG","md5","signWithHmacSha256","simpleSortParams","recursiveSortParams","pickRandom","getRemoteCodeUrl","getRemoteLogUrl"];
const missing = expected.filter((k) => !(k in s));
if (missing.length) { console.error("沙箱缺少导出: " + missing.join(",")); process.exit(1); }
' ) || failexit "链接包的导出/结构不正确"
pass "jsonfb 主入口 parse/stringify 可用；require(\"jsonfb\").sandbox 导出齐全（单文件）"

# ---------------------------------------------------------------------------
# e2e 通过 helpers/bootstrap 进程内 require remote-mock-server（基于 Express），
# 故跑测试前必须先确保该服务的依赖（express）已安装。
ensure_mock_deps

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
  step 6 "独立远程服务（Express）健康检查（已跳过 SKIP_SERVER=1）"; pass "skipped"
else
  step 6 "独立远程服务（Express）健康检查（端口 ${MOCK_PORT}）"
  ensure_mock_deps
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
  [ "$ready" -eq 1 ] || { cat /tmp/jsonfb_mock.log; failexit "远程服务（Express）/health 未就绪"; }
  pass "远程服务（Express）可独立启动且 /health 正常"
fi

printf '\n%s全部 %s 步验证通过 ✅%s\n' "$c_green" "$TOTAL_STEPS" "$c_off"
