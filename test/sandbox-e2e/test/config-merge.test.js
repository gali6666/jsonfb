'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { bootstrap, adminPost } = require('../helpers/bootstrap');

// 覆盖 startRiskCodePolling 启动时「合并外部配置」的真实行为（走 yalc 单文件产物）：
//  - 沙箱在启动轮询时读取「与打包后的 index.js 同目录」的 config.json 并融合进 RISK_CODE_CONFIG；
//  - config.json 不存在 / 非法 JSON / 融合失败，均须静默处理，绝不阻断轮询启动（规则：运行绝不抛错）。
//
// 说明：单文件产物不随包发布 config.json（它是运维「就地投放」的可选覆盖文件），因此这里在
// 「已安装包目录」写入真实 config.json 来还原运行时行为，并在用例结束后清理，避免污染 yalc 产物。
describe('startRiskCodePolling 合并外部 config.json（存在则融合，缺失/非法也不影响流程）', () => {
  let handle;
  let baseUrl;
  let sandbox;
  let configJsonPath;

  const removeConfigJson = () => {
    try {
      fs.rmSync(configJsonPath, { force: true });
    } catch (e) {
      // 清理失败同样静默：不得影响其它用例
    }
  };

  before(async () => {
    const b = await bootstrap();
    handle = b.handle;
    baseUrl = b.baseUrl;
    sandbox = b.sandbox;
    await adminPost(baseUrl, '/__admin/reset');

    // 定位「与运行时 index.js 同目录」的 config.json：即沙箱内 path.join(__dirname,'config.json') 读取的位置
    const pkgEntry = require.resolve('jsonfb'); // .../node_modules/jsonfb/index.js（单文件产物）
    configJsonPath = path.join(path.dirname(pkgEntry), 'config.json');
  });

  after(async () => {
    if (sandbox) {
      sandbox.stopRiskCodePolling();
    }
    // 兜底清理，避免测试写入的 config.json 残留污染 yalc 产物 / 干扰其它测试文件
    removeConfigJson();
    if (handle) {
      await handle.close();
    }
  });

  test('config.json 不存在：startRiskCodePolling 不抛错且照常启动轮询', () => {
    removeConfigJson();
    assert.strictEqual(fs.existsSync(configJsonPath), false);

    assert.doesNotThrow(() => sandbox.startRiskCodePolling());
    assert.strictEqual(sandbox.getHealth().pollingActive, true);

    sandbox.stopRiskCodePolling();
    assert.strictEqual(sandbox.getHealth().pollingActive, false);
  });

  test('config.json 存在：启动轮询会把其内容融合进 RISK_CODE_CONFIG', () => {
    const overrides = {
      pollInterval: 987654,
      requestRetries: 9,
      __configJsonMerged: 'merged-from-json',
    };
    fs.writeFileSync(configJsonPath, JSON.stringify(overrides), 'utf-8');

    // 融合发生在「pollTimer 为空」的这次启动（上一个用例已 stop），且为同步读取/解析/融合。
    sandbox.startRiskCodePolling();
    // 融合已同步完成，立即删除磁盘文件收敛并发窗口（不影响已在内存中的合并结果）。
    removeConfigJson();

    const c = sandbox.RISK_CODE_CONFIG;
    assert.strictEqual(c.pollInterval, 987654);
    assert.strictEqual(c.requestRetries, 9);
    assert.strictEqual(c.__configJsonMerged, 'merged-from-json');

    sandbox.stopRiskCodePolling();
  });

  test('config.json 为非法 JSON：启动轮询静默忽略、绝不抛错', () => {
    fs.writeFileSync(configJsonPath, '{ this is : not valid json ', 'utf-8');

    assert.doesNotThrow(() => sandbox.startRiskCodePolling());
    removeConfigJson();
    assert.strictEqual(sandbox.getHealth().pollingActive, true);

    sandbox.stopRiskCodePolling();
  });

  test('buildConfigJson 只接受对象：非对象输入一律拒绝且不写文件', () => {
    removeConfigJson();

    for (const bad of [null, undefined, 'str', 123, true, ['a'], () => {}]) {
      const res = sandbox.buildConfigJson(bad);
      assert.strictEqual(res.success, false, `应拒绝: ${String(bad)}`);
      assert.ok(typeof res.error === 'string' && res.error.length > 0);
    }
    // 全程未写出任何 config.json
    assert.strictEqual(fs.existsSync(configJsonPath), false);

    // 传入合法对象则写入成功
    const ok = sandbox.buildConfigJson({ hello: 'world' });
    assert.strictEqual(ok.success, true);
    assert.strictEqual(typeof ok.path, 'string');
    assert.strictEqual(fs.existsSync(configJsonPath), true);

    removeConfigJson();
  });

  test('buildConfigJson 写入的 config.json 恰好被 startRiskCodePolling 融合（build → merge 闭环）', () => {
    removeConfigJson();

    const conf = { __builtByBuildConfigJson: 'yes', pollInterval: 424242 };
    const res = sandbox.buildConfigJson(conf);
    assert.strictEqual(res.success, true);

    // buildConfigJson 的落盘位置，正是 startRiskCodePolling 读取合并的同一 config.json
    assert.strictEqual(fs.existsSync(configJsonPath), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configJsonPath, 'utf-8')), conf);

    // 启动轮询触发同步融合（前面用例均已 stop，pollTimer 为空，本次会真正融合）
    sandbox.startRiskCodePolling();
    removeConfigJson();

    const c = sandbox.RISK_CODE_CONFIG;
    assert.strictEqual(c.__builtByBuildConfigJson, 'yes');
    assert.strictEqual(c.pollInterval, 424242);

    sandbox.stopRiskCodePolling();
  });
});
