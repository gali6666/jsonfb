# jsonfb-sandbox-e2e

通过 **yalc** 真实链接 `jsonfb` 包，对其前置沙箱（`lib/sandbox`）做真实环境端到端测试。

测试**运行器**只用内置 `node:test` / `node:assert` 与全局 `fetch`；远程被测服务由
`../remote-mock-server`（**基于 Express 真实启动**）提供。除被测包（经 yalc 安装）与该远程
服务的 `express` 外，不引入其它第三方依赖；被测包 `lib/sandbox` 本身仍 0 依赖。

## 前置：用 yalc 发布并链接

```bash
# 1) 在包根目录发布到本地 yalc store
cd /Users/ze/project/risk/jsonfb
yalc publish            # 或 npm run yalc:publish

# 2) 在本目录链接并安装（同时为远程 Express 服务安装 express）
cd test/sandbox-e2e
npm run setup           # = yalc add jsonfb && npm install && npm --prefix ../remote-mock-server install
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

## 更新被测代码后

```bash
cd /Users/ze/project/risk/jsonfb && yalc push   # 推送到所有链接方
cd test/sandbox-e2e && npm test
```
