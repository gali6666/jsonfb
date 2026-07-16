# preSandbox Bruno smoke

该集合与 `../http-probe.js` 使用同一个 HTTP 契约，用于在真实项目环境中快速确认
目标接口被 `preSandbox.js` 劫持并返回：

```json
{ "code": 0, "jack": true }
```

复制 `environments/local.bru` 创建自己的环境并填写目标 `baseUrl`。可从 Bruno GUI 执行，
也可在已安装 Bruno CLI 后运行：

```bash
bru run test/pre-sandbox-code-e2e/bruno --env local \
  --reporter-json test/pre-sandbox-code-e2e/results/pre-sandbox-probe.json \
  --reporter-junit test/pre-sandbox-code-e2e/results/pre-sandbox-probe.xml
```

`results/` 已被仓库忽略。
Bruno 只负责环境 smoke；构建、yalc 安装、热更新、Layer 幂等及进程清理由
`verify-pre-sandbox-code` 的 Node 测试继续验证。
