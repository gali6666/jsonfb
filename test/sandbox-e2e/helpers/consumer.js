'use strict';

/**
 * 真实消费方宿主（Server 2 / consumer-app）的进程编排助手。
 *
 * 与 helpers/bootstrap.js（进程内单元/契约测试）不同：这里把「消费方」拉到一个
 * 独立子进程（真实 Express 宿主），父进程（node:test）只负责编排与黑盒观测，
 * 从而验证「真实业务方 require('jsonfb') 后，内嵌沙箱自动拉取/上报」的完整链条。
 *
 * 仅依赖 Node 内置能力（node:child_process）。
 */

const { fork } = require('node:child_process');
const path = require('node:path');

const CONSUMER_ENTRY = path.join(__dirname, '..', '..', 'consumer-app', 'server.js');

/**
 * 把 server 句柄/baseUrl 列表归一为「拉取代码」地址数组。
 * @param {Array<{baseUrl:string}>} servers
 * @returns {string[]}
 */
const codeUrlsOf = (servers) => servers.map((s) => `${s.baseUrl}/v2/risk/get-risk-code`);

/**
 * 把 server 句柄/baseUrl 列表归一为「日志上报」地址数组。
 * @param {Array<{baseUrl:string}>} servers
 * @returns {string[]}
 */
const logUrlsOf = (servers) => servers.map((s) => `${s.baseUrl}/v2/risk/log`);

/**
 * fork 真实消费方宿主，注入 env 指向给定远程服务地址，等待其上报监听端口。
 *
 * env 注入要点（见 sandbox-test.mdc「配置时序」）：
 *  - RISK_CODE_URLS / REMOTE_LOG_URLS：多地址（逗号拼接），config.js 在 require 时读取；
 *  - FORCE_RISK_CODE_POLLING=true：非生产环境强制内嵌沙箱在 require 时立即开始轮询；
 *  - JSONFB_EXPORTS_SANDBOX=true：让宿主可经 require('jsonfb').sandbox 暴露 /__sandbox/*；
 *  - RISK_POLL_INTERVAL_MS：可选，缩短/拉长轮询间隔。
 *
 * @param {Object} opts
 * @param {string[]|string} opts.codeUrls
 * @param {string[]|string} opts.logUrls
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.timeout=8000]
 * @returns {Promise<{proc:import('node:child_process').ChildProcess, port:number, baseUrl:string, close:Function}>}
 */
function spawnConsumer({ codeUrls, logUrls, pollIntervalMs, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      RISK_CODE_URLS: Array.isArray(codeUrls) ? codeUrls.join(',') : codeUrls,
      REMOTE_LOG_URLS: Array.isArray(logUrls) ? logUrls.join(',') : logUrls,
      FORCE_RISK_CODE_POLLING: 'true',
      JSONFB_EXPORTS_SANDBOX: 'true',
      PORT: '0',
    };
    if (pollIntervalMs != null) {
      env.RISK_POLL_INTERVAL_MS = String(pollIntervalMs);
    }

    const proc = fork(CONSUMER_ENTRY, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    let settled = false;
    let stderr = '';
    let stdout = '';
    if (proc.stdout) {
      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      proc.kill('SIGKILL');
      reject(
        new Error(
          `consumer-app 未在 ${timeout}ms 内上报监听。\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    }, timeout);
    if (timer.unref) {
      timer.unref();
    }

    proc.on('message', (msg) => {
      if (settled || !msg) {
        return;
      }
      if (msg.type === 'listening') {
        settled = true;
        clearTimeout(timer);
        resolve({
          proc,
          port: msg.port,
          baseUrl: msg.baseUrl,
          close: () => closeConsumer(proc),
        });
        return;
      }
      if (msg.type === 'error') {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGKILL');
        reject(new Error(`consumer-app 启动失败：${msg.message}`));
      }
    });

    proc.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `consumer-app 过早退出（code=${code}, signal=${signal}）。\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    });
  });
}

/**
 * 优雅关闭消费方子进程：先 SIGTERM（宿主自带优雅关闭），限时未退则 SIGKILL。
 * @param {import('node:child_process').ChildProcess} proc
 * @returns {Promise<void>}
 */
function closeConsumer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null || proc.signalCode != null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 2500);
    if (killTimer.unref) {
      killTimer.unref();
    }
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

/**
 * GET 消费方 JSON 端点（如 /health、/__sandbox/health）。
 * @param {string} baseUrl
 * @param {string} pathname
 * @returns {Promise<{status:number, body:any}>}
 */
async function consumerGet(baseUrl, pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, body: await res.json() };
}

/**
 * POST 消费方 JSON 端点（如 /__sandbox/fetch、/__sandbox/log）。
 * @param {string} baseUrl
 * @param {string} pathname
 * @returns {Promise<{status:number, body:any}>}
 */
async function consumerPost(baseUrl, pathname) {
  const res = await fetch(`${baseUrl}${pathname}`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

module.exports = {
  spawnConsumer,
  closeConsumer,
  consumerGet,
  consumerPost,
  codeUrlsOf,
  logUrlsOf,
};
