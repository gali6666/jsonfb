#!/usr/bin/env node
/**
 * 独立启动 mock 服务（默认端口 4050，与 lib/sandbox/config.js 的本地默认地址一致）。
 * 用法：
 *   npm start
 *   PORT=4555 npm start
 */

const { createServer } = require('../server');

const PORT = Number(process.env.PORT || 4050);

(async () => {
  const handle = createServer();
  try {
    const { baseUrl } = await handle.listen(PORT);
    // eslint-disable-next-line no-console
    console.log(`[remote-mock-server] listening at ${baseUrl}`);
    console.log('  POST /v1/risk/get-risk-code');
    console.log('  POST /v1/risk/log');
    console.log('  POST /v1/risk/callback');
    console.log('  GET  /__admin/state   POST /__admin/{set-code,set-mode,reset}');
    console.log('  GET  /health');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[remote-mock-server] failed to listen on ${PORT}: ${e.message}`);
    process.exit(1);
  }
})();
