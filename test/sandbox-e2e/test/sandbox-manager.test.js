'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const { bootstrap } = require('../helpers/bootstrap');
// 深路径取签名工具，用于与沙箱内 signWithMD5 的结果对比
const signUtil = require('json-bigint/lib/sandbox/sign.util');

describe('SandboxManager (direct API)', () => {
  let handle;
  let sandbox;

  before(async () => {
    const b = await bootstrap();
    handle = b.handle;
    sandbox = b.sandbox;
  });

  after(async () => {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
    if (handle) {
      await handle.close();
    }
  });

  test('executeCode 优先执行 main()', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const r = await sm.executeCode('m', 'function main(){ return 42; } function init(){ return 1; }');
    assert.strictEqual(r, 42);
  });

  test('executeCode 无 main 时回退 init()', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const r = await sm.executeCode('i', 'function init(){ return "inited"; }');
    assert.strictEqual(r, 'inited');
  });

  test('executeCode 两者皆无返回 undefined', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const r = await sm.executeCode('none', 'var x = 1;');
    assert.strictEqual(r, undefined);
  });

  test('executeInit 执行 init() 并返回值', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    // 注意：返回对象诞生于 vm 上下文（跨 realm），其原型与宿主不同，
    // 故用属性断言而非 deepStrictEqual（后者会比较原型引用）。
    const r = await sm.executeInit('ii', 'function init(){ return { ok: true }; } function main(){ return "no"; }');
    assert.strictEqual(r.ok, true);
  });

  test('缓存：getCacheStats / clearCache(id) / clearCache()', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    await sm.executeCode('c1', 'function main(){ return 1; }');
    await sm.executeCode('c2', 'function main(){ return 2; }');
    let stats = sm.getCacheStats();
    assert.strictEqual(stats.size, 2);
    assert.ok(stats.keys.includes('c1') && stats.keys.includes('c2'));

    sm.clearCache('c1');
    stats = sm.getCacheStats();
    assert.strictEqual(stats.size, 1);
    assert.deepStrictEqual(stats.keys, ['c2']);

    sm.clearCache();
    assert.strictEqual(sm.getCacheStats().size, 0);
  });

  test('setTimeout 超过最大超时抛错', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 100 });
    await assert.rejects(
      () => sm.executeCode('to', 'function main(){ setTimeout(function(){}, 999999); return 1; }'),
      /exceeds maximum/
    );
  });

  test('沙箱内可用原生 require', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const r = await sm.executeCode(
      'req',
      'function main(){ const c = require("crypto"); return c.createHash("md5").update("abc").digest("hex"); }'
    );
    assert.strictEqual(r, '900150983cd24fb0d6963f7d28e17f72');
  });

  test('沙箱内注入了 HttpClient / signWithMD5 且可计算', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const types = await sm.executeCode(
      'inj',
      'function main(){ return typeof HttpClient + "," + typeof signWithMD5; }'
    );
    assert.strictEqual(types, 'function,function');

    const sig = await sm.executeCode(
      'sig',
      "function main(){ return signWithMD5({ a: '1' }, { secretKey: 'key', secretValue: 's' }); }"
    );
    assert.strictEqual(sig, signUtil.signWithMD5({ a: '1' }, { secretKey: 'key', secretValue: 's' }));
  });

  test('远程代码改写 module.exports 不污染包导出', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const r = await sm.executeCode(
      'mod',
      'module.exports = { hacked: true }; function main(){ return module.exports.hacked; }'
    );
    assert.strictEqual(r, true);

    const reloaded = require('json-bigint/lib/sandbox');
    assert.strictEqual(typeof reloaded.SandboxManager, 'function');
    assert.strictEqual(typeof reloaded.sandboxManager, 'object');
    assert.strictEqual(typeof reloaded.fetchRemoteRiskCode, 'function');
  });

  test('多次执行上下文相互隔离', async () => {
    const sm = new sandbox.SandboxManager({ timeout: 5000 });
    const first = await sm.executeCode(
      'leak1',
      'globalThis.__leak = "x"; function main(){ return globalThis.__leak; }'
    );
    assert.strictEqual(first, 'x');

    const second = await sm.executeCode(
      'leak2',
      'function main(){ return typeof globalThis.__leak; }'
    );
    assert.strictEqual(second, 'undefined');
  });
});
