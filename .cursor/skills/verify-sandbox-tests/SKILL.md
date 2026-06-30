---
name: verify-sandbox-tests
description: 逐步自动化验证 jsonfb 前置沙箱（lib/sandbox）的测试链路并逐项核对结果：包结构静态校验 + 沙箱 0 依赖源码扫描 → 双构建（非混淆+混淆）零依赖/单文件/混淆有效性校验后 yalc 发布 → 消费端链接 → 链接产物校验（含负向子路径） → node --test 零失败/skipped·todo=0/套件齐全/无泄漏 → 独立 mock 服务健康检查；每步输出 PASS/FAIL 且任一步失败即非零退出。Use when verifying or validating the jsonfb sandbox tests, after changing lib/sandbox or test/ projects, or when the user asks to 跑/验证沙箱测试、确认 0 依赖/混淆/单文件契约、确认 yalc 发布与链接是否可用、逐步检查每个结果。
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
| 1 | **包结构**：`index.js` 加载 `./lib/sandbox` 且挂到 `module.exports.sandbox`；存在 `rollup.config.js`/`obfuscate.js` 与 `build`/`build:notobf` 脚本。**沙箱 0 依赖源码扫描**：`lib/sandbox/**` 的 `require` 仅允许 Node 内置/相对路径，禁止第三方包、宿主别名、`requireMainProcessModule`（扫描前剥离注释，避免反例注释误判） | 单文件构建就绪、沙箱经主包 `.sandbox` 暴露、且源码层面 0 第三方依赖 |
| 2 | **双构建**：先 `npm run build:notobf` 产出可读单文件 → 核对外部 `require` 仅 `{Node 内置, bignumber.js}`（任何其它第三方=沙箱/包混入依赖）、且 `dist/` 无 `lib/` 子目录（单文件）；再 `npm run build` 产出混淆单文件 → 证明混淆确实发生（与非混淆产物不同、含 `_0x` 十六进制标识符）且仍是单文件；最后从 `dist/` `yalc publish` | 零依赖（产物层再次确认）+ 单文件 + 混淆生效 + 发布成功 |
| 3 | 测试运行端 `sandbox-e2e` 与真实消费方宿主 `consumer-app` 均 `yalc add jsonfb && npm install`（并为两个基于 Express 的服务安装 `express`） | 真实链接成功（非相对路径），远程服务与消费方宿主依赖就绪 |
| 4 | 链接后 `require('jsonfb')` 的 `parse/stringify` 可用、`require('jsonfb').sandbox` 导出齐全；**负向子路径**：`require('jsonfb/lib/sandbox')` 必须 `MODULE_NOT_FOUND` | 单文件随包发出、沙箱 API 经主包 `.sandbox` 可达、旧子路径确实消失 |
| 5 | `node --test` 全量；退出码 0、未超时；**覆盖闸门**：`tests>0`、`skipped=0`、`todo=0`、执行到的 `suites` ≥ 含 `describe` 的测试文件数（防「退出码 0 但某文件被整体漏跑/用例被悄悄跳过」） | 用例全绿且无遗漏、进程干净退出（无泄漏/未关服务/定时器已 unref） |
| 6 | `test/remote-mock-server`（Express）可独立 `node bin/start.js` 且 `/health` 正常 | 远程代码服务（真实 Express）可独立运行 |

测试架构（两类 server）：

- **Server 1** = `test/remote-mock-server`（Express）：远程风控服务，可起多实例（不同端口）模拟多地址。
- **Server 2** = `test/consumer-app`（Express）：真实业务宿主，由 `consumer-e2e.test.js` 以子进程 `fork` 拉起，`require('jsonfb')` 后内嵌前置沙箱「自动」轮询拉取 + 上报；测试以 Server 1 收到的请求/回调/日志作为「真实副作用」证据（黑盒）。步骤 5 已涵盖该用例，故 Server 2 必须先在步骤 3 完成链接/安装。

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

无泄漏判定为**硬保证**且不依赖外部命令：脚本优先用 `timeout`/`gtimeout`，二者都没有时（stock macOS 默认如此）自动退回**纯 bash 超时兜底**——测试若在 `TEST_TIMEOUT` 内未结束（句柄泄漏/未关服务/定时器未 `unref` 挂住），会连同其派生子进程被整组强杀并判 FAIL（退出码 124），不会无限挂起。`TEST_TIMEOUT` 可按机器性能调整（默认 180s）。

## 失败时怎么读结果

- 步骤 1 FAIL：
  - 结构类：确认 [index.js](../../../index.js) 既有 `require('./lib/sandbox')`（副作用启动），又有 `module.exports.sandbox = ...`（单文件契约）；并确认仓库存在 `rollup.config.js`/`obfuscate.js` 与 `build`/`build:notobf` 脚本。
  - **0 依赖类**：脚本会列出违规文件与具体 `require`（如 `sign.util.js -> require("lodash")`）。按 `front-sandbox.mdc` 头号铁律移除第三方/宿主别名依赖与 `requireMainProcessModule`，沙箱只能用 Node 内置 + 相对路径。
- 步骤 2 FAIL：看 `/tmp/jsonfb_publish.log`。
  - 构建报错：常见为 rollup 打包或 `obfuscate.js` 报错；确认 devDependencies（rollup/babel/javascript-obfuscator）已安装。
  - **「打包产物混入第三方依赖：X」**：非混淆产物里出现了 `bignumber.js` 以外的外部 `require`——说明沙箱/包引入了新依赖（即便源码扫描漏判也会在产物层兜住）。
  - **「混淆未生效」**：混淆产物与非混淆产物相同、或缺少 `_0x` 特征——检查 `obfuscate.js` 是否真正执行、`build` 是否包含 `node obfuscate.js`。
  - **「dist 出现 lib/ 子目录」**：沙箱没被打进单文件——检查 `rollup.config.js` 的 external 判定。
- 步骤 3 FAIL：检查 `yalc` 是否安装、网络是否可访问 npm registry（`bignumber.js` 需安装）。
- 步骤 4 FAIL：
  - 正向：通常是单文件未把沙箱挂到 `.sandbox`，或构建产物缺失——回到步骤 1/2。
  - **负向子路径**：若 `require('jsonfb/lib/sandbox')` 仍可加载，说明发布产物不是单文件（残留了 `lib/sandbox` 子路径）——回到步骤 2 检查打包/`dist` 的 `files`。
- 步骤 5 FAIL：脚本会打印完整 `node --test` 输出，定位具体失败用例。
  - 超时：按 `sandbox-test.mdc` 检查服务是否在 `after` 中关闭、`stopRiskCodePolling()` 是否调用、定时器是否 `unref()`。
  - **覆盖闸门**（`skipped/todo>0` 或 `suites` 不足）：有用例被 `.skip`/`.todo`，或某个测试文件被整体漏跑——补齐用例或确认所有 `*.test.js` 都被发现执行（脚本会打印 `tests/suites/skipped/todo` 实测值与期望阈值）。
- 步骤 6 FAIL：查看 `/tmp/jsonfb_mock.log`，常见为端口被占用（改 `MOCK_PORT`）或 `express` 未安装（脚本会在步骤 5 前用 `ensure_mock_deps` 自动安装，缺失时见 `/tmp/jsonfb_mock_install.log`）。

## 无脚本时的手动核对清单

若脚本不可用（例如环境差异），按序手动执行并逐项核对，任一不过即停：

```
- [ ] 1 包结构：index.js 有 require('./lib/sandbox') 且 module.exports.sandbox = ...；存在 rollup.config.js/obfuscate.js 与 build/build:notobf 脚本
- [ ] 1b 0 依赖：lib/sandbox/** 的 require 仅 Node 内置/相对路径，无第三方包/宿主别名/requireMainProcessModule（剥离注释后扫描）
- [ ] 2a cd <pkg> && npm run build:notobf → 非混淆单文件的外部 require 仅 {Node 内置, bignumber.js}，且 dist/ 无 lib/ 子目录
- [ ] 2b cd <pkg> && npm run build → 混淆产物 ≠ 非混淆产物、含 _0x 特征、仍为单文件；cd dist && yalc publish 成功
- [ ] 3 cd test/sandbox-e2e && yalc add jsonfb && npm install 成功；cd test/consumer-app && yalc add jsonfb && npm install 成功；cd test/remote-mock-server && npm install（装 express）成功
- [ ] 4 require('jsonfb').parse/stringify 可用；require('jsonfb').sandbox 导出齐全；require('jsonfb/lib/sandbox') 抛 MODULE_NOT_FOUND（负向子路径）
- [ ] 5 cd test/sandbox-e2e && node --test → fail 0、退出码 0、skipped/todo 0、suites ≥ 含 describe 的测试文件数、无挂起（含 consumer-e2e：fork consumer-app 黑盒验证自动拉取/上报）
- [ ] 6 cd test/remote-mock-server && PORT=4599 node bin/start.js → /health 返回 {ok:true}（基于 Express）
```
