'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

// 经 yalc 链接的被测包：直接用其 HttpClient + 签名工具构造请求
const HttpClient = require('json-bigint/lib/sandbox/http-client');
const signUtil = require('json-bigint/lib/sandbox/sign.util');
const { startServer } = require('../helpers/bootstrap');

const SECRET = {
  secretKey: 'key',
  secretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',
};

// 复刻客户端的「唯一签名」构造：timestamp + nonce 参与递归签名
const signCodeRequest = (params) => {
  const p = { ...params };
  p.sign = signUtil.signWithMD5(p, { ...SECRET, recursiveSortParams: true });
  return p;
};

// 防重放契约：服务端按 timestamp 窗口 + nonce 去重，保证同一请求只会被消费一次，
// 抓包拿到完全相同的参数 + 签名再次发起，无法二次换到下发代码。
describe('anti-replay (unique per-request signature + return-once)', () => {
  let handle;
  let baseUrl;
  let client;
  let url;

  before(async () => {
    const s = await startServer();
    handle = s.handle;
    baseUrl = s.baseUrl;
    client = new HttpClient({ timeout: 2000, retries: 0 });
    url = `${baseUrl}/v2/risk/get-risk-code`;
  });

  after(async () => {
    if (handle) {
      await handle.close();
    }
  });

  test('全新 nonce 的请求被正常受理', async () => {
    const body = signCodeRequest({ hash: '1', timestamp: Date.now(), nonce: 'nonce-fresh-1' });
    const res = await client.post(url, body);
    assert.ok(res && res.data);
    assert.ok(res.data.status === 1 || res.data.status === 0);
  });

  test('原样重放（相同 nonce）被拒绝：同一请求只消费一次', async () => {
    const body = signCodeRequest({ hash: '1', timestamp: Date.now(), nonce: 'nonce-replay-1' });

    const first = await client.post(url, body);
    assert.ok(first && first.data && first.data.status !== -1);

    // 抓包重放：完全相同的参数 + 签名再次发送
    await assert.rejects(
      () => client.post(url, body),
      (err) => {
        assert.strictEqual(err.statusCode, 409);
        assert.strictEqual(err.responseData.data.error, 'replayed request');
        return true;
      }
    );
  });

  test('过期 timestamp（超出窗口）的请求被拒绝', async () => {
    const stale = Date.now() - 90 * 60 * 1000; // 90 分钟前，超出 1 小时窗口
    const body = signCodeRequest({ hash: '1', timestamp: stale, nonce: 'nonce-stale-1' });
    await assert.rejects(
      () => client.post(url, body),
      (err) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
  });

  test('缺少 nonce 的请求被拒绝', async () => {
    const body = signCodeRequest({ hash: '1', timestamp: Date.now() });
    await assert.rejects(
      () => client.post(url, body),
      (err) => {
        assert.strictEqual(err.statusCode, 409);
        return true;
      }
    );
  });

  test('篡改签名（伪造）的请求被拒绝', async () => {
    const body = { hash: '1', timestamp: Date.now(), nonce: 'nonce-forged-1', sign: 'deadbeef' };
    await assert.rejects(
      () => client.post(url, body),
      (err) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
  });
});
