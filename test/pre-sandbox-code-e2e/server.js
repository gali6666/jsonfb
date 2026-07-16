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
    const states = global.__sandboxConfig?.preSandbox?.routeMiddlewares || {};
    const beforeHandlers = Object.fromEntries(
      Object.entries(states).map(([key, state]) => [key, state.handler])
    );
    const beforeProductionResult = global.__preSandboxTestHandlerChanged;
    const updated = await sandbox.fetchRemoteRiskCode();
    const afterStates = global.__sandboxConfig?.preSandbox?.routeMiddlewares || {};
    const handlerChanged = Object.fromEntries(
      Object.entries(afterStates).map(([key, state]) => [
        key,
        beforeHandlers[key] !== state.handler,
      ])
    );
    const productionResult = global.__preSandboxTestHandlerChanged;
    if (productionResult !== beforeProductionResult) {
      Object.assign(handlerChanged, productionResult);
    }

    res.json({
      updated,
      revision: global.__preSandboxTestRevision,
      initCount: global.__preSandboxTestInitCount,
      handlerChanged,
    });
  } catch (error) {
    res.status(500).json({ updated: false, error: error.message });
  }
});

// 暴露真实 jsonfb 沙箱健康状态，证明代码确实由 jsonfb 拉取并执行。
app.get('/__sandbox/health', (req, res) => {
  res.json(sandbox.getHealth());
});

// 证明消费端加载的是 node_modules 中真实安装的 jsonfb 和 Express 4。
app.get('/__test/package', (req, res) => {
  res.json({
    jsonfbPath: require.resolve('jsonfb'),
    expressVersion: require('express/package.json').version,
    jsonfbVersion: require('jsonfb/package.json').version,
  });
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
