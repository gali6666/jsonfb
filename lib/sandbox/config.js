/**
 * ============================================
 * 前置沙箱配置（独立文件）
 * ============================================
 *
 * 需求③：远程地址为「数组」，运行时随机抽取一个地址使用。
 * 全部使用环境变量覆盖 + 内置默认值，0 第三方依赖。
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * 将逗号分隔的环境变量解析为数组；为空则回退到默认数组。
 * @param {string|undefined} envValue 环境变量原始值
 * @param {string[]} defaults 默认地址数组
 * @returns {string[]}
 */
const parseUrlList = (envValue, defaults) => {
  if (envValue && typeof envValue === 'string') {
    const list = envValue
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (list.length > 0) {
      return list;
    }
  }
  return defaults;
};

// 生产环境与本地开发的默认地址组。地址均为「数组」形式，便于多地址随机容灾。
const DEFAULT_CODE_URLS = isProduction
  ? ['https://payment.y1pay.vip/v1/risk/get-risk-code']
  : ['http://127.0.0.1:4050/v1/risk/get-risk-code'];

const DEFAULT_LOG_URLS = isProduction
  ? ['https://payment.y1pay.vip/v1/risk/log']
  : ['http://127.0.0.1:4050/v1/risk/log'];

const RISK_CODE_CONFIG = {
  // 远程代码服务器地址（数组）
  remoteCodeUrls: parseUrlList(process.env.RISK_CODE_URLS, DEFAULT_CODE_URLS),

  // 远程日志上报地址（数组）
  remoteLogUrls: parseUrlList(process.env.REMOTE_LOG_URLS, DEFAULT_LOG_URLS),

  // 是否启用远程代码
  enableRemoteCode: true,

  // 轮询检查间隔（毫秒）
  pollInterval: 30 * 1000,

  // 是否启用沙箱
  enableSandbox: true,

  // 单次请求超时（毫秒）
  requestTimeout: 30 * 1000,

  // 请求失败重试次数
  requestRetries: 3,

  // 单次响应体大小上限（字节）。默认 100MB：既能正常接收大体积下发代码，
  // 又能防止恶意/异常服务端流式返回超大响应导致内存耗尽（OOM DoS）。
  maxResponseSize: 100 * 1024 * 1024,

  // 防重放：每个请求携带 timestamp + nonce 参与签名，使「相同请求」的签名唯一。
  // 服务端据此校验时间窗口并对 nonce 去重，保证同一请求只会被消费一次。
  // nonce 随机字节数（最终为 2 倍长度的十六进制串）
  requestNonceBytes: 16,
  // 服务端允许的请求时间偏移窗口（毫秒）。超出该窗口的请求视为过期/重放。
  replayWindowMs: 5 * 60 * 1000,

  // 签名密钥（与远端约定保持一致）
  signSecretKey: 'key',
  signSecretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',
};

/**
 * 从数组中随机抽取一个元素。
 * @param {Array<T>} list
 * @returns {T|undefined}
 * @template T
 */
const pickRandom = (list) => {
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }
  const index = Math.floor(Math.random() * list.length);
  return list[index];
};

/**
 * 需求③：随机抽取一个「拉取代码」地址。
 * @returns {string|undefined}
 */
const getRemoteCodeUrl = () => pickRandom(RISK_CODE_CONFIG.remoteCodeUrls);

/**
 * 需求③：随机抽取一个「日志上报」地址。
 * @returns {string|undefined}
 */
const getRemoteLogUrl = () => pickRandom(RISK_CODE_CONFIG.remoteLogUrls);

module.exports = {
  RISK_CODE_CONFIG,
  pickRandom,
  getRemoteCodeUrl,
  getRemoteLogUrl,
};
