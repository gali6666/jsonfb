'use strict';

/**
 * ============================================
 * 真实消费方宿主（Server 2 / consumer-app）
 * ============================================
 *
 * 设计目标：尽可能贴近真实业务方——只 `require('jsonfb')` 并启动一个 Express 服务，
 * 不在业务侧手动驱动沙箱。内嵌的前置沙箱（lib/sandbox）在 require 时按
 * `FORCE_RISK_CODE_POLLING` 自动开始轮询，自行去 Server 1（远程风控服务）拉取
 * `/v2/risk/get-risk-code` 并上报 `/v2/risk/log`。本进程用来验证：
 *   1) 内嵌 jsonfb 后 Express 宿主仍能正常启动（不被沙箱副作用拖垮）；
 *   2) 沙箱确实「自动」拉取远程代码并在沙箱内执行 init（真实回调到 Server 1）；
 *   3) 远程日志上报真实发生且验签通过；
 *   4) 多地址随机分发 / 故障转移。
 *
 * 关键时序：config.js 在 require 时读取 RISK_CODE_URLS / REMOTE_LOG_URLS /
 * RISK_POLL_INTERVAL_MS，这些都由父进程在 fork 时经 env 注入，因此 require('jsonfb')
 * 时配置已就绪（见 .cursor/rules/sandbox-test.mdc「配置时序」）。
 *
 * 观测通道：
 *   - 父进程经 IPC（fork 自带通道）拿到本服务监听端口；
 *   - `/__sandbox/*` 端点由内向外读取沙箱状态、或按需触发一次拉取/上报，
 *     用于多地址分发与容灾的「精确计数」（避免后台轮询干扰）。
 *
 * 说明：本服务（消费方宿主）允许使用 Express——它正是「被验证能否内嵌 jsonfb 的真实宿主」；
 *      被测包 lib/sandbox 自身仍保持 0 依赖。
 */

const express = require('express');

// 必须在 env 就绪后再 require（config.js 在 require 时读取环境变量）。
// 单文件打包后沙箱 API 经主包 .sandbox 暴露（需 JSONFB_EXPORTS_SANDBOX=true）。
const jsonfb = require('jsonfb');
const sandbox = jsonfb.sandbox;

const app = express();
app.disable('x-powered-by');
app.disable('etag');

// 宿主自身存活探针：证明内嵌 jsonfb 后 Express 仍能正常启动。
app.get('/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, sandboxLoaded: Boolean(sandbox) });
});

// 由内向外读取沙箱健康/状态（用于「证明沙箱真的在本进程内自动跑了」）。
app.get('/__sandbox/health', (req, res) => {
  if (!sandbox) {
    res.status(500).json({ error: 'sandbox not exported (need JSONFB_EXPORTS_SANDBOX=true)' });
    return;
  }
  const health = sandbox.getHealth();
  const code = sandbox.getRiskCode();
  res.json({
    ...health,
    codeLoaded: Boolean(code),
    riskCodeLength: (code || '').length,
    remoteCodeUrls: sandbox.RISK_CODE_CONFIG.remoteCodeUrls,
    remoteLogUrls: sandbox.RISK_CODE_CONFIG.remoteLogUrls,
    pollIntervalMs: sandbox.RISK_CODE_CONFIG.pollInterval,
  });
});

// 按需触发一次远程拉取（绝不抛错；返回是否有更新）。用于多地址分发/容灾的精确驱动。
app.post('/__sandbox/fetch', (req, res) => {
  if (!sandbox) {
    res.status(500).json({ error: 'sandbox not exported' });
    return;
  }
  // fetchRemoteRiskCode 内部已 catch 一切异常，绝不抛出
  Promise.resolve(sandbox.fetchRemoteRiskCode())
    .then((updated) => res.json({ updated }))
    .catch(() => res.json({ updated: false }));
});

// 按需触发一次远程日志上报（用于校验 remoteLog 多地址分发与验签）。
app.post('/__sandbox/log', (req, res) => {
  if (!sandbox) {
    res.status(500).json({ error: 'sandbox not exported' });
    return;
  }
  const message = (req.query && req.query.message) || 'consumer-app-log';
  sandbox.remoteLog(String(message));
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT || 0);
const server = app.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  if (typeof process.send === 'function') {
    // 经 IPC 告知父进程真实端口（fork 时具备 IPC 通道）
    process.send({ type: 'listening', port: addr.port, baseUrl });
  } else {
    // 独立运行（npm start）时打印
    // eslint-disable-next-line no-console
    console.log(`[consumer-app] listening at ${baseUrl}`);
    // eslint-disable-next-line no-console
    console.log('  GET  /health');
    // eslint-disable-next-line no-console
    console.log('  GET  /__sandbox/health   POST /__sandbox/fetch   POST /__sandbox/log');
  }
});

server.on('error', (err) => {
  if (typeof process.send === 'function') {
    process.send({ type: 'error', message: err && err.message ? err.message : String(err) });
  } else {
    // eslint-disable-next-line no-console
    console.error(`[consumer-app] listen error: ${err && err.message}`);
  }
  process.exit(1);
});

// 干净关闭：停止沙箱轮询 + 关闭 Express 监听，确保进程可退出、无泄漏。
let closing = false;
const shutdown = () => {
  if (closing) {
    return;
  }
  closing = true;
  try {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
  } catch (e) {
    // 关闭过程中的异常忽略
  }
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  server.close(() => process.exit(0));
  // 兜底：若仍有滞留句柄，限时强制退出
  const t = setTimeout(() => process.exit(0), 1500);
  if (t.unref) {
    t.unref();
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
