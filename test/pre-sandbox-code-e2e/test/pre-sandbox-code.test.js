'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert');
const { fork } = require('node:child_process');
const path = require('node:path');

const { createRemoteServer } = require('../remote-server');
const { runProbe } = require('../http-probe');

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
  let stdout = '';
  let stderr = '';
  let settled = false;

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill('SIGKILL');
    reject(new Error(`真实 jsonfb 消费端启动超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
  }, 10000);

  proc.on('message', (message) => {
    if (settled || !message) return;
    if (message.type === 'listening') {
      settled = true;
      clearTimeout(timer);
      resolve({ proc, baseUrl: message.baseUrl, output: () => ({ stdout, stderr }) });
    } else if (message.type === 'error') {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`真实 jsonfb 消费端启动失败：${message.message}\n${stderr}`));
    }
  });

  proc.once('exit', (code, signal) => {
    proc.preSandboxTestExit = { code, signal };
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`真实 jsonfb 消费端提前退出 code=${code} signal=${signal}\n${stderr}`));
  });
});

const stopConsumer = (proc) => new Promise((resolve, reject) => {
  if (!proc || proc.exitCode != null || proc.signalCode != null) {
    const outcome = proc?.preSandboxTestExit || {
      code: proc?.exitCode,
      signal: proc?.signalCode,
    };
    if (proc && (outcome.code !== 0 || outcome.signal !== null)) {
      reject(new Error(`消费端已异常退出 code=${outcome.code} signal=${outcome.signal}`));
      return;
    }
    resolve();
    return;
  }

  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    proc.kill('SIGKILL');
  }, 2500);
  proc.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (forced || code !== 0 || signal !== null) {
      reject(new Error(`消费端未干净退出 code=${code} signal=${signal}`));
      return;
    }
    resolve();
  });
  proc.kill('SIGTERM');
});

const requestJson = async (baseUrl, pathname, options) => {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { status: response.status, body: await response.json() };
};

const waitFor = async (predicate, label, timeout = 10000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时：${label}`);
};

const switchAndFetch = async (remoteBaseUrl, consumer, revision) => {
  const before = await requestJson(consumer.baseUrl, '/__test/state');
  const switched = await requestJson(remoteBaseUrl, `/__admin/revision/${revision}`, {
    method: 'POST',
  });
  assert.strictEqual(switched.status, 200);

  const fetched = await requestJson(consumer.baseUrl, '/__sandbox/fetch', { method: 'POST' });
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.body.updated, true);
  assert.strictEqual(fetched.body.revision, revision);
  assert.strictEqual(fetched.body.initCount, before.body.initCount + 1);
  assert.strictEqual(fetched.body.handlerChanged.preV1Risk, true);
  assert.strictEqual(fetched.body.handlerChanged.kefuQueryOrderDepositRisk, true);
  return fetched.body;
};

describe('发布级：真实 jsonfb + 生产转换 preSandbox.js + Express 4 HTTP e2e', { concurrency: false }, () => {
  let remote;
  let remoteBaseUrl;
  let consumer;

  before(async () => {
    remote = createRemoteServer();
    ({ baseUrl: remoteBaseUrl } = await remote.listen());
    consumer = await startConsumer(remoteBaseUrl);

    await waitFor(async () => {
      const health = await requestJson(consumer.baseUrl, '/__sandbox/health');
      const state = await requestJson(consumer.baseUrl, '/__test/state');
      return (
        health.body.codeLoaded &&
        state.body.revision === 'v1' &&
        state.body.globalProxyCount === 1 &&
        state.body.routeProxyCount === 1
      );
    }, 'jsonfb 自动拉取并执行生产转换后的 preSandbox.js');
  });

  after(async () => {
    try {
      await stopConsumer(consumer && consumer.proc);
    } finally {
      if (remote) await remote.close();
    }
  });

  test('消费端使用 yalc 安装的混淆 jsonfb，远程代码使用生产转换器混淆并 Base64 下发', async () => {
    const packageInfo = await requestJson(consumer.baseUrl, '/__test/package');
    const remoteState = await requestJson(remoteBaseUrl, '/__admin/state');
    const health = await requestJson(consumer.baseUrl, '/__sandbox/health');

    assert.match(packageInfo.body.jsonfbPath, /pre-sandbox-code-e2e\/(?:\.yalc|node_modules)\/jsonfb/);
    assert.strictEqual(packageInfo.body.expressVersion.split('.')[0], '4');
    assert.ok(remoteState.body.fetchCount >= 1);
    assert.strictEqual(remoteState.body.validFetchCount, remoteState.body.fetchCount);
    assert.strictEqual(remoteState.body.artifact.obfuscated, true);
    assert.strictEqual(remoteState.body.artifact.decodedContainsSource, true);
    assert.ok(remoteState.body.artifact.base64Length > remoteState.body.artifact.sourceLength);
    assert.strictEqual(health.body.codeLoaded, true);
    assert.strictEqual(health.body.currentHash, remoteState.body.hash);
  });

  test('逐字生产 preSandbox.js 可执行 init，且共享 HTTP 探针返回特定结果', async () => {
    const before = await requestJson(consumer.baseUrl, '/__test/state');
    const switched = await requestJson(remoteBaseUrl, '/__admin/revision/pure', {
      method: 'POST',
    });
    assert.strictEqual(switched.status, 200);

    const fetched = await requestJson(consumer.baseUrl, '/__sandbox/fetch', { method: 'POST' });
    assert.strictEqual(fetched.body.updated, true);
    assert.strictEqual(fetched.body.handlerChanged.preV1Risk, true);
    assert.strictEqual(fetched.body.handlerChanged.kefuQueryOrderDepositRisk, true);

    const after = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(after.body.initCount, before.body.initCount);
    assert.strictEqual(after.body.globalProxyCount, 1);
    assert.strictEqual(after.body.routeProxyCount, 1);

    // pure 版本没有追加测试代码，固定响应证明生产代码的代理经过真实 HTTP 执行。
    const probe = await runProbe({
      baseUrl: consumer.baseUrl,
      timeoutMs: 3000,
    });
    assert.strictEqual(probe.passed, true, JSON.stringify(probe));
    assert.deepStrictEqual(probe.actual, { code: 0, jack: true });

    // 恢复有 init 完成标记的版本，供后续精确热更新断言。
    await switchAndFetch(remoteBaseUrl, consumer, 'v1-restored');
  });

  test('客户端真实请求验证全局和接口代理执行位置', async () => {
    const { status, body } = await requestJson(
      consumer.baseUrl,
      '/v1/kefu/query-order-deposit'
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.trace, [
      'preV1Risk:v1-restored',
      'kefuQueryOrderDepositRisk:v1-restored',
      'auth',
      'controller',
    ]);
  });

  test('接口代理不污染其它接口', async () => {
    const { body } = await requestJson(consumer.baseUrl, '/v1/kefu/untouched');
    assert.deepStrictEqual(body.trace, ['preV1Risk:v1-restored', 'untouched']);
  });

  test('热更新替换真实 handler 引用，已有代理 Layer 不重复', async () => {
    const fetched = await switchAndFetch(remoteBaseUrl, consumer, 'v2');
    assert.strictEqual(fetched.handlerChanged.preV1Risk, true);
    assert.strictEqual(fetched.handlerChanged.kefuQueryOrderDepositRisk, true);

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

  test('无效 Router、method、beforeMiddleware 均不创建代理 Layer', async () => {
    await switchAndFetch(remoteBaseUrl, consumer, 'invalid-targets');

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.globalProxyCount, 1);
    assert.strictEqual(state.body.routeProxyCount, 1);
    assert.strictEqual(state.body.allRouteProxyCount, 1);
    assert.strictEqual(state.body.totalProxyCount, 2);
    assert.deepStrictEqual(state.body.allProxyNames, [
      'preRiskMiddleware',
      'preRiskRouteMiddleware:kefuQueryOrderDepositRisk',
    ]);
    assert.strictEqual(state.body.states.missingRouter.injected, false);
    assert.strictEqual(state.body.states.missingMethod.injected, false);
    assert.strictEqual(state.body.states.missingAnchor.injected, false);
  });

  test('beforeMiddleware 按名称把新代理插入 auth 前，且热更不重复', async () => {
    await switchAndFetch(remoteBaseUrl, consumer, 'before-auth');
    const firstRequest = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(firstRequest.body.trace, [
      'preV1Risk:before-auth',
      'kefuQueryOrderDepositRisk:before-auth',
      'beforeAuthRisk:before-auth',
      'auth',
      'controller',
    ]);

    const fetched = await switchAndFetch(remoteBaseUrl, consumer, 'before-auth-2');
    assert.strictEqual(fetched.handlerChanged.beforeAuthRisk, true);

    const secondRequest = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(secondRequest.body.trace, [
      'preV1Risk:before-auth-2',
      'kefuQueryOrderDepositRisk:before-auth-2',
      'beforeAuthRisk:before-auth-2',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.states.beforeAuthRisk.injected, true);
    assert.strictEqual(state.body.allRouteProxyCount, 2);
    assert.deepStrictEqual(state.body.routeStack, [
      'preRiskRouteMiddleware:kefuQueryOrderDepositRisk',
      'preRiskRouteMiddleware:beforeAuthRisk',
      'auth',
      '<anonymous>',
    ]);
  });

  test('index=1 按当前 route.stack 的绝对索引插入', async () => {
    await switchAndFetch(remoteBaseUrl, consumer, 'index-one');

    const request = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(request.body.trace, [
      'preV1Risk:index-one',
      'kefuQueryOrderDepositRisk:index-one',
      'indexOneRisk:index-one',
      'beforeAuthRisk:before-auth-2',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.states.indexOneRisk.injected, true);
    assert.strictEqual(state.body.allRouteProxyCount, 3);
  });

  test('beforeMiddleware 支持按函数引用插入 auth 前', async () => {
    await switchAndFetch(remoteBaseUrl, consumer, 'before-auth-function');

    const request = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(request.body.trace, [
      'preV1Risk:before-auth-function',
      'kefuQueryOrderDepositRisk:before-auth-function',
      'indexOneRisk:index-one',
      'beforeAuthRisk:before-auth-function',
      'beforeAuthFunctionRisk:before-auth-function',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    assert.strictEqual(state.body.states.beforeAuthFunctionRisk.injected, true);
    assert.strictEqual(state.body.allRouteProxyCount, 4);
  });

  test('连续多版本热更新后代理数量稳定，消费端无未捕获异常', async () => {
    for (const revision of ['v3', 'v4', 'v5']) {
      // eslint-disable-next-line no-await-in-loop
      const fetched = await switchAndFetch(remoteBaseUrl, consumer, revision);
      assert.strictEqual(fetched.handlerChanged.preV1Risk, true);
      assert.strictEqual(fetched.handlerChanged.kefuQueryOrderDepositRisk, true);
    }

    const request = await requestJson(consumer.baseUrl, '/v1/kefu/query-order-deposit');
    assert.deepStrictEqual(request.body.trace, [
      'preV1Risk:v5',
      'kefuQueryOrderDepositRisk:v5',
      'indexOneRisk:index-one',
      'beforeAuthRisk:before-auth-function',
      'beforeAuthFunctionRisk:before-auth-function',
      'auth',
      'controller',
    ]);

    const state = await requestJson(consumer.baseUrl, '/__test/state');
    const health = await requestJson(consumer.baseUrl, '/__sandbox/health');
    assert.strictEqual(state.body.globalProxyCount, 1);
    assert.strictEqual(state.body.routeProxyCount, 1);
    assert.strictEqual(state.body.allRouteProxyCount, 4);
    assert.strictEqual(health.status, 200);

    const output = consumer.output();
    assert.doesNotMatch(output.stderr, /uncaught|unhandled|TypeError|ReferenceError/i);

    await waitFor(async () => {
      const current = await requestJson(remoteBaseUrl, '/__admin/state');
      return current.body.logs.length > 0;
    }, 'remoteLog 到达远程服务');
    const remoteState = await requestJson(remoteBaseUrl, '/__admin/state');
    assert.ok(remoteState.body.logs.length > 0);
    assert.ok(remoteState.body.logs.every((entry) => entry.signOk === true));
    assert.ok(
      remoteState.body.logs.every(
        (entry) => !/preSandbox init failed|execution failed|layer not found/i.test(entry.message)
      )
    );
  });
});
