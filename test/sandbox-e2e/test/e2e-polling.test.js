'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const { bootstrap, adminState, adminPost, waitFor } = require('../helpers/bootstrap');

// 端到端真实全链路：yalc 包 + 真实 HTTP 服务 + 真实签名/解码/vm 执行。
// 顶层 test 顺序执行（node:test 默认串行），共享沙箱模块级状态。
describe('end-to-end polling (real server + yalc package)', () => {
  let handle;
  let baseUrl;
  let sandbox;

  before(async () => {
    const b = await bootstrap();
    handle = b.handle;
    baseUrl = b.baseUrl;
    sandbox = b.sandbox;
    await adminPost(baseUrl, '/__admin/reset');
  });

  after(async () => {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
    if (handle) {
      await handle.close();
    }
  });

  test('首次拉取下发代码并在沙箱内执行 init（真实回调）', async () => {
    const updated = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(updated, true);

    const code = sandbox.getRiskCode();
    assert.ok(code && code.includes('init executed in sandbox'));

    await waitFor(
      async () => {
        const st = await adminState(baseUrl);
        return st.callbacks.some((c) => c.event === 'init' && c.version === 'v1' && c.revision === 1);
      },
      { label: 'v1 init callback' }
    );
  });

  test('相同 hash 时不更新（status 0）', async () => {
    const before = sandbox.getRiskCode();
    const updated = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(updated, false);
    assert.strictEqual(sandbox.getRiskCode(), before);
  });

  test('切换版本后增量更新、清缓存并重新执行 init', async () => {
    await adminPost(baseUrl, '/__admin/set-code', { version: 'v2' });

    const updated = await sandbox.fetchRemoteRiskCode();
    assert.strictEqual(updated, true);

    const code = sandbox.getRiskCode();
    assert.ok(code.includes('(v2)'));

    await waitFor(
      async () => {
        const st = await adminState(baseUrl);
        return st.callbacks.some((c) => c.event === 'init' && c.version === 'v2' && c.revision === 2);
      },
      { label: 'v2 init callback' }
    );
  });

  test('remoteLog 真实上报到日志端点且签名合法', async () => {
    await adminPost(baseUrl, '/__admin/reset');
    sandbox.remoteLog('hello-from-test');

    await waitFor(
      async () => {
        const st = await adminState(baseUrl);
        return st.logs.some(
          (l) => typeof l.message === 'string' && l.message.includes('hello-from-test') && l.signOk === true
        );
      },
      { label: 'remoteLog delivered with valid sign' }
    );
  });

  test('startRiskCodePolling 幂等、发起请求；stopRiskCodePolling 清理', async () => {
    await adminPost(baseUrl, '/__admin/reset');
    const before = await adminState(baseUrl);
    const countBefore = before.getCodeCount;

    sandbox.startRiskCodePolling();
    sandbox.startRiskCodePolling(); // 幂等：第二次应直接返回，不抛错

    await waitFor(
      async () => (await adminState(baseUrl)).getCodeCount > countBefore,
      { label: 'polling issued at least one request' }
    );

    sandbox.stopRiskCodePolling();
  });
});
