'use strict';

/**
 * 真实消费方宿主：安装并 require('jsonfb')，由 jsonfb 自动拉取远程代码。
 */

const app = require('./src/app');

// 必须在父进程注入远程地址后再加载真实 yalc 安装的 jsonfb。
const jsonfb = require('jsonfb');
const sandbox = jsonfb.sandbox;

// 测试客户端通过 HTTP 精确触发一次真实远程拉取。
app.post('/__sandbox/fetch', async (req, res) => {
  try {
    const updated = await sandbox.fetchRemoteRiskCode();
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ updated: false, error: error.message });
  }
});

// 暴露真实 jsonfb 沙箱健康状态，证明代码确实由 jsonfb 拉取并执行。
app.get('/__sandbox/health', (req, res) => {
  res.json(sandbox.getHealth());
});

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  if (typeof process.send === 'function') {
    process.send({ type: 'listening', baseUrl, port: address.port });
  }
});

server.on('error', (error) => {
  if (typeof process.send === 'function') {
    process.send({ type: 'error', message: error.message });
  }
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;

  sandbox.stopRiskCodePolling();
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
