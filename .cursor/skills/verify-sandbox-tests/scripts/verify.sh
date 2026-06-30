#!/usr/bin/env bash
#
# 逐步验证 jsonfb 前置沙箱（lib/sandbox）测试链路（单文件打包发布）：
#   1) 包结构静态校验 + 沙箱 0 依赖源码扫描（lib/sandbox 仅 Node 内置/相对路径）
#   2) 双构建（非混淆+混淆）：零依赖/单文件/混淆有效性校验后 yalc 发布
#   3) 消费端 yalc add + npm install（测试运行端 sandbox-e2e + 真实消费方宿主 consumer-app）
#   4) 链接产物校验（单文件 + require('jsonfb').sandbox 导出齐全 + 负向子路径不可用）
#   5) node --test 全量跑通（零失败 + skipped/todo=0 + 套件齐全 + 不超时=无泄漏）
#   6) 独立远程服务（基于 Express）健康检查
#
# 零依赖双重保险（front-sandbox.mdc 头号铁律）：
#   - 步骤 1 静态扫描 lib/sandbox 源码的 require（仅允许 Node 内置 + 相对路径）；
#   - 步骤 2 额外对「非混淆打包产物」做外部 require 核对（仅允许 Node 内置 + bignumber.js），
#     并对「混淆产物」证明混淆确实发生——往沙箱里塞 npm 包会在这两层同时暴露。
#
# 测试架构（两类 server）：
#   - Server 1 = test/remote-mock-server（Express）：远程风控服务，可起多实例（不同端口）。
#   - Server 2 = test/consumer-app（Express）：真实业务宿主，由 e2e 以子进程 fork，
#                require('jsonfb') 后内嵌前置沙箱「自动」轮询拉取 + 上报；步骤 5 的
#                consumer-e2e.test.js 编排并黑盒观测 Server 1 收到的请求/回调/日志。
#
# 注：远程测试服务与消费方宿主均基于 Express，脚本会在步骤 5/6 前自动安装其依赖；
#     被测包 lib/sandbox 仍 0 依赖。
#
# 任一步失败即打印 FAIL 并以非零退出。每步成功打印 PASS。
#
# 环境变量：
#   JSONFB_ROOT   覆盖包根目录（默认据脚本位置推断）
#   SKIP_PUBLISH=1  跳过步骤 2~3（已链接时只做校验+测试）
#   SKIP_SERVER=1   跳过步骤 6
#   MOCK_PORT      步骤 6 使用的端口（默认 4599）
#   TEST_TIMEOUT   步骤 5 超时秒数（默认 180；无 timeout/gtimeout 时自动用纯 bash 兜底强制限时）

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
CONSUMER_APP="$PKG_ROOT/test/consumer-app"
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
[ -d "$CONSUMER" ] || failexit "未找到测试运行端目录 $CONSUMER"
[ -d "$CONSUMER_APP" ] || failexit "未找到真实消费方宿主目录 $CONSUMER_APP"
[ -d "$MOCK" ] || failexit "未找到 mock 服务目录 $MOCK"

# 超时机制：优先 GNU timeout/gtimeout；都没有时退回纯 bash 实现（不依赖任何外部命令）。
# 两条路径都以退出码 124 表示超时（与 GNU timeout 一致），故下游判定统一——
# 这样「无泄漏」是硬保证：测试若因句柄泄漏挂住，必在 TEST_TIMEOUT 内被强杀并判 FAIL，
# 而不是无限挂起（stock macOS 默认无 timeout/gtimeout）。
TIMEOUT_KIND="portable"
if command -v timeout >/dev/null 2>&1; then TIMEOUT_KIND="timeout";
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_KIND="gtimeout"; fi

# 纯 bash 超时兜底：超时后连同其派生子进程（node --test 的 per-file 子进程、consumer-app 的
# fork 等）整组终止；命令正常结束则透传其退出码。借 `set -m` 让后台任务自成进程组，
# 用负 PID 实现整组 kill，绝不波及本脚本进程组。
run_with_timeout() {
  local secs="$1"; shift
  local flag; flag="$(mktemp)"; rm -f "$flag"
  local m_was_on=0; case "$-" in *m*) m_was_on=1;; esac
  set -m
  "$@" &
  local cmd_pid=$!
  (
    sleep "$secs"
    : > "$flag"
    kill -TERM -"$cmd_pid" 2>/dev/null
    sleep 3
    kill -KILL -"$cmd_pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local watch_pid=$!
  local code=0
  wait "$cmd_pid" 2>/dev/null || code=$?
  kill -TERM -"$watch_pid" 2>/dev/null
  wait "$watch_pid" 2>/dev/null
  [ "$m_was_on" -eq 0 ] && set +m
  if [ -f "$flag" ]; then rm -f "$flag"; return 124; fi
  rm -f "$flag"
  return "$code"
}

# 在 CONSUMER 目录、开启沙箱导出（子进程继承）下限时跑 node --test，输出写入 $1。
# 三条路径统一：超时=退出码 124。
run_node_test() {
  local logf="$1"
  case "$TIMEOUT_KIND" in
    timeout)  ( cd "$CONSUMER" && JSONFB_EXPORTS_SANDBOX=true timeout "$TEST_TIMEOUT" node --test ) >"$logf" 2>&1 ;;
    gtimeout) ( cd "$CONSUMER" && JSONFB_EXPORTS_SANDBOX=true gtimeout "$TEST_TIMEOUT" node --test ) >"$logf" 2>&1 ;;
    *)        run_with_timeout "$TEST_TIMEOUT" bash -c 'cd "$1" && JSONFB_EXPORTS_SANDBOX=true exec node --test' _ "$CONSUMER" >"$logf" 2>&1 ;;
  esac
}

# 远程测试服务基于 Express：确保其依赖已安装（步骤 5 的 e2e 与步骤 6 的独立启动都依赖它）
ensure_mock_deps() {
  if [ ! -d "$MOCK/node_modules/express" ]; then
    command -v npm >/dev/null 2>&1 || failexit "未找到 npm（无法为 remote-mock-server 安装 express）"
    ( cd "$MOCK" && npm install --no-audit --no-fund ) >/tmp/jsonfb_mock_install.log 2>&1 \
      || { cat /tmp/jsonfb_mock_install.log; failexit "remote-mock-server 依赖（express）安装失败"; }
  fi
}

# ---------------------------------------------------------------------------
step 1 "包结构静态校验 + 沙箱 0 依赖源码扫描"
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
// 双构建零依赖校验依赖「非混淆」单文件产物
if (!p.scripts || !p.scripts["build:notobf"]) errs.push("package.json 缺少 build:notobf 脚本（双构建零依赖校验需要）");
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' "$PKG_ROOT" || failexit "包结构不满足发布要求"
pass "index.js 加载并暴露 .sandbox，rollup/obfuscate/build:notobf 构建就绪"

# 1b 沙箱 0 依赖源码扫描（front-sandbox.mdc 头号铁律）：
#     lib/sandbox 的所有 require 只能是 Node 内置或相对路径；禁止第三方包、宿主别名、
#     requireMainProcessModule。扫描前剥离注释，避免示例/反例注释造成误判。
node -e '
const fs = require("fs");
const path = require("path");
const builtins = new Set(require("module").builtinModules);
const sbx = path.join(process.argv[1], "lib", "sandbox");
const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const bad = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) { walk(fp); continue; }
    if (!e.name.endsWith(".js")) continue;
    const rel = path.relative(sbx, fp);
    const code = strip(fs.readFileSync(fp, "utf8"));
    if (/requireMainProcessModule\s*\(/.test(code)) bad.push(rel + " -> requireMainProcessModule（禁止主进程依赖）");
    const re = /require\(\s*(["\x27])([^"\x27]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      const id = m[2];
      const ok = id.startsWith(".") || builtins.has(id) || builtins.has(id.replace(/^node:/, ""));
      if (!ok) bad.push(rel + " -> require(\"" + id + "\")（第三方/宿主别名依赖）");
    }
  }
};
walk(sbx);
if (bad.length) { console.error("沙箱出现非法依赖：\n" + bad.join("\n")); process.exit(1); }
' "$PKG_ROOT" || failexit "lib/sandbox 违反 0 依赖约束（front-sandbox.mdc 头号铁律）"
pass "lib/sandbox 源码 0 第三方依赖：require 仅 Node 内置/相对路径，无 requireMainProcessModule"

# ---------------------------------------------------------------------------
if [ "${SKIP_PUBLISH:-}" = "1" ]; then
  step 2 "yalc 发布（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
  step 3 "消费端链接（已跳过 SKIP_PUBLISH=1）"; pass "skipped"
else
  command -v yalc >/dev/null 2>&1 || failexit "未找到 yalc（npm i -g yalc）"

  step 2 "双构建（非混淆+混淆）：零依赖/单文件/混淆有效性校验后 yalc 发布"
  NOTOBF="$(mktemp)"; OBF="$(mktemp)"

  # 2a 先产出「可读」非混淆单文件，便于静态核对外部依赖与单文件性
  ( cd "$PKG_ROOT" && npm run build:notobf ) >/tmp/jsonfb_publish.log 2>&1 || { cat /tmp/jsonfb_publish.log; failexit "非混淆构建（build:notobf）失败"; }
  [ -f "$PKG_ROOT/dist/index.js" ] || failexit "非混淆构建未产出 dist/index.js"
  [ ! -d "$PKG_ROOT/dist/lib" ] || failexit "dist 出现 lib/ 子目录：沙箱未被打进单文件（违反单文件契约）"
  cp "$PKG_ROOT/dist/index.js" "$NOTOBF"
  # 非混淆 bundle 的「外部 require」只允许 Node 内置 + bignumber.js；
  # 任何其它第三方都意味着沙箱/包混入了依赖（rollup 把裸标识符按 external 保留，故必现形）。
  node -e '
  const fs = require("fs");
  const builtins = new Set(require("module").builtinModules);
  const allow = new Set(["bignumber.js"]);
  const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const code = strip(fs.readFileSync(process.argv[1], "utf8"));
  const re = /require\(\s*(["\x27])([^"\x27]+)\1\s*\)/g;
  const ext = new Set();
  let m;
  while ((m = re.exec(code))) { const id = m[2]; if (!id.startsWith(".")) ext.add(id); }
  const bad = [...ext].filter((id) => !builtins.has(id.replace(/^node:/, "")) && !allow.has(id));
  if (bad.length) { console.error("打包产物混入第三方依赖：" + bad.join(", ")); process.exit(1); }
  ' "$NOTOBF" || { rm -f "$NOTOBF" "$OBF"; failexit "打包产物含非法第三方依赖（沙箱 0 依赖被破坏）"; }

  # 2b 产出混淆单文件（真正发布物），并证明「混淆确实发生」且仍是单文件
  ( cd "$PKG_ROOT" && npm run build ) >>/tmp/jsonfb_publish.log 2>&1 || { cat /tmp/jsonfb_publish.log; failexit "混淆构建（build）失败"; }
  [ -f "$PKG_ROOT/dist/index.js" ] || failexit "混淆构建未产出 dist/index.js"
  [ ! -d "$PKG_ROOT/dist/lib" ] || failexit "dist 出现 lib/ 子目录：违反单文件契约"
  cp "$PKG_ROOT/dist/index.js" "$OBF"
  if cmp -s "$NOTOBF" "$OBF"; then rm -f "$NOTOBF" "$OBF"; failexit "混淆产物与非混淆产物完全相同：混淆未生效"; fi
  grep -Eq '_0x[0-9a-fA-F]{3,}' "$OBF" || { rm -f "$NOTOBF" "$OBF"; failexit "混淆产物缺少混淆特征（_0x 十六进制标识符）：混淆未生效"; }
  rm -f "$NOTOBF" "$OBF"
  pass "零依赖（外部 require 仅 Node 内置+bignumber.js）+ 单文件 + 混淆生效"

  ( cd "$PKG_ROOT/dist" && yalc publish ) >>/tmp/jsonfb_publish.log 2>&1 || { cat /tmp/jsonfb_publish.log; failexit "yalc 发布失败"; }
  pass "jsonfb 已构建为单文件并发布"

  step 3 "消费端链接（测试运行端 sandbox-e2e + 真实消费方宿主 consumer-app）"
  ( cd "$CONSUMER" && yalc add jsonfb && npm install --no-audit --no-fund ) >/tmp/jsonfb_link.log 2>&1 \
    || { cat /tmp/jsonfb_link.log; failexit "测试运行端（sandbox-e2e）链接/安装失败"; }
  # 真实消费方宿主（Server 2）：同样经 yalc 链接 jsonfb，并安装其宿主框架 express
  ( cd "$CONSUMER_APP" && yalc add jsonfb && npm install --no-audit --no-fund ) >/tmp/jsonfb_link_app.log 2>&1 \
    || { cat /tmp/jsonfb_link_app.log; failexit "真实消费方宿主（consumer-app）链接/安装失败"; }
  pass "jsonfb 已链接到 sandbox-e2e 与 consumer-app（后者含 express 宿主）"
fi

# ---------------------------------------------------------------------------
step 4 "链接产物校验（单文件 + require('jsonfb').sandbox 导出齐全）"
# 沙箱 API 仅在 JSONFB_EXPORTS_SANDBOX 为真时挂到 .sandbox（正式使用不导出），测试链路需显式开启
( cd "$CONSUMER" && JSONFB_EXPORTS_SANDBOX=true node -e '
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

# 4b 负向子路径：单文件发布后不应再能 require('jsonfb/lib/sandbox')（子路径已被打进单文件）
( cd "$CONSUMER" && node -e '
try {
  require("jsonfb/lib/sandbox");
  console.error("不应存在的子路径 jsonfb/lib/sandbox 仍可 require（单文件契约被破坏）");
  process.exit(1);
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND") process.exit(0);
  console.error("require(jsonfb/lib/sandbox) 抛出非 MODULE_NOT_FOUND：" + (e && e.message));
  process.exit(1);
}
' ) || failexit "单文件契约：jsonfb/lib/sandbox 子路径不应可用"
pass "负向子路径校验：require(\"jsonfb/lib/sandbox\") 已不可用（单文件契约）"

# ---------------------------------------------------------------------------
# e2e 通过 helpers/bootstrap 进程内 require remote-mock-server（基于 Express），
# 故跑测试前必须先确保该服务的依赖（express）已安装。
ensure_mock_deps

# consumer-e2e.test.js 会 fork test/consumer-app（真实 Express 宿主，经 yalc 链接 jsonfb）。
# 跑测试前确认其依赖已就绪，否则给出明确提示（而非难懂的 fork 失败）。
if [ ! -d "$CONSUMER_APP/node_modules/express" ] || [ ! -d "$CONSUMER_APP/node_modules/jsonfb" ]; then
  failexit "consumer-app 未就绪（缺 express 或未链接 jsonfb）。请去掉 SKIP_PUBLISH 重跑，或先在 $CONSUMER_APP 执行 yalc add jsonfb && npm install"
fi

step 5 "node --test 全量跑通（零失败 + 无泄漏）"
TEST_LOG="$(mktemp)"
# 限时跑测试：沙箱 API 仅在 JSONFB_EXPORTS_SANDBOX 为真时导出，子测试进程会继承该环境变量。
# 超时（句柄泄漏/未关服务/定时器未 unref 导致挂住）统一以退出码 124 体现。
run_node_test "$TEST_LOG"
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

# 5b 覆盖闸门：防「退出码 0 但覆盖被悄悄削减」——
#    断言确有用例执行、无 skipped/todo、且执行到的套件数不少于「含 describe 的测试文件数」
#    （任一测试文件被整体漏跑都会让 suites 下探到阈值以下）。
metric() { awk -v k="$1" '{for(i=1;i<NF;i++) if($i==k && $(i+1) ~ /^[0-9]+$/) v=$(i+1)} END{print v+0}' "$TEST_LOG"; }
EXPECTED_SUITES="$(grep -rlE 'describe\(' "$CONSUMER/test" 2>/dev/null | wc -l | tr -d ' ')"
N_TESTS="$(metric tests)"; N_SKIP="$(metric skipped)"; N_TODO="$(metric todo)"; N_SUITES="$(metric suites)"
# 注意：变量后紧跟全角标点时必须用 ${} 包裹，否则 set -u 下 bash 会把多字节首字节并入变量名而误报 unbound
info "tests=${N_TESTS} suites=${N_SUITES} skipped=${N_SKIP} todo=${N_TODO}（期望 suites>=${EXPECTED_SUITES}）"
[ "$N_TESTS" -gt 0 ] || { echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"; failexit "未统计到任何用例（tests=0）：测试可能未被发现/执行"; }
[ "$N_SKIP" -eq 0 ] || { echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"; failexit "存在被跳过的用例（skipped=${N_SKIP}）：覆盖可能被悄悄削减"; }
[ "$N_TODO" -eq 0 ] || { echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"; failexit "存在 TODO 用例（todo=${N_TODO}）：覆盖不完整"; }
[ "$EXPECTED_SUITES" -gt 0 ] && [ "$N_SUITES" -ge "$EXPECTED_SUITES" ] || { echo "--------- node --test 输出 ---------"; cat "$TEST_LOG"; failexit "执行到的套件数（${N_SUITES}）少于含 describe 的测试文件数（${EXPECTED_SUITES}）：疑似有测试文件未被执行"; }
pass "全部用例通过且无遗漏（tests=${N_TESTS}, skipped=0, todo=0, suites>=${EXPECTED_SUITES}），进程干净退出"

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
