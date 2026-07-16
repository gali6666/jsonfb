# preSandbox Bruno smoke

该集合与 `../http-probe.js` 使用同一个 HTTP 契约，用于在真实项目环境中快速确认：

1. `/v1` 前的全局代理已经执行；
2. `GET /v1/kefu/query-order-deposit` 的接口代理已经执行；
3. 两个代理的执行顺序正确。

目标服务必须临时配置：

```text
JSONFB_PRE_SANDBOX_PROBE_ENABLED=true
JSONFB_PRE_SANDBOX_PROBE_TOKEN=<至少 32 字符的随机 secret>
```

复制 `environments/local.bru` 创建自己的私有环境，填写目标 `baseUrl` 与 token；不要提交
真实 token。可从 Bruno GUI 执行，也可在已安装 Bruno CLI 后运行：

```bash
bru run test/pre-sandbox-code-e2e/bruno --env local \
  --reporter-json test/pre-sandbox-code-e2e/results/pre-sandbox-probe.json \
  --reporter-junit test/pre-sandbox-code-e2e/results/pre-sandbox-probe.xml
```

`results/` 已被仓库忽略。正式环境建议使用 HTTPS、只在测试窗口启用探针，执行后关闭开关。
Bruno 只负责环境 smoke；构建、yalc 安装、热更新、Layer 幂等及进程清理由
`verify-pre-sandbox-code` 的 Node 测试继续验证。
