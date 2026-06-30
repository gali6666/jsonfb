/**
 * 远程 Mock 服务的签名工具（独立实现，仅依赖 Node 内置 crypto）。
 *
 * 与被测包 lib/sandbox/sign.util.js 的 signWithMD5 同算法，但**不反向 require 被测包**，
 * 以保证服务端是真正独立的「远端」，能对客户端签名做真实校验，并在测试中交叉验证一致性。
 */

const crypto = require('crypto');

/**
 * 生成 MD5（小写十六进制）。
 * @param {string} data
 * @returns {string}
 */
const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');

/**
 * 过滤空值/忽略字段并按字段名排序（localeCompare，与 sign.util 的非 ASCII 排序一致），
 * 返回 "k1=v1&k2=v2" 形式；recursive=true 时递归处理嵌套对象。
 * @param {Object} params
 * @param {boolean} recursive
 * @param {string[]} [ignore=['sign']]
 * @returns {string}
 */
const sortParams = (params, recursive, ignore = ['sign']) =>
  Object.keys(params)
    .filter(
      (k) =>
        params[k] !== '' &&
        params[k] !== null &&
        params[k] !== undefined &&
        !ignore.includes(k)
    )
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const v = params[k];
      if (typeof v === 'bigint') {
        return `${k}=${v.toString()}`;
      }
      if (Array.isArray(v)) {
        return `${k}=${JSON.stringify(v)}`;
      }
      if (recursive && typeof v === 'object' && v !== null) {
        return `${k}=${sortParams(v, true, ignore)}`;
      }
      if (typeof v === 'object' && v !== null) {
        return `${k}=${v}`;
      }
      return `${k}=${v}`;
    })
    .join('&');

/**
 * 计算签名：md5(sortedParams + "&secretKey=secretValue")。
 * @param {Object} data
 * @param {{secretKey:string, secretValue:string, recursive?:boolean}} options
 * @returns {string}
 */
const computeSign = (data, { secretKey, secretValue, recursive = false }) => {
  const sorted = sortParams(data, !!recursive);
  return md5(`${sorted}&${secretKey}=${secretValue}`);
};

/**
 * 校验客户端传来的签名是否正确。
 * @param {Object} data 含 sign 字段
 * @param {{secretKey:string, secretValue:string, recursive?:boolean}} options
 * @returns {boolean}
 */
const verifySign = (data, options) => {
  if (!data || typeof data !== 'object') {
    return false;
  }
  return data.sign === computeSign(data, options);
};

module.exports = {
  md5,
  sortParams,
  computeSign,
  verifySign,
};
