'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const { bootstrapMulti, waitFor } = require('../helpers/bootstrap');

// 多地址（数组随机抽取 + 容灾）真实端到端：
// config.js 的 remoteCodeUrls / remoteLogUrls 为「数组」，运行时随机抽取一个使用。
// 这里真正起 3 个独立 mock 服务，验证随机分发、日志多地址分发，以及部分地址失效时的故障转移。
//
// 关键时序：config.js 在 require 时读取环境变量，bootstrapMulti 已保证
// 「先起齐多个服务 -> 设多地址环境变量 -> 再 require 被测包」。
describe('multi-address (random pick + failover across real servers)', () => {
  let servers;
  let sandbox;

  before(async () => {
    const b = await bootstrapMulti(3);
    servers = b.servers;
    sandbox = b.sandbox;
  });

  after(async () => {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
    // 关闭全部服务（失效用例可能已关掉其中一部分，重复关闭是安全的）
    await Promise.all(servers.map((s) => s.handle.close()));
  });

  test('环境变量被解析为「多地址」数组且与各服务一一对应', () => {
    const cfg = sandbox.RISK_CODE_CONFIG;
    assert.strictEqual(cfg.remoteCodeUrls.length, servers.length);
    assert.strictEqual(cfg.remoteLogUrls.length, servers.length);
    servers.forEach((s) => {
      assert.ok(
        cfg.remoteCodeUrls.includes(`${s.baseUrl}/v2/risk/get-risk-code`),
        `remoteCodeUrls 应包含 ${s.baseUrl}`
      );
      assert.ok(
        cfg.remoteLogUrls.includes(`${s.baseUrl}/v2/risk/log`),
        `remoteLogUrls 应包含 ${s.baseUrl}`
      );
    });
  });

  test('多次拉取在所有地址间随机分发：每个服务都被命中，且命中总数等于请求数', async () => {
    servers.forEach((s) => {
      s.handle.state.getCodeCount = 0;
    });

    // 反复拉取直到所有地址都至少被命中一次（随机抽取应覆盖全部地址）；
    // 设置足够大的上限避免极端随机下不收敛导致用例挂死。
    const MAX = 300;
    let fetches = 0;
    while (fetches < MAX) {
      // 每次拉取都必须不抛错（无论命中哪个地址）
      // eslint-disable-next-line no-await-in-loop
      await assert.doesNotReject(() => sandbox.fetchRemoteRiskCode());
      fetches += 1;
      if (servers.every((s) => s.handle.state.getCodeCount > 0)) {
        break;
      }
    }

    servers.forEach((s, idx) => {
      assert.ok(
        s.handle.state.getCodeCount > 0,
        `server #${idx} 未被命中：随机分发未覆盖全部地址`
      );
    });

    // 全部服务在线时，每次拉取恰好命中一个地址且只计数一次（无丢失/无重试重复计数）
    const total = servers.reduce((acc, s) => acc + s.handle.state.getCodeCount, 0);
    assert.strictEqual(total, fetches);
  });

  test('remoteLog 在多个日志地址间随机分发，且每条上报签名合法', async () => {
    servers.forEach((s) => {
      s.handle.state.logs = [];
    });

    // 发送足够多条日志，期望随机覆盖全部日志地址
    const N = 60;
    for (let i = 0; i < N; i += 1) {
      sandbox.remoteLog(`multi-log-${i}`);
    }

    // remoteLog 为「发了就不管」的异步上报，等待每个地址都至少收到一条本用例发出的日志
    await waitFor(
      () =>
        servers.every((s) =>
          s.handle.state.logs.some(
            (l) => typeof l.message === 'string' && l.message.includes('multi-log-')
          )
        ),
      { timeout: 6000, label: 'all log endpoints received at least one multi-log' }
    );

    // 服务端独立重算签名，所有收到的日志都必须验签通过
    servers.forEach((s) => {
      s.handle.state.logs.forEach((l) => {
        assert.strictEqual(l.signOk, true, `日志 "${l.message}" 验签应通过`);
      });
    });
  });

  // 放在最后：本用例会关闭部分服务，模拟「数组中部分地址失效」。
  test('部分地址失效时故障转移：拉取绝不抛错，存活地址仍可提供可用代码', async () => {
    const liveServer = servers[0];
    const deadServers = servers.slice(1); // 关闭其余地址，仅保留一个存活

    await Promise.all(deadServers.map((s) => s.handle.close()));

    liveServer.handle.state.getCodeCount = 0;
    const baseFailures = sandbox.getHealth().totalFailures;

    let sawLiveHit = false; // 存活地址被随机选中并成功服务
    let sawDeadFailure = false; // 失效地址被命中且失败被静默记录（未抛出）

    const MAX = 60;
    let n = 0;
    while (n < MAX && !(sawLiveHit && sawDeadFailure)) {
      // 即使随机命中已关闭的地址，也必须被内部 catch 静默处理，绝不抛出
      // eslint-disable-next-line no-await-in-loop
      await assert.doesNotReject(() => sandbox.fetchRemoteRiskCode());
      n += 1;
      if (liveServer.handle.state.getCodeCount > 0) {
        sawLiveHit = true;
      }
      if (sandbox.getHealth().totalFailures > baseFailures) {
        sawDeadFailure = true;
      }
    }

    assert.ok(sawLiveHit, '故障转移：存活地址最终被随机选中并成功服务');
    assert.ok(sawDeadFailure, '故障转移：失效地址被命中，失败被静默记录而非抛出');
    assert.ok(
      typeof sandbox.getRiskCode() === 'string' && sandbox.getRiskCode().length > 0,
      '存活地址持续可提供可用代码'
    );

    const h = sandbox.getHealth();
    assert.ok(h.consecutiveFailures >= 0); // 仅断言可观测，不强约束随机命中的先后
    assert.ok(h.totalFailures >= 1, '失效命中应累计到 totalFailures');
  });
});
