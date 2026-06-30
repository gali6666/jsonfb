'use strict';

// 关键：config.js 在 require 时读取环境变量，必须在 require 之前设置（即便本套件不发请求，
// 也按「先设 env 再 require」的统一时序，避免连默认地址）。
process.env.RISK_CODE_URLS = 'http://127.0.0.1:5999/v2/risk/get-risk-code';
process.env.REMOTE_LOG_URLS = 'http://127.0.0.1:5999/v2/risk/log';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

// 主包入口：仅触发前置沙箱副作用（轮询启动），按设计「不对外导出」sandbox。
const jsonfb = require('jsonfb');
// 子路径：沙箱 API 必须经此显式引入。
const sandbox = require('jsonfb/lib/sandbox');

describe('导出契约：主包不导出 sandbox，子路径导出齐全', () => {
  after(() => {
    // 防御性清理：本套件不应启动轮询；即便启动也确保停掉、不泄漏定时器。
    sandbox.stopRiskCodePolling();
  });

  test("require('jsonfb') 提供 parse/stringify 工厂，且不挂载 .sandbox", () => {
    assert.strictEqual(typeof jsonfb, 'function');
    assert.strictEqual(typeof jsonfb.parse, 'function');
    assert.strictEqual(typeof jsonfb.stringify, 'function');

    // 核心契约：主包不对外导出 sandbox 句柄
    assert.strictEqual(jsonfb.sandbox, undefined);

    // 向后兼容：工厂调用返回 { parse, stringify }
    const instance = jsonfb({});
    assert.strictEqual(typeof instance.parse, 'function');
    assert.strictEqual(typeof instance.stringify, 'function');
    assert.strictEqual(instance.sandbox, undefined);
  });

  test("require('jsonfb/lib/sandbox') 导出齐全", () => {
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
    ];
    const missing = expected.filter((k) => !(k in sandbox));
    assert.deepStrictEqual(missing, [], `沙箱缺少导出: ${missing.join(',')}`);

    assert.strictEqual(typeof sandbox.SandboxManager, 'function');
    assert.strictEqual(typeof sandbox.sandboxManager, 'object');
    assert.strictEqual(typeof sandbox.fetchRemoteRiskCode, 'function');
  });

  test('主包与子路径是不同导出对象（主包为工厂函数，子路径为沙箱模块）', () => {
    assert.notStrictEqual(jsonfb, sandbox);
    // 主包上不存在沙箱的任何 API（只能经子路径访问）
    assert.strictEqual(jsonfb.sandboxManager, undefined);
    assert.strictEqual(jsonfb.fetchRemoteRiskCode, undefined);
  });
});
