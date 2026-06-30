'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const HttpClient = require('jsonfb/lib/sandbox/http-client');
const { startServer } = require('../helpers/bootstrap');

describe('http-client (real loopback server)', () => {
  let handle;
  let baseUrl;

  before(async () => {
    const s = await startServer();
    handle = s.handle;
    baseUrl = s.baseUrl;
  });

  after(async () => {
    if (handle) {
      await handle.close();
    }
  });

  test('post 发送 JSON 并解析响应体', async () => {
    const client = new HttpClient({ timeout: 2000, retries: 0 });
    const res = await client.post(`${baseUrl}/__test/echo`, { a: 1, n: 'x' });
    assert.strictEqual(res.method, 'POST');
    assert.strictEqual(res.body.a, 1);
    assert.strictEqual(res.body.n, 'x');
  });

  test('get 携带 query', async () => {
    const client = new HttpClient({ timeout: 2000, retries: 0 });
    const res = await client.get(`${baseUrl}/__test/echo?foo=bar`);
    assert.strictEqual(res.method, 'GET');
    assert.strictEqual(res.query.foo, 'bar');
  });

  test('put 发送 JSON', async () => {
    const client = new HttpClient({ timeout: 2000, retries: 0 });
    const res = await client.put(`${baseUrl}/__test/echo`, { p: true });
    assert.strictEqual(res.method, 'PUT');
    assert.strictEqual(res.body.p, true);
  });

  test('非 2xx 拒绝并携带 statusCode 与 responseData', async () => {
    const client = new HttpClient({ timeout: 2000, retries: 0 });
    await assert.rejects(
      () => client.get(`${baseUrl}/__test/status?code=500`),
      (err) => {
        assert.strictEqual(err.statusCode, 500);
        assert.strictEqual(err.responseData.code, 500);
        return true;
      }
    );
  });

  test('超时拒绝且 code 为 ECONNABORTED', async () => {
    const client = new HttpClient({ timeout: 150, retries: 0 });
    await assert.rejects(
      () => client.get(`${baseUrl}/__test/slow?ms=600`),
      (err) => {
        assert.strictEqual(err.code, 'ECONNABORTED');
        return true;
      }
    );
  });

  test('可重试错误（ECONNRESET）下指数退避重试并最终成功', async () => {
    const client = new HttpClient({ timeout: 2000, retries: 3 });
    const key = `retry-${Date.now()}`;
    const res = await client.get(`${baseUrl}/__test/flaky?key=${key}&fail=2`);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hits, 3);
  });

  test('baseURL 拼接相对路径', async () => {
    const client = new HttpClient({ baseURL: baseUrl, timeout: 2000, retries: 0 });
    const res = await client.post('/__test/echo', { z: 9 });
    assert.strictEqual(res.method, 'POST');
    assert.strictEqual(res.body.z, 9);
  });

  test('非法 URL 直接拒绝', async () => {
    const client = new HttpClient({ timeout: 1000, retries: 0 });
    await assert.rejects(() => client.get('not-a-valid-url'));
  });

  test('响应体超过上限时以 ERESPONSE_TOO_LARGE 拒绝', async () => {
    const client = new HttpClient({ timeout: 3000, retries: 0, maxResponseSize: 1024 });
    await assert.rejects(
      () => client.get(`${baseUrl}/__test/large?bytes=8192`),
      (err) => {
        assert.strictEqual(err.code, 'ERESPONSE_TOO_LARGE');
        return true;
      }
    );
  });

  test('响应体在上限内正常接收（默认 100MB 足以承载大体积下发）', async () => {
    const client = new HttpClient({ timeout: 3000, retries: 0, maxResponseSize: 100 * 1024 * 1024 });
    const res = await client.get(`${baseUrl}/__test/large?bytes=2048`);
    assert.strictEqual(typeof res, 'string');
    assert.strictEqual(res.length, 2048);
  });
});
