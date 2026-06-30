/**
 * 端到端测试引导助手。
 *
 * 关键时序：config.js 在 require 时读取 process.env.RISK_CODE_URLS / REMOTE_LOG_URLS，
 * 因此必须「先启动真实 mock 服务 -> 设好环境变量 -> 再 require 被测包」。
 *
 * 仅依赖 Node 内置能力（node:test 通过 require 调用本文件，本文件不引入第三方依赖）。
 */

const { createServer } = require('../../remote-mock-server/server');

/**
 * 启动一个真实 mock 服务（随机可用端口）。
 * @returns {Promise<{handle:Object, port:number, baseUrl:string}>}
 */
async function startServer() {
  const handle = createServer();
  const { port, baseUrl } = await handle.listen(0);
  return { handle, port, baseUrl };
}

/**
 * 把沙箱配置指向给定服务地址（必须在 require 被测包之前调用）。
 * @param {string} baseUrl
 */
function configureEnv(baseUrl) {
  process.env.RISK_CODE_URLS = `${baseUrl}/v1/risk/get-risk-code`;
  process.env.REMOTE_LOG_URLS = `${baseUrl}/v1/risk/log`;
}

/**
 * 完整引导：起服务 -> 设环境变量 -> require 被测包的前置沙箱。
 * @returns {Promise<{handle:Object, port:number, baseUrl:string, sandbox:Object}>}
 */
async function bootstrap() {
  const { handle, port, baseUrl } = await startServer();
  configureEnv(baseUrl);
  // 必须在 env 设置完成后才 require（触发 config 读取环境变量）
  // eslint-disable-next-line global-require
  const sandbox = require('json-bigint/lib/sandbox');
  return { handle, port, baseUrl, sandbox };
}

/**
 * 读取 mock 服务的观测状态。
 * @param {string} baseUrl
 * @returns {Promise<Object>}
 */
async function adminState(baseUrl) {
  const res = await fetch(`${baseUrl}/__admin/state`);
  return res.json();
}

/**
 * POST 到 mock 服务的某个端点（JSON）。
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {Object} [body]
 * @returns {Promise<Object>}
 */
async function adminPost(baseUrl, pathname, body = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * 轮询等待条件成立。
 * @param {() => (boolean|Promise<boolean>)} predicate
 * @param {{timeout?:number, interval?:number, label?:string}} [opts]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, { timeout = 4000, interval = 25, label = 'condition' } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms: ${label}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = {
  startServer,
  configureEnv,
  bootstrap,
  adminState,
  adminPost,
  waitFor,
};
