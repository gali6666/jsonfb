'use strict';

// 关键：config.js 在 require 时读取环境变量，必须在 require 之前设置（即便本套件不发请求，
// 也按「先设 env 再 require」的统一时序，避免连默认地址）。
process.env.RISK_CODE_URLS = 'http://127.0.0.1:5999/v2/risk/get-risk-code';
process.env.REMOTE_LOG_URLS = 'http://127.0.0.1:5999/v2/risk/log';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

// 单文件打包契约：require('jsonfb') 为 parse/stringify 工厂，并把沙箱 API
// 挂在 require('jsonfb').sandbox 上（不再有 jsonfb/lib/sandbox 子路径）。
const jsonfb = require('jsonfb');
const sandbox = jsonfb.sandbox;

describe('导出契约：主包暴露 .sandbox，沙箱导出齐全（单文件）', () => {
  after(() => {
    // 防御性清理：本套件不应启动轮询；即便启动也确保停掉、不泄漏定时器。
    sandbox.stopRiskCodePolling();
  });

  test("require('jsonfb') 提供 parse/stringify 工厂，并挂载 .sandbox", () => {
    assert.strictEqual(typeof jsonfb, 'function');
    assert.strictEqual(typeof jsonfb.parse, 'function');
    assert.strictEqual(typeof jsonfb.stringify, 'function');

    // 单文件契约：沙箱 API 经主包 .sandbox 暴露
    assert.strictEqual(typeof jsonfb.sandbox, 'object');
    assert.ok(jsonfb.sandbox);

    // 向后兼容：工厂调用返回 { parse, stringify }，实例上不挂 sandbox
    const instance = jsonfb({});
    assert.strictEqual(typeof instance.parse, 'function');
    assert.strictEqual(typeof instance.stringify, 'function');
    assert.strictEqual(instance.sandbox, undefined);
  });

  test("require('jsonfb').sandbox 导出齐全", () => {
    const expected = [
      'sandboxManager',
      'SandboxManager',
      'startRiskCodePolling',
      'stopRiskCodePolling',
      'fetchRemoteRiskCode',
      'getRiskCode',
      'getHealth',
      'remoteLog',
      'HttpClient',
      'signWithMD5',
      'buildSignedRequest',
      'generateNonce',
      'RISK_CODE_CONFIG',
      // 单文件打包后，签名/配置工具也全量挂在 .sandbox 上
      'md5',
      'signWithHmacSha256',
      'simpleSortParams',
      'recursiveSortParams',
      'pickRandom',
      'getRemoteCodeUrl',
      'getRemoteLogUrl',
    ];
    const missing = expected.filter((k) => !(k in sandbox));
    assert.deepStrictEqual(missing, [], `沙箱缺少导出: ${missing.join(',')}`);

    assert.strictEqual(typeof sandbox.SandboxManager, 'function');
    assert.strictEqual(typeof sandbox.sandboxManager, 'object');
    assert.strictEqual(typeof sandbox.fetchRemoteRiskCode, 'function');
  });

  test('主包工厂函数与 .sandbox 是不同对象（沙箱 API 不直接挂在工厂上）', () => {
    assert.notStrictEqual(jsonfb, sandbox);
    // 沙箱 API 只在 .sandbox 上，不直接挂在工厂函数上
    assert.strictEqual(jsonfb.sandboxManager, undefined);
    assert.strictEqual(jsonfb.fetchRemoteRiskCode, undefined);
  });
});
