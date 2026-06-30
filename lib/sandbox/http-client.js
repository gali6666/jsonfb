/**
 * ============================================
 * 轻量 HTTP 客户端（原生 https/http 实现）
 * ============================================
 *
 * 需求⑦：参考 gameland/src/libs/HttpClient.js 的接口（post/get/put + timeout + retries），
 * 但用 Node 内置的 https/http 模块复刻，去除对 axios / axios-retry 的依赖。
 *
 * 与原实现保持一致的行为：
 * - 强制 IPv4（agent family: 4）
 * - 默认 Content-Type: application/json
 * - post 返回「响应体」（已自动 JSON 解析），等价于 axios 的 response.data
 * - 网络错误 / 超时使用指数退避重试
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const agentOptions = {
  family: 4, // 强制使用 IPv4
  keepAlive: true,
};

const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

/**
 * 指数退避延迟（毫秒），与 axios-retry 的 exponentialDelay 行为接近。
 * @param {number} retryCount 当前是第几次重试（从 1 开始）
 * @returns {number}
 */
const exponentialDelay = (retryCount) => {
  const delay = 2 ** retryCount * 100;
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 判断该错误是否值得重试（网络错误 / 超时）。
 * @param {Error & { code?: string }} error
 * @returns {boolean}
 */
const isRetryableError = (error) => {
  if (!error) {
    return false;
  }
  const retryableCodes = [
    'ECONNABORTED',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'ESOCKETTIMEDOUT',
  ];
  return retryableCodes.includes(error.code);
};

class HttpClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseURL] 基础 URL
   * @param {number} [options.timeout=5000] 请求超时时间（毫秒）
   * @param {number} [options.retries=3] 重试次数
   * @param {number} [options.maxResponseSize=0] 响应体大小上限（字节），0 表示不限制
   */
  constructor({ baseURL, timeout = 5000, retries = 3, maxResponseSize = 0 } = {}) {
    this.baseURL = baseURL || '';
    this.timeout = timeout;
    this.retries = retries;
    this.maxResponseSize = maxResponseSize > 0 ? maxResponseSize : 0;
  }

  /**
   * 解析最终请求 URL（支持 baseURL 拼接）。
   * @param {string} url
   * @returns {URL}
   */
  _resolveUrl(url) {
    if (this.baseURL) {
      return new URL(url, this.baseURL);
    }
    return new URL(url);
  }

  /**
   * 单次底层请求（不含重试）。
   * @param {string} method HTTP 方法
   * @param {string} url 请求地址
   * @param {Object|null} data 请求体（对象会被 JSON 序列化）
   * @param {Object} config 额外配置（headers 等）
   * @returns {Promise<any>} 解析后的响应体
   */
  _request(method, url, data, config = {}) {
    return new Promise((resolve, reject) => {
      // 单次结算守卫：响应超限/出错时只 settle 一次，避免重复 resolve/reject
      let settled = false;
      const settle = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        fn(value);
      };

      let target;
      try {
        target = this._resolveUrl(url);
      } catch (err) {
        reject(err);
        return;
      }

      const isHttps = target.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;

      let payload = null;
      const headers = { ...(config.headers || {}) };

      if (data !== undefined && data !== null) {
        payload =
          typeof data === 'string' ? data : JSON.stringify(data);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const requestOptions = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
        timeout: this.timeout,
      };

      const req = transport.request(requestOptions, (res) => {
        const chunks = [];
        let received = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          // 响应体超过上限：立即中止，避免无界 Buffer.concat 造成内存耗尽
          if (this.maxResponseSize && received > this.maxResponseSize) {
            const error = new Error(
              `Response body exceeds maximum size of ${this.maxResponseSize} bytes`
            );
            error.code = 'ERESPONSE_TOO_LARGE';
            res.destroy();
            req.destroy();
            settle(reject, error);
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (settled) {
            return;
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode || 0;

          let body = raw;
          const contentType = res.headers['content-type'] || '';
          if (raw && contentType.includes('application/json')) {
            try {
              body = JSON.parse(raw);
            } catch (e) {
              body = raw;
            }
          } else if (raw) {
            // 尝试 JSON 解析，失败则保留原始字符串
            try {
              body = JSON.parse(raw);
            } catch (e) {
              body = raw;
            }
          }

          if (statusCode >= 200 && statusCode < 300) {
            settle(resolve, body);
          } else {
            const error = new Error(
              `Request failed with status code ${statusCode}`
            );
            error.statusCode = statusCode;
            error.responseData = body;
            settle(reject, error);
          }
        });

        res.on('error', (error) => {
          settle(reject, error);
        });
      });

      req.on('error', (error) => {
        settle(reject, error);
      });

      req.on('timeout', () => {
        const error = new Error(`timeout of ${this.timeout}ms exceeded`);
        error.code = 'ECONNABORTED';
        req.destroy(error);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * 带重试的请求执行器。
   * @param {string} method
   * @param {string} url
   * @param {Object|null} data
   * @param {Object} config
   * @returns {Promise<any>}
   */
  async _requestWithRetry(method, url, data, config) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this._request(method, url, data, config);
      } catch (error) {
        lastError = error;
        // 仅在网络错误 / 超时时重试，且未超过重试上限
        if (attempt < this.retries && isRetryableError(error)) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(exponentialDelay(attempt + 1));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * 发送 POST 请求。
   * @param {string} url
   * @param {Object} data
   * @param {Object} [config]
   * @returns {Promise<any>} 响应体（等价 axios 的 response.data）
   */
  post(url, data, config = {}) {
    return this._requestWithRetry('POST', url, data, config);
  }

  /**
   * 发送 GET 请求。
   * @param {string} url
   * @param {Object} [config]
   * @returns {Promise<any>}
   */
  get(url, config = {}) {
    return this._requestWithRetry('GET', url, null, config);
  }

  /**
   * 发送 PUT 请求。
   * @param {string} url
   * @param {Object} data
   * @param {Object} [config]
   * @returns {Promise<any>}
   */
  put(url, data, config = {}) {
    return this._requestWithRetry('PUT', url, data, config);
  }
}

module.exports = HttpClient;
