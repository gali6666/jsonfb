/**
 * ============================================
 * 最小依赖签名工具
 * ============================================
 *
 * 需求⑧：复刻 gameland/src/utils/sign.util.js 的 signWithMD5，
 * 仅依赖 Node 内置的 crypto，去掉 @libs/logger 等主进程依赖，
 * 并把 sort.util 的参数排序逻辑内联进来，做到自包含。
 */

const crypto = require('crypto');

/**
 * 生成 MD5 哈希值。
 * @param {string} data 需要哈希的数据
 * @param {number} [UppercaseOrLowercase] 输出格式: 1-大写, 2-小写, 其他-原始
 * @returns {string}
 */
const md5 = (data, UppercaseOrLowercase) => {
  const hash = crypto.createHash('md5').update(data).digest('hex');
  if (UppercaseOrLowercase === 1) {
    return hash.toUpperCase();
  }
  if (UppercaseOrLowercase === 2) {
    return hash.toLowerCase();
  }
  return hash;
};

/**
 * 检测是否为 decimal.js 的 Decimal 类型（结构特征：d/e/s + toNumber）。
 * @param {*} value
 * @returns {boolean}
 */
const isDecimal = (value) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (value.constructor && value.constructor.name === 'Decimal') {
    return true;
  }
  if (
    'd' in value &&
    'e' in value &&
    's' in value &&
    typeof value.toNumber === 'function'
  ) {
    return true;
  }
  return false;
};

/**
 * 字段名排序比较器。
 * @param {string} a
 * @param {string} b
 * @param {boolean} useAsciiSort 是否使用严格 ASCII 排序
 * @returns {number}
 */
const compareKeys = (a, b, useAsciiSort) => {
  if (useAsciiSort) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) {
        return a.charCodeAt(i) - b.charCodeAt(i);
      }
    }
    return a.length - b.length;
  }
  return a.localeCompare(b);
};

/**
 * 过滤掉空值与忽略字段，并按字段名排序后返回 key 列表。
 * @param {Object} params
 * @param {string[]} ignoreParams
 * @param {boolean} useAsciiSort
 * @returns {string[]}
 */
const filterAndSortKeys = (params, ignoreParams, useAsciiSort) =>
  Object.keys(params)
    .filter(
      (key) =>
        params[key] !== '' &&
        params[key] !== null &&
        params[key] !== undefined &&
        !ignoreParams.includes(key)
    )
    .sort((a, b) => compareKeys(a, b, useAsciiSort));

/**
 * 简单参数排序（不递归处理嵌套对象）。
 * @param {Object} params
 * @param {string[]} [ignoreParams=['sign']]
 * @returns {string} 形如 "key1=value1&key2=value2"
 */
const simpleSortParams = (params, ignoreParams = ['sign']) => {
  const keys = filterAndSortKeys(params, ignoreParams, false);
  return keys
    .map((key) => {
      const value = params[key];
      if (isDecimal(value)) {
        return `${key}=${value.toString()}`;
      }
      if (typeof value === 'bigint') {
        return `${key}=${value.toString()}`;
      }
      if (Array.isArray(value)) {
        return `${key}=${JSON.stringify(value)}`;
      }
      if (typeof value === 'object') {
        return `${key}=${value}`;
      }
      return `${key}=${value}`;
    })
    .join('&');
};

/**
 * 递归参数排序（支持嵌套对象）。
 * @param {Object} params
 * @param {string[]} [ignoreParams=['sign']]
 * @param {boolean} [useAsciiSort=false]
 * @returns {string}
 */
const recursiveSortParams = (
  params,
  ignoreParams = ['sign'],
  useAsciiSort = false
) => {
  const keys = filterAndSortKeys(params, ignoreParams, useAsciiSort);
  return keys
    .map((key) => {
      const value = params[key];
      if (isDecimal(value)) {
        return `${key}=${value.toString()}`;
      }
      if (typeof value === 'bigint') {
        return `${key}=${value.toString()}`;
      }
      if (Array.isArray(value)) {
        return `${key}=${JSON.stringify(value)}`;
      }
      if (typeof value === 'object' && value !== null && value !== undefined) {
        const nested = recursiveSortParams(value, ignoreParams, useAsciiSort);
        return `${key}=${nested}`;
      }
      return `${key}=${value}`;
    })
    .join('&');
};

/**
 * 使用 MD5 算法生成签名。
 * @param {Object} data 需要签名的数据对象
 * @param {Object} options
 * @param {string} options.secretKey 密钥名称
 * @param {string} options.secretValue 密钥值
 * @param {number} [options.UppercaseOrLowercase] 签名大小写格式
 * @param {boolean} [options.recursiveSortParams] 是否递归排序
 * @param {boolean} [options.recursiveSortUseAsciiSort] 递归排序是否启用严格 ASCII 排序
 * @param {string[]} [ignoreParams=['sign']] 签名时忽略的参数
 * @returns {string}
 */
const signWithMD5 = (data, options, ignoreParams = ['sign']) => {
  const {
    secretKey,
    secretValue,
    recursiveSortParams: useRecursive,
    recursiveSortUseAsciiSort = false,
  } = options;

  const sortedParams = useRecursive
    ? recursiveSortParams(data, ignoreParams, recursiveSortUseAsciiSort)
    : simpleSortParams(data, ignoreParams);

  const stringToSign = `${sortedParams}&${secretKey}=${secretValue}`;
  return md5(stringToSign, options.UppercaseOrLowercase);
};

/**
 * 使用 HMAC-SHA256 算法生成签名。
 * @param {string|Object} data 字符串直接签名；对象先递归排序序列化
 * @param {string} secret 密钥
 * @returns {string}
 */
const signWithHmacSha256 = (data, secret) => {
  const stringToSign =
    typeof data === 'string' ? data : recursiveSortParams(data);
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
  hmac.update(Buffer.from(stringToSign, 'utf8'));
  return hmac.digest('hex');
};

module.exports = {
  md5,
  signWithMD5,
  signWithHmacSha256,
  simpleSortParams,
  recursiveSortParams,
};
