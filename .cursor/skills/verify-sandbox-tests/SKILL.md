---
name: verify-sandbox-tests
description: 逐步自动化验证 jsonfb 前置沙箱（lib/sandbox）的测试链路并逐项核对结果：包结构静态校验 → yalc 发布 → 消费端链接 → 链接产物校验 → node --test 零失败/无泄漏 → 独立 mock 服务健康检查；每步输出 PASS/FAIL 且任一步失败即非零退出。Use when verifying or validating the jsonfb sandbox tests, after changing lib/sandbox or test/ projects, or when the user asks to 跑/验证沙箱测试、确认 yalc 发布与链接是否可用、逐步检查每个结果。
---

# 验证前置沙箱测试链路（verify-sandbox-tests）

对 jsonfb 仓库的前置沙箱（`lib/sandbox`）测试做端到端、逐步、可重复的验证。每一步独立判定 PASS/FAIL，任一步失败立即以非零码退出，便于人工或 CI 快速定位。

配套规则：`.cursor/rules/front-sandbox.mdc`（沙箱实现约束）与 `.cursor/rules/sandbox-test.mdc`（测试标准）。本 skill 负责「自动跑这套验证并核对每个结果」。

## 快速开始

在 jsonfb 仓库内运行脚本（首选）：

```bash
bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh
```

脚本会自动定位包根目录、消费端 `test/sandbox-e2e/` 与 mock 服务 `test/remote-mock-server/`，依次执行 6 个步骤。

## 脚本做的 6 件事

| 步骤 | 校验内容 | PASS 含义 |
| --- | --- | --- |
| 1 | `package.json` 的 `files` 含 `lib/sandbox`；`index.js` 加载 `./lib/sandbox`（副作用启动，按设计不对外导出） | 发布产物不会丢失沙箱、import 即触发轮询 |
| 2 | `yalc publish` 到本地 store | 发布成功 |
| 3 | 消费端 `yalc add json-bigint && npm install` | 真实链接成功（非相对路径） |
| 4 | 链接后 `require('json-bigint/lib/sandbox')` 导出齐全；`require('json-bigint')` 的 `parse/stringify` 可用（`sandbox` 按设计不对外导出） | 沙箱随包发出且深路径可被任意项目 require |
| 5 | `node --test` 全量；退出码 0 且未超时 | 用例全绿、进程干净退出（无泄漏/未关服务/定时器已 unref） |
| 6 | `test/remote-mock-server` 可独立 `node bin/start.js` 且 `/health` 正常 | 远程代码服务可独立运行 |

## 可选开关（环境变量）

```bash
# 已链接，只做校验+测试（跳过发布/链接）
SKIP_PUBLISH=1 bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh

# 跳过独立服务健康检查
SKIP_SERVER=1 bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh

# 自定义包根目录 / 服务端口 / 测试超时秒数
JSONFB_ROOT=/path/to/jsonfb MOCK_PORT=4600 TEST_TIMEOUT=240 \
  bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh
```

无泄漏判定依赖 `timeout`/`gtimeout`（存在时启用）：测试若在 `TEST_TIMEOUT` 内未结束判为 FAIL。macOS 可 `brew install coreutils` 获得 `gtimeout`；缺省时退回仅以退出码判定。

## 失败时怎么读结果

- 步骤 1 FAIL：去 [package.json](../../../package.json) 把 `lib/sandbox` 加进 `files`，并确认 [index.js](../../../index.js) 有 `require('./lib/sandbox')`（前置沙箱靠该副作用启动；按设计不对外导出 `sandbox` 句柄）。
- 步骤 3 FAIL：检查 `yalc` 是否安装、网络是否可访问 npm registry（`bignumber.js` 需安装）。
- 步骤 4 FAIL：通常是 `files` 漏发或深路径不可达——回到步骤 1。
- 步骤 5 FAIL：脚本会打印完整 `node --test` 输出，定位具体失败用例；若为超时，按 `sandbox-test.mdc` 检查服务是否在 `after` 中关闭、`stopRiskCodePolling()` 是否调用、定时器是否 `unref()`。
- 步骤 6 FAIL：查看 `/tmp/jsonfb_mock.log`，常见为端口被占用（改 `MOCK_PORT`）。

## 无脚本时的手动核对清单

若脚本不可用（例如环境差异），按序手动执行并逐项核对，任一不过即停：

```
- [ ] 1 包结构：files 含 lib/sandbox；index.js 有 require('./lib/sandbox')（按设计不对外导出 sandbox）
- [ ] 2 cd <pkg> && yalc publish 成功
- [ ] 3 cd test/sandbox-e2e && yalc add json-bigint && npm install 成功
- [ ] 4 require('json-bigint/lib/sandbox') 导出齐全；require('json-bigint').parse/stringify 可用（sandbox 不对外导出）
- [ ] 5 cd test/sandbox-e2e && node --test → fail 0、退出码 0、无挂起
- [ ] 6 cd test/remote-mock-server && PORT=4599 node bin/start.js → /health 返回 {ok:true}
```
