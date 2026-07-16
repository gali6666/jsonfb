'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert');
const { fork } = require('node:child_process');
const path = require('node:path');

const { createRemoteServer } = require('../remote-server');

const serverEntry = path.resolve(__dirname, '..', 'server.js');

const startConsumer = (remoteBaseUrl) => new Promise((resolve, reject) => {
  const proc = fork(serverEntry, [], {
    env: {
      ...process.env,
      JSONFB_EXPORTS_SANDBOX: 'true',
      FORCE_RISK_CODE_POLLING: 'true',
      RISK_CODE_URLS: remoteBaseUrl,
      REMOTE_LOG_URLS: remoteBaseUrl,
      RISK_POLL_INTERVAL_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let settled = false;

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill('SIGKILL');
    reject(new Error(`真实 jsonfb 消费端启动超时\n${stderr}`));
  }, 8000);

  proc.on('message', (message) => {
    if (settled || !message) return;
    if (message.type === 'listening') {
      settled = true;
      clearTimeout(timer);
      resolve({ proc, baseUrl: message.baseUrl });
    } else if (message.type === 'error') {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`真实 jsonfb 消费端启动失败：${message.message}\n${stderr}`));
    }
  });

  proc.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`真实 jsonfb 消费端提前退出 code=${code} signal=${signal}\n${stderr}`));
  });
});

const stopConsumer = (proc) => new Promise((resolve) => {
  if (!proc || proc.exitCode != null || proc.signalCode != null) {
    resolve();
    return;
  }

  const timer = setTimeout(() => proc.kill('SIGKILL'), 2500);
  proc.once('exit', () => {
    clearTimeout(timer);
    resolve();
  });
  proc.kill('SIGTERM');
});

const requestJson = async (baseUrl, pathname, options) => {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { status: response.status, body: await response.json() };
};

const waitFor = async (predicate, label, timeout = 8000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时：${label}`);
};

describe('真实 jsonfb + 远程 preSandbox.js + Express 4 HTTP e2e', () => {
  let remote;
  let remoteBaseUrl;
  let consumer;

  before(async () => {
    remote = createRemoteServer();
    ({ baseUrl: remoteBaseUrl } = await remote.listen());
    consumer = await startConsumer(remoteBaseUrl);

    // 等待真实 jsonfb 完成首次自动拉取和 init。
    await waitFor(async () => {
      const health = await requestJson(consumer.baseUrl, '/__sandbox/health');
      const state = await requestJson(consumer.baseUrl, '/__test/state');
      return health.body.codeLoaded && state.body.globalProxyCount === 1;
    }, 'jsonfb 自动拉取并执行 preSandbox.js');
  });

  after(async () => {
    await stopConsumer(consumer && consumer.proc);
    if (remote) await remote.close();
  });

  test('消费端真实安装 jsonfb，并从远程服务拉取代码', async () => {
    const remoteState = await requestJson(remoteBaseUrl, '/__admin/state');
    const health = await requestJson(consumer.baseUrl, '/__sandbox/health');

    assert.ok(remoteState.body.fetchCount >= 1);
    assert.strictEqual(health.body.codeLoaded, true);
    assert.ok(typeof health.body.currentHash === 'string' && health.body.currentHash.length > 0);
  });

  test('客户端真实请求按全局代理、接口代理、auth、controller 顺序执行', async () => {
    const { status, body } = await requestJson(
      consumer.baseUrl,
      '/v1/kefu/query-order-deposit'
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.trace, [
      'preV1Risk:v1',
      'kefuQueryOrderDepositRisk:v1',
      'auth',
      'controller',
    ]);
  });

  test('接口级代理不会错误注入其它接口', async () => {
    const { body } = await requestJson(consumer.baseUrl, '/v1/kefu/untouched');
    assert.deepStrictEqual(body.trace, ['preV1Risk:v1', 'untouched']);
  });

  test('远程代码热更新后，新请求执行新版 handler 且 Layer 不重复', async () => {
    await requestJson(remoteBaseUrl, '/__admin/revision/v2', { method: 'POST' });
    const fetchResult = await requestJson(consumer.baseUrl, '/__sandbox/fetch', {
      method: 'POST',
    });
    assert.strictEqual(fetchResult.status, 200);
    assert.strictEqual(fetchResult.body.updated, true);

    const request = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(request.body.trace, [
      'preV1Risk:v2',
      'kefuQueryOrderDepositRisk:v2',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.globalProxyCount, 1);
    assert.strictEqual(state.body.routeProxyCount, 1);
  });

  test('连续多版本热更新仍只保留一个代理 Layer', async () => {
    for (const revision of ['v3', 'v4', 'v5']) {
      // eslint-disable-next-line no-await-in-loop
      await requestJson(remoteBaseUrl, `/__admin/revision/${revision}`, { method: 'POST' });
      // eslint-disable-next-line no-await-in-loop
      const fetched = await requestJson(consumer.baseUrl, '/__sandbox/fetch', { method: 'POST' });
      assert.strictEqual(fetched.body.updated, true);
    }

    const request = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(request.body.trace, [
      'preV1Risk:v5',
      'kefuQueryOrderDepositRisk:v5',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.globalProxyCount, 1);
    assert.strictEqual(state.body.routeProxyCount, 1);
    assert.deepStrictEqual(state.body.routeStack, [
      'preRiskRouteMiddleware:kefuQueryOrderDepositRisk',
      'auth',
      '<anonymous>',
    ]);
  });
});
