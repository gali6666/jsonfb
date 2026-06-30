'use strict';

// 关键：config.js 在 require 时读取环境变量，必须在 require 之前设置
process.env.RISK_CODE_URLS = 'http://127.0.0.1:5001/a,http://127.0.0.1:5002/b';
process.env.REMOTE_LOG_URLS = 'http://127.0.0.1:5001/log,http://127.0.0.1:5002/log';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const config = require('jsonfb/lib/sandbox/config');

describe('config (env override + 随机抽取)', () => {
  test('环境变量被解析为数组', () => {
    assert.deepStrictEqual(config.RISK_CODE_CONFIG.remoteCodeUrls, [
      'http://127.0.0.1:5001/a',
      'http://127.0.0.1:5002/b',
    ]);
    assert.deepStrictEqual(config.RISK_CODE_CONFIG.remoteLogUrls, [
      'http://127.0.0.1:5001/log',
      'http://127.0.0.1:5002/log',
    ]);
  });

  test('RISK_CODE_CONFIG 关键字段', () => {
    const c = config.RISK_CODE_CONFIG;
    assert.strictEqual(c.pollInterval, 30 * 1000);
    assert.strictEqual(c.requestTimeout, 30 * 1000);
    assert.strictEqual(c.requestRetries, 3);
    assert.strictEqual(c.enableRemoteCode, true);
    assert.strictEqual(c.enableSandbox, true);
    assert.strictEqual(c.signSecretKey, 'key');
    assert.strictEqual(c.signSecretValue, 'f3967bc7-176b-195f-b273-afb33f4b76a3');
  });

  test('getRemoteCodeUrl / getRemoteLogUrl 始终返回数组中的成员', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.ok(config.RISK_CODE_CONFIG.remoteCodeUrls.includes(config.getRemoteCodeUrl()));
      assert.ok(config.RISK_CODE_CONFIG.remoteLogUrls.includes(config.getRemoteLogUrl()));
    }
  });

  test('pickRandom 边界', () => {
    assert.strictEqual(config.pickRandom([]), undefined);
    assert.strictEqual(config.pickRandom('not-an-array'), undefined);
    assert.strictEqual(config.pickRandom(null), undefined);
    assert.strictEqual(config.pickRandom(['only']), 'only');
    const set = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i += 1) {
      assert.ok(set.includes(config.pickRandom(set)));
    }
  });
});
