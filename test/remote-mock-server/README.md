# jsonfb-remote-mock

为 jsonfb 前置沙箱（`lib/sandbox`）提供的**真实**远程代码服务，**基于 Express 真实启动**。

它既可被端到端测试通过 `createServer()` 进程内启动，也可独立运行作为一个真实的远端。

> 依赖边界：本服务引入 `express` 作为依赖（真实远端框架）；被测包 `lib/sandbox` 仍严格保持 0 第三方依赖，二者互不影响。

## 安装与运行

```bash
npm install          # 安装 express（首次或依赖缺失时）
npm start            # 监听 4050（与 config.js 本地默认地址一致）
PORT=4555 npm start  # 自定义端口
```

## 端点契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/risk/get-risk-code` | 入参 `{ hash, sign }`；`hash` 命中当前版本返回 `{data:{status:0}}`，否则返回 `{data:{status:1, hash, riskCode(base64)}}` |
| POST | `/v1/risk/log` | 入参 `{ message, sign }`，记录上报日志 |
| POST | `/v1/risk/callback` | 沙箱内远程代码执行后的真实回调，落库到内存 |
| GET | `/health` | 健康检查 |
| GET | `/__admin/state` | 读取 `mode/version/currentHash/getCodeCount/logs/callbacks` |
| POST | `/__admin/set-code` | `{ version: "v1"\|"v2" }` 切换下发版本 |
| POST | `/__admin/set-mode` | `{ mode: "normal"\|"malformed"\|"wrong-shape"\|"bad-code" }` |
| POST | `/__admin/reset` | 复位所有状态 |
| ALL | `/__test/echo` | 回显 `{ method, body, query }`（HttpClient 测试用） |
| GET | `/__test/status?code=` | 返回指定状态码（非 2xx 测试用） |
| GET | `/__test/slow?ms=` | 延迟响应（超时测试用） |
| GET | `/__test/flaky?key=&fail=N` | 前 N 次销毁连接（重试恢复测试用） |

> 路由由 Express 提供；请求体由自带的 `collectBody` 中间件按原生流收集并宽松解析
> （空体 → `{}`、合法 JSON → 对象、非法 JSON → `{ __raw }`），以保持与契约一致的行为。

## 签名

服务端用 `./sign.js`（仅依赖 `crypto`）独立复刻 `signWithMD5` 算法做真实校验：
`md5(sortedParams + "&key=<secretValue>")`，密钥与 `lib/sandbox/config.js` 约定一致。

## 远程代码

`store/risk-init.js`（v1）与 `store/risk-init-v2.js`（v2）是被下发的代码模板，
占位符 `__CALLBACK_URL__` / `__VERSION__` 在下发时被替换为真实值；其 `init()` 会用
注入的 `HttpClient` 回调 `/v1/risk/callback`，以此证明代码确实在沙箱内执行。
