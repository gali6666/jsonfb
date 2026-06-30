'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const { bootstrap, adminPost } = require('../helpers/bootstrap');

// 规则要求「运行绝不抛错」：远程拉取/解码/执行中的异常必须被捕获并静默。
describe('robustness (never throws on bad downstream)', () => {
  let handle;
  let baseUrl;
  let sandbox;
  let serverClosed = false;

  before(async () => {
    const b = await bootstrap();
    handle = b.handle;
    baseUrl = b.baseUrl;
    sandbox = b.sandbox;
  });

  after(async () => {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
    if (handle && !serverClosed) {
      await handle.close();
    }
  });

  test('畸形 JSON 响应：返回 false 且不抛错', async () => {
    await adminPost(baseUrl, '/__admin/set-mode', { mode: 'malformed' });
    const r = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(r, false);
  });

  test('结构错误响应：返回 false 且不抛错', async () => {
    await adminPost(baseUrl, '/__admin/set-mode', { mode: 'wrong-shape' });
    const r = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(r, false);
  });

  test('坏代码（可解码但无法编译）：init 失败被吞，fetch 不抛错', async () => {
    await adminPost(baseUrl, '/__admin/set-mode', { mode: 'bad-code' });
    await assert.doesNotReject(() => sandbox.fetchRemoteRiskCode());
  });

  test('恢复 normal 后可正常拉取', async () => {
    await adminPost(baseUrl, '/__admin/reset'); // mode->normal, version->v1
    const r = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(r, true);
    assert.ok(sandbox.getRiskCode().includes('init executed in sandbox'));
  });

  test('下游不可用（服务关闭）：fetch 返回 false 且不抛错', async () => {
    await handle.close();
    serverClosed = true;
    const r = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(r, false);
  });
});
