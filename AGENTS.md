# AGENTS

> **jsonfb** —— 带 BigInt 支持的 JSON `parse` / `stringify` 工厂，内嵌 **0 依赖前置沙箱**（`lib/sandbox`），经 `require('jsonfb').sandbox` 暴露远程风控代码拉取与执行能力。
>
> 本文件为 **Codex** 项目入口（[Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)）。详细强制规范在 `.cursor/rules/`（Cursor 规则源）；**改动沙箱或测试前必须先读对应规则文件全文**。

## 规则索引（必读）

| 场景 | 规则文件 | 说明 |
| --- | --- | --- |
| 改 `lib/sandbox/**` | [`.cursor/rules/front-sandbox.mdc`](.cursor/rules/front-sandbox.mdc) | 0 依赖、0 主进程依赖、配置/HTTP/签名/异常静默、单文件发布契约 |
| 改 `test/**` 沙箱测试 | [`.cursor/rules/sandbox-test.mdc`](.cursor/rules/sandbox-test.mdc) | yalc 真实链接发布产物、双 Express 服务、node:test 全覆盖、零泄漏 |
| 改 `publish/code/preSandbox.js` | [`.cursor/rules/pre-sandbox-remote-code.mdc`](.cursor/rules/pre-sandbox-remote-code.mdc) | 远程代码：`safeRequire`、Express 4/5 策略、`mainGlobal.__preSandbox` 热更新；**禁止改** `lib/sandbox/**` 与宿主 `src/**` |

验证 skill（跑/改沙箱测试后）：[`.cursor/skills/verify-sandbox-tests/SKILL.md`](.cursor/skills/verify-sandbox-tests/SKILL.md) → `bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh`

## 项目结构

```
index.js              # 工厂 + require('./lib/sandbox') 副作用加载
lib/parse.js          # parse 实现
lib/stringify.js      # stringify 实现
lib/sandbox/          # 前置沙箱源码（0 依赖，多文件）
dist/index.js         # rollup + obfuscator 单文件发布产物（沙箱已打包）
publish/code/         # 远程下发代码（preSandbox.js）
publish/publish.js    # 远程代码发布（混淆 + base64）
test/sandbox-e2e/     # 沙箱 e2e（node:test + yalc 消费端）
test/remote-mock-server/  # Server 1：模拟远程风控 API（Express）
test/consumer-app/    # Server 2：真实宿主（Express + fork 黑盒）
```

## 导出契约（单文件）

- `require('jsonfb')` → 工厂函数；调用返回 `{ parse, stringify }`（实例上**不挂** `sandbox`）。
- `require('jsonfb').sandbox` → 沙箱 API（`fetchRemoteRiskCode`、`getRiskCode`、`sandboxManager`、`HttpClient`、`signWithMD5` 等）。
- **无** `jsonfb/lib/sandbox` 子路径；消费端只能经 `.sandbox` 访问。

## 常用命令

| 用途 | 命令 |
| --- | --- |
| 单元测试（mocha） | `npm test` |
| 构建（混淆单文件） | `npm run build` |
| 构建（可读单文件） | `npm run build:notobf` |
| yalc 发布 | `npm run yalc:publish` |
| 沙箱 e2e | `cd test/sandbox-e2e && npm test` |
| 全链路验证 | `bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh` |
| 发布远程代码（测试/生产） | `npm run code:publish:test` / `npm run code:publish:prod` |

## 工作约定

- 沙箱测试必须 **先 build + yalc publish 再测**；`config.js` 在 require 时读 `RISK_CODE_URLS` 等 env，**先设 env 再 require('jsonfb')**。
- 沙箱运行**绝不向上抛错**；轮询定时器须 `unref()`。
- 远程地址为**数组**，经 `getRemoteCodeUrl()` / `getRemoteLogUrl()` 随机抽取。
- 只在你明确要求时创建 git commit；不要顺手改无关文件。
