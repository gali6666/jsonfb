---
name: verify-pre-sandbox-code
description: 独立验证 publish/code/preSandbox.js 远程代码的 Express 4 路由劫持、真实 HTTP 执行顺序、指定接口中间件注入、重复 init 幂等、handler 热更新和进程零泄漏。修改或审查 preSandbox 远程代码、Express 劫持策略、接口级中间件及其测试后使用；不要用它替代 lib/sandbox 的 verify-sandbox-tests。
---

# 验证 PreSandbox 远程代码

运行独立的本地 Express 4 黑盒验证：构建 jsonfb、经 yalc 安装到真实消费端，然后启动本地远程服务和消费端；不连接测试环境：

```bash
bash .cursor/skills/verify-pre-sandbox-code/scripts/verify.sh
```

脚本依次执行：

1. 校验 `publish/code/preSandbox.js` 语法和测试工程结构。
2. 构建 jsonfb 单文件，经 yalc 发布并安装到独立消费端，同时安装 Express 4。
3. 启动本地远程代码服务和真实 `require('jsonfb')` 的 Express 4 消费端。
4. 由 jsonfb 自动拉取并执行远程 `preSandbox.js`，再运行 `node:test` 通过真实 HTTP 请求断言：
   - `/v1` 前置代理真实执行；
   - 指定接口代理在 `auth` 前执行；
   - 未配置接口不被错误注入；
   - 重复 `init()` 不重复插入 Layer；
   - 热更新只替换全局 handler，新请求执行新版本；
   - 服务无未捕获异常并干净退出。

任何一步失败都必须返回非零退出码。验证 `lib/sandbox/**` 时继续使用：

```bash
bash .cursor/skills/verify-sandbox-tests/scripts/verify.sh
```
