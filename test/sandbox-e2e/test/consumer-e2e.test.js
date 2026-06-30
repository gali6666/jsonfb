'use strict';

/**
 * 真实「消费方 server」黑盒端到端：
 *
 *   Server 1（test/remote-mock-server，Express）  —— 远程风控服务，可起多个实例（不同端口）
 *        ▲  /v2/risk/get-risk-code   /v2/risk/log   /v1/risk/callback
 *        │
 *   Server 2（test/consumer-app，Express）        —— 真实业务宿主，子进程，require('jsonfb')
 *        │  内嵌前置沙箱「自动」轮询拉取 + 上报（不在业务侧手动驱动）
 *        ▼  /health   /__sandbox/{health,fetch,log}
 *   node:test（本进程）                            —— 只编排 + 黑盒观测
 *
 * 与 e2e-polling.test.js（进程内手动驱动）互补：本文件验证「真实宿主 require('jsonfb')
 * 后沙箱自动工作」的完整链条，并以 Server 1 收到的请求/回调/日志作为「真实副作用」证据。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const { startServers, adminState, adminPost, waitFor } = require('../helpers/bootstrap');
const {
  spawnConsumer,
  consumerGet,
  consumerPost,
  codeUrlsOf,
  logUrlsOf,
} = require('../helpers/consumer');

// ===========================================================================
// 套件 A：单远程地址 —— 宿主能启动 + 内嵌沙箱「自动」拉取/执行/上报
// ===========================================================================
describe('consumer-app boots & embedded sandbox auto-pulls/reports (single remote)', () => {
  let servers;
  let consumer;

  before(async () => {
    servers = await startServers(1);
    await adminPost(servers[0].baseUrl, '/__admin/reset');
    // 短轮询间隔：用于观测「真实自动轮询循环」会持续发起请求。
    consumer = await spawnConsumer({
      codeUrls: codeUrlsOf(servers),
      logUrls: logUrlsOf(servers),
      pollIntervalMs: 150,
    });
  });

  after(async () => {
    if (consumer) {
      await consumer.close();
    }
    await Promise.all(servers.map((s) => s.handle.close()));
  });

  test('内嵌 jsonfb 后 Express 宿主仍能正常启动（/health 200）', async () => {
    const { status, body } = await consumerGet(consumer.baseUrl, '/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.sandboxLoaded, true);
  });

  test('沙箱「自动」拉取 get-risk-code 并在沙箱内执行 init（Server1 收到真实回调）', async () => {
    await waitFor(
      async () => {
        const st = await adminState(servers[0].baseUrl);
        return st.getCodeCount > 0 && st.callbacks.some((c) => c.event === 'init' && c.version === 'v1');
      },
      { timeout: 8000, label: 'auto get-risk-code + v1 init callback' }
    );
  });

  test('自动轮询持续发起请求（getCodeCount 随时间继续增长，证明是循环而非一次性）', async () => {
    const first = (await adminState(servers[0].baseUrl)).getCodeCount;
    await waitFor(
      async () => (await adminState(servers[0].baseUrl)).getCodeCount > first,
      { timeout: 5000, label: 'polling issues subsequent requests' }
    );
  });

  test('remoteLog 真实上报到 Server1 且服务端独立验签通过', async () => {
    await waitFor(
      async () => {
        const st = await adminState(servers[0].baseUrl);
        return st.logs.length > 0 && st.logs.every((l) => l.signOk === true);
      },
      { timeout: 8000, label: 'remoteLog delivered with valid sign' }
    );
  });

  test('由内向外读取沙箱健康：codeLoaded 且 pollingActive', async () => {
    const { body: h } = await consumerGet(consumer.baseUrl, '/__sandbox/health');
    assert.strictEqual(h.codeLoaded, true, 'codeLoaded');
    assert.strictEqual(h.pollingActive, true, 'pollingActive');
    assert.ok(h.totalFetches >= 1, 'totalFetches >= 1');
    assert.ok(h.totalUpdates >= 1, 'totalUpdates >= 1');
    assert.ok(typeof h.currentHash === 'string' && h.currentHash.length > 0, 'currentHash set');
    assert.strictEqual(h.pollIntervalMs, 150, 'RISK_POLL_INTERVAL_MS 已被沙箱采用');
  });

  test('切换远程版本后，下一轮自动轮询增量更新并重新执行 init(v2)', async () => {
    await adminPost(servers[0].baseUrl, '/__admin/set-code', { version: 'v2' });
    await waitFor(
      async () => {
        const st = await adminState(servers[0].baseUrl);
        return st.callbacks.some((c) => c.event === 'init' && c.version === 'v2' && c.revision === 2);
      },
      { timeout: 8000, label: 'v2 init callback after auto poll' }
    );
  });
});

// ===========================================================================
// 套件 B：多远程地址（Server1 起 3 个实例，不同端口）—— 随机分发 + 故障转移
// 用长轮询间隔 + /__sandbox/fetch 精确驱动，避免后台轮询干扰计数。
// ===========================================================================
describe('consumer-app multi-address random distribution + failover (3 remote servers)', () => {
  let servers;
  let consumer;

  before(async () => {
    servers = await startServers(3);
    await Promise.all(servers.map((s) => adminPost(s.baseUrl, '/__admin/reset')));
    consumer = await spawnConsumer({
      codeUrls: codeUrlsOf(servers),
      logUrls: logUrlsOf(servers),
      pollIntervalMs: 600000, // 实际上禁用后台轮询，分发完全由 /__sandbox/fetch 驱动
    });
  });

  after(async () => {
    if (consumer) {
      await consumer.close();
    }
    // 失效用例可能已关闭其中一部分，重复关闭是安全的
    await Promise.all(servers.map((s) => s.handle.close()));
  });

  const triggerFetch = async () => {
    const { status, body } = await consumerPost(consumer.baseUrl, '/__sandbox/fetch');
    assert.strictEqual(status, 200, '触发拉取端点必须 200（内部 catch，绝不抛错）');
    assert.strictEqual(typeof body.updated, 'boolean');
    return body.updated;
  };

  test('沙箱配置解析为多地址数组且与各远程服务一一对应', async () => {
    const { body: h } = await consumerGet(consumer.baseUrl, '/__sandbox/health');
    assert.strictEqual(h.remoteCodeUrls.length, servers.length);
    assert.strictEqual(h.remoteLogUrls.length, servers.length);
    servers.forEach((s) => {
      assert.ok(h.remoteCodeUrls.includes(`${s.baseUrl}/v2/risk/get-risk-code`));
      assert.ok(h.remoteLogUrls.includes(`${s.baseUrl}/v2/risk/log`));
    });
  });

  test('多次触发拉取在所有地址间随机分发：每个服务都被命中，命中总数等于触发次数', async () => {
    // 清掉启动立即拉取计入的命中
    await Promise.all(servers.map((s) => adminPost(s.baseUrl, '/__admin/reset')));

    const MAX = 300;
    let fetches = 0;
    while (fetches < MAX) {
      // eslint-disable-next-line no-await-in-loop
      await triggerFetch();
      fetches += 1;
      // eslint-disable-next-line no-await-in-loop
      const states = await Promise.all(servers.map((s) => adminState(s.baseUrl)));
      if (states.every((st) => st.getCodeCount > 0)) {
        break;
      }
    }

    const states = await Promise.all(servers.map((s) => adminState(s.baseUrl)));
    states.forEach((st, idx) => {
      assert.ok(st.getCodeCount > 0, `server #${idx} 未被命中：随机分发未覆盖全部地址`);
    });
    // 全部在线时每次拉取恰好命中一个地址且只计一次（无丢失/无重试重复计数）
    const total = states.reduce((acc, st) => acc + st.getCodeCount, 0);
    assert.strictEqual(total, fetches);
  });

  test('remoteLog 在多个日志地址间随机分发，且每条上报服务端验签通过', async () => {
    await Promise.all(servers.map((s) => adminPost(s.baseUrl, '/__admin/reset')));

    const N = 60;
    for (let i = 0; i < N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await consumerPost(consumer.baseUrl, `/__sandbox/log?message=multi-log-${i}`);
    }

    await waitFor(
      async () => {
        const states = await Promise.all(servers.map((s) => adminState(s.baseUrl)));
        return states.every((st) => st.logs.some((l) => String(l.message).includes('multi-log-')));
      },
      { timeout: 8000, label: 'all log endpoints received at least one multi-log' }
    );

    const states = await Promise.all(servers.map((s) => adminState(s.baseUrl)));
    states.forEach((st) => {
      st.logs.forEach((l) => {
        assert.strictEqual(l.signOk, true, `日志 "${l.message}" 验签应通过`);
      });
    });
  });

  // 放最后：关闭部分地址，模拟「数组中部分地址失效」。
  test('部分地址失效时故障转移：触发拉取绝不抛错，存活地址仍可提供可用代码', async () => {
    const liveServer = servers[0];
    const deadServers = servers.slice(1);
    await Promise.all(deadServers.map((s) => s.handle.close()));

    await adminPost(liveServer.baseUrl, '/__admin/reset');
    const baseFailures = (await consumerGet(consumer.baseUrl, '/__sandbox/health')).body.totalFailures;

    let sawLiveHit = false;
    let sawDeadFailure = false;
    const MAX = 80;
    let n = 0;
    while (n < MAX && !(sawLiveHit && sawDeadFailure)) {
      // 即使随机命中已关闭地址，端点也必须 200（内部静默处理）
      // eslint-disable-next-line no-await-in-loop
      await triggerFetch();
      n += 1;
      // eslint-disable-next-line no-await-in-loop
      const live = await adminState(liveServer.baseUrl);
      if (live.getCodeCount > 0) {
        sawLiveHit = true;
      }
      // eslint-disable-next-line no-await-in-loop
      const h = (await consumerGet(consumer.baseUrl, '/__sandbox/health')).body;
      if (h.totalFailures > baseFailures) {
        sawDeadFailure = true;
      }
    }

    assert.ok(sawLiveHit, '故障转移：存活地址最终被随机选中并成功服务');
    assert.ok(sawDeadFailure, '故障转移：失效地址被命中，失败被静默记录而非抛出');

    const { body: h } = await consumerGet(consumer.baseUrl, '/__sandbox/health');
    assert.ok(h.codeLoaded, '存活地址持续可提供可用代码');
    assert.ok(h.totalFailures >= 1, '失效命中应累计到 totalFailures');
  });
});
