# jsonfb-sandbox-e2e

通过 **yalc** 真实链接 `jsonfb` 包，对其前置沙箱（`lib/sandbox`）做真实环境端到端测试。

测试**运行器**只用内置 `node:test` / `node:assert` 与全局 `fetch`。涉及两类真实 Express 服务：

- **Server 1 = `../remote-mock-server`**（**基于 Express 真实启动**）：远程风控服务，
  提供 `/v2/risk/get-risk-code`、`/v2/risk/log`、`/v1/risk/callback` 等，可起多实例（不同端口）模拟多地址。
- **Server 2 = `../consumer-app`**（**基于 Express 真实启动**）：真实业务宿主，由 `consumer-e2e.test.js`
  以**子进程 `fork`** 拉起，只 `require('jsonfb')`，其内嵌前置沙箱在 require 时**自动**轮询拉取 + 上报
  （不在业务侧手动驱动）。测试以 Server 1 收到的请求/回调/日志作为「真实副作用」证据（黑盒）。

被测包 `lib/sandbox` 本身仍严格 0 依赖；两处 `express` 分别属于「远程被测服务」与「被验证能否
内嵌 jsonfb 的真实宿主」，均不属于被测包运行时依赖。

## 两种测试视角（互补）

- **进程内（白盒）**：`helpers/bootstrap.js` 在测试进程内 `require('jsonfb').sandbox`，直接断言
  `sign.util`/`http-client`/`config`/`SandboxManager` 等单元与契约。
- **跨进程（黑盒）**：`helpers/consumer.js` + `consumer-e2e.test.js` 把消费方拉到独立 Express 子进程
  （Server 2），验证「真实宿主 require('jsonfb') 后沙箱自动工作」的完整链条，以及多地址随机分发/故障转移。
  子进程注入的关键 env：`RISK_CODE_URLS`/`REMOTE_LOG_URLS`（多地址）、`FORCE_RISK_CODE_POLLING=true`
  （非生产强制立即轮询）、`JSONFB_EXPORTS_SANDBOX=true`（暴露 `/__sandbox/*`）、`RISK_POLL_INTERVAL_MS`（间隔）。

## 前置：用 yalc 发布并链接

```bash
# 1) 在包根目录发布到本地 yalc store
cd /Users/ze/project/risk/jsonfb
yalc publish            # 或 npm run yalc:publish

# 2) 在本目录链接并安装（同时为 Server1 远程服务与 Server2 消费方宿主安装 express + 链接 jsonfb）
cd test/sandbox-e2e
npm run setup           # = yalc add jsonfb && npm install && (remote-mock-server install) && (consumer-app setup)
```

## 运行测试

```bash
npm test                # node --test，递归运行 test/**/*.test.js
```

每个测试文件在**独立子进程**中运行：先用 `helpers/bootstrap.js` 进程内启动真实
Express 服务（见 `../remote-mock-server`），设置 `RISK_CODE_URLS` / `REMOTE_LOG_URLS`
环境变量，再 `require('jsonfb').sandbox`（单文件打包后沙箱 API 经主包暴露），从而覆盖：

- `sign.util`：MD5、简单/递归参数排序、与服务端签名交叉一致。
- `http-client`：post/get/put、JSON 解析、非 2xx、超时、可重试错误的重试恢复。
- `config`：`pickRandom`、`getRemoteCodeUrl/getRemoteLogUrl`、环境变量覆盖。
- 多地址（`multi-address.test.js`）：真正起多个 mock 服务，验证 `remoteCodeUrls` /
  `remoteLogUrls` 为数组时的随机分发（每个地址都被命中）、日志多地址分发，
  以及部分地址失效时的故障转移（拉取绝不抛错、存活地址仍可提供可用代码）。
- `SandboxManager`：`executeCode/executeInit`、缓存、`setTimeout` 守卫、原生 `require`、
  注入工具、`module.exports` 隔离、上下文隔离。
- 端到端轮询：`fetchRemoteRiskCode` -> 解码 -> 沙箱 `init` 真实回调；增量 hash；
  版本更新后缓存清理与重新 init；`startRiskCodePolling`/`stopRiskCodePolling`；`remoteLog`。
- 健壮性：畸形响应 / 坏代码 / 下游不可用时绝不抛错。
- 真实消费方（`consumer-e2e.test.js`）：fork Server2（Express 宿主）后 `/health` 200（内嵌 jsonfb
  不影响宿主启动）；内嵌沙箱「自动」拉取并执行 `init`（Server1 收到真实回调）；自动轮询持续发起请求；
  `remoteLog` 真实上报验签通过；多 Server1 实例下随机分发（命中总数==触发次数）与部分地址失效时的故障转移。

## 更新被测代码后

```bash
cd /Users/ze/project/risk/jsonfb && yalc push   # 推送到所有链接方
cd test/sandbox-e2e && npm test
```
