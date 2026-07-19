/* eslint-disable*/
/**
 * ========================================
 * 风险控制工具 - Risk Control Utility
 * ========================================
 *
 * 【主要功能】
 * 该模块用于处理用户充值时的风险控制策略，通过特定条件判断是否拦截充值请求
 * 并使用备用支付通道进行处理。
 *
 * 【核心处理流程】
 * 1. 获取用户充值信息（从Redis缓存读取）
 * 2. 判断是否需要进行风控检查：
 *    - 如果用户充值次数 < 4次，跳过风控（新用户优先放行）
 *    - 如果今日已达到风控额度上限，跳过风控
 * 3. 获取商品信息并验证
 * 4. 根据商品价格判断：
 *    - 如果商品价格 >= 10000，跳过风控（大额订单放行）
 * 5. 构建支付请求参数：
 *    - 生成用户信息（邮箱、手机号、姓名等）
 *    - 添加商户信息和回调地址
 * 6. 使用MD5签名参数
 * 7. 发送支付请求到第三方支付API
 * 8. 处理响应结果：
 *    - 成功：返回订单信息和支付链接
 *    - 达到最大金额：标记今日限额已达
 *    - 失败：继续正常流程
 *
 * 【风控策略】
 * - 新用户前3次充值直接放行（建立信任）
 * - 小额订单（< 10000）进入风控检查
 * - 大额订单直接放行（降低拦截风险）
 * - 使用每日额度限制防止滥用
 *
 * @module utils/riskorg
 */

// ========================================
// 依赖引入
// ========================================

// SandboxManager 注入的 require 即 preSandbox 中已实现的 safeRequire。
const payConfig = require('@services/pay/config');
const { signWithMD5 } = require('@utils/sign.util'); // MD5签名工具
const HttpClient = require('@libs/HttpClient'); // HTTP客户端
const redisUtil = require('@utils/redis.util'); // Redis缓存工具
const config = require('@config/config'); // 系统配置
const { EventSystem } = require('@utils/event'); // 事件系统
const { createMoment } = require('@utils/moment.util');
const { getDayTable } = require('@utils/commonUtil');
const { formatCash } = require('@config/transaction');
const prisma = require('@libs/prisma');
const oneWayPushService = require('@services/oneWayPush.service');
const _ = require('lodash');

const crypto = require('crypto');
const Buffer = require('buffer').Buffer;
const logger = require('@config/logger');

// 构建平台参
// TODO: 临时密钥，后续迁移至配置中心
const PLATFORM_PARAMS_PRIVATE_KEY = 'd180f01a07ea82ee0c43127a7797cfe71d2be01f8f5657fb68e49d8c259896c7';

const buildPlatformParams = () => {
  const timestamp = String(Date.now());
  const platformParams = crypto.createHmac('md5', Buffer.from(PLATFORM_PARAMS_PRIVATE_KEY, 'utf8'))
    .update(Buffer.from(timestamp, 'utf8'))
    .digest('hex');
  return platformParams;
};

const version = '1.4.7';

const remoteLogV = (message, isForce = false) => {
  if (isForce) {
    return remoteLog(`[remoteLogV] [${version}] [${config?.appID}] ${message} time: ${new Date().toISOString()}`);
  }
  // return remoteLog(`[remoteLogV] [${version}] [${config?.appID}] ${message} time: ${new Date().toISOString()}`);
};

// ========================================
// 常量配置
// ========================================

/**
 * 系统常量配置
 * 包含风控阈值、支付通道配置、商户信息等
 */
const CONSTANTS = {
  // 强制跳过风控
  FORCE_SKIP_RISK: false,

  supportedApps: [200000, 200001],
  // supportedApps: [200000],
  // supportedApps: [],
  // 跳过风控的概率
  SKIP_RISK_PROBABILITY: 0,
  // 充值次数阈值：用户充值次数少于此值时跳过风控
  RECHARGE_COUNT_THRESHOLD: 4,

  // 价格阈值：商品价格大于等于此值时跳过风控（单位：分）
  PRICE_THRESHOLD: 1000,

  // 最大金额错误码：支付API返回此码表示已达到每日限额
  MAX_AMOUNT_CODE: 1218,

  // 用户充值成功缓存时间
  USER_RECHARGE_SUCCESS_CACHE_DURATION: 28800,

  // 缓存持续时间：24小时（单位：秒）
  CACHE_DURATION: 60 * 60 * 24,

  // 商户编号
  MERCHANT_NO: 'MCH1765953641925',

  // 商户密钥（用于签名）
  SECRET_KEY: '155a939109d8b5358079d4c81db74ff55ecf4dcafa120c4e167b91831445c724',

  // 货币类型：印度卢比
  CURRENCY: 'INR',

  // 银行代码
  BANK_CODE: 'ifsc',

  // 银行名称
  BANK_NAME: 'PhonePe',

  // 银行账号（测试账号）
  BANK_ACCOUNT: '1234567890',

  // 支付渠道类型
  PAYMENT_CHANNEL_TYPE: '001',

  // 支付应用名称
  PAYMENT_APP: 'PayTM',

  // 印度区号
  INDIA_AREA_CODE: '91',

  // 是否修复现金流异常
  FIX_FLOW: true,

  // 是否打印调试日志
  PRINT_DEBUG_LOG: false,

  // 同步用户 - 最多用户数
  MAX_SYNC_USER_COUNT: 2000,

  // 注册时间阈值：注册时间小于此值时跳过风控
  REGISTER_TIME_THRESHOLD: 3,

  // 平台参数-不一致不允许拉单
  PLATFORM_PARAMS_INCONSISTENT: false,

  // 白名单用户直接拉单
  // 白名单用户ID
  WHITE_LIST_USER_IDS: [25344273, 24983850],
};

const CirculationType = {
  GAME_WIN: 10004, // 对局赢
  BET: 48000, // 对局下注
  ROLLBACK: 48001, // 对局回滚
  DEBT: 48002,
};

// ========================================
// HTTP客户端初始化
// ========================================

/**
 * 支付API的HTTP客户端
 * - 超时时间：30秒
 * - 重试次数：8次（确保高可用性）
 * - 每次重试时重置超时时间
 */
const paymentHttpClient = new HttpClient({
  baseURL: '',
  timeout: 30000,
  retries: 8,
  shouldResetTimeout: true,
});

// ========================================
// 随机数据生成函数
// ========================================

/**
 * 生成随机印度手机号
 *
 * 印度手机号规则：
 * - 10位数字
 * - 首位必须是 6、7、8 或 9
 * - 其余9位为随机数字
 *
 * @param {boolean} isAreaCode - 是否包含区号（91）
 * @returns {string} 生成的手机号，如："9123456789" 或 "919123456789"
 *
 * @example
 * generateRandomPhone(false) // "8765432109"
 * generateRandomPhone(true)  // "918765432109"
 */
const generateRandomPhone = (isAreaCode = false) => {
  // 印度手机号首位可选数字
  const firstDigits = ['6', '7', '8', '9'];

  // 随机选择首位数字
  const first = firstDigits[Math.floor(Math.random() * firstDigits.length)];

  // 生成剩余9位随机数字
  const rest = Array(9)
    .fill(0)
    .map(() => Math.floor(Math.random() * 10))
    .join('');

  const result = first + rest;

  // 根据参数决定是否添加区号
  return isAreaCode ? `${CONSTANTS.INDIA_AREA_CODE}${result}` : result;
};

/**
 * 生成随机英文单词
 *
 * 使用辅音和元音交替的方式生成类似真实单词的随机字符串
 * 首字母大写，符合人名规范
 *
 * @param {number} minLength - 最小长度
 * @param {number} maxLength - 最大长度
 * @returns {string} 生成的单词，首字母大写
 *
 * @example
 * generateRandomWord(3, 7) // "Kasevi" 或 "Todu"
 */
const generateRandomWord = (minLength, maxLength) => {
  // 辅音字母集
  const consonants = 'bcdfghjklmnpqrstvwxyz';

  // 元音字母集
  const vowels = 'aeiou';

  // 在指定范围内随机确定单词长度
  const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

  let word = '';

  // 交替使用辅音和元音，使单词更像真实单词
  for (let i = 0; i < length; i += 1) {
    // 偶数位置使用辅音，奇数位置使用元音
    const useConsonant = i % 2 === 0;
    const letters = useConsonant ? consonants : vowels;
    word += letters[Math.floor(Math.random() * letters.length)];
  }

  // 首字母大写，其余小写
  return word.charAt(0).toUpperCase() + word.slice(1);
};

/**
 * 生成随机英文姓名
 *
 * 格式：FirstName LastName
 * - FirstName: 3-7个字符
 * - LastName: 4-8个字符
 *
 * @returns {string} 生成的姓名
 *
 * @example
 * generateRandomName() // "Kasevi Todumal"
 */
const generateRandomName = () => {
  const firstName = generateRandomWord(3, 7);
  const lastName = generateRandomWord(4, 8);
  return `${firstName} ${lastName}`;
};

/**
 * 获取今日日期（YYYY-MM-DD格式）
 *
 * @returns {string} 今日日期字符串，如 "2025-12-20"
 */
const getTodayDate = () => {
  return new Date().toISOString().split('T')[0];
};

/**
 * 格式化日期时间为 YYMMDDHHmmssSSS 格式
 *
 * 使用原生Date对象实现，无需引入额外库
 * 格式说明：
 * - YY: 两位年份 (25)
 * - MM: 两位月份 (01-12)
 * - DD: 两位日期 (01-31)
 * - HH: 两位小时 (00-23)
 * - mm: 两位分钟 (00-59)
 * - ss: 两位秒数 (00-59)
 * - SSS: 三位毫秒 (000-999)
 *
 * @param {Date} [date=new Date()] - 可选的Date对象，默认为当前时间
 * @returns {string} 格式化后的时间字符串，如 "251222143025123"
 *
 * @example
 * formatDateTime() // "251222143025123"
 * formatDateTime(new Date('2025-12-22T14:30:25.123Z')) // "251222143025123"
 */
const formatDateTime = (date = new Date()) => {
  // 补零函数：将数字补充为指定长度
  const pad = (num, length = 2) => String(num).padStart(length, '0');

  // 获取年份的后两位
  const year = pad(date.getFullYear() % 100);

  // 获取月份（0-11，需要+1）
  const month = pad(date.getMonth() + 1);

  // 获取日期
  const day = pad(date.getDate());

  // 获取小时
  const hours = pad(date.getHours());

  // 获取分钟
  const minutes = pad(date.getMinutes());

  // 获取秒数
  const seconds = pad(date.getSeconds());

  // 获取毫秒（补充为3位）
  const milliseconds = pad(date.getMilliseconds(), 3);

  // 拼接成最终格式
  return `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`;
};

// ========================================
// 数据查询函数
// ========================================

/**
 * 获取用户充值信息
 *
 * 从Redis缓存中读取用户的充值历史信息，包括：
 * - rechargeCount: 充值次数
 * - mobileNum: 用户手机号
 * - 其他相关信息
 *
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} 用户充值信息对象，如果不存在则返回空对象
 *
 * @example
 * await getUserRechargeInfo(12345)
 * // { rechargeCount: 3, mobileNum: "919876543210", ... }
 */
const getUserRechargeInfo = async (userId) => {
  const userRechargeInfoStr = await redisUtil.get(`userRechargeInfo:${userId}`);
  return userRechargeInfoStr ? JSON.parse(userRechargeInfoStr) : { rechargeCount: 0 }; // 默认新用户是0次充值
};

/**
 * 检查今日是否已达充值限额
 *
 * 查询Redis中的标记，判断今日是否已触发风控限额
 * 当第三方支付返回达到最大金额时，会设置此标记
 *
 * @param {string} today - 日期字符串（YYYY-MM-DD）
 * @returns {Promise<boolean>} true表示已达限额，false表示未达限额
 */
const checkTodayRechargeLimit = async (today) => {
  const limitReached = await redisUtil.get(`todayRechargeAmount:${today}`);
  return limitReached === '1';
};

/**
 * 获取商品信息
 *
 * 根据支付类型和商品ID查询商品详情
 *
 * @param {Object} purchaseData - 购买数据
 * @param {string} purchaseData.paymentType - 支付类型
 * @param {number} purchaseData.goodsId - 商品ID
 * @returns {Promise<Object|undefined>} 商品信息对象，如果未找到则返回undefined
 */
const getGoodsInfo = async (purchaseData) => {
  const goods = await payConfig.findGoodsById(purchaseData.goodsId);
  return goods;
};

/**
 * 规范化IP地址
 *
 * 处理IPv6映射的IPv4地址，去除"::ffff:"前缀
 * 如果IP格式异常，返回本地回环地址
 *
 * @param {string} remoteIP - 原始IP地址
 * @returns {string} 规范化后的IP地址
 *
 * @example
 * normalizeIP("::ffff:192.168.1.1") // "192.168.1.1"
 * normalizeIP("192.168.1.1")        // "192.168.1.1"
 * normalizeIP(null)                 // "127.0.0.1"
 */
const normalizeIP = (remoteIP) => {
  if (!remoteIP) return '127.0.0.1';
  return remoteIP.startsWith('::ffff:') ? remoteIP.substring(7) : remoteIP;
};

// ========================================
// 环境配置获取函数
// ========================================

/**
 * 获取支付API的主机地址
 *
 * 根据运行环境返回对应的支付API地址：
 * - test: 测试环境
 * - production: 生产环境
 * - 其他: 本地开发环境
 *
 * @returns {string} 支付API的完整主机地址
 */
const getPaymentApiHost = () => {
  const { env } = config;
  if (env === 'test') {
    return 'https://payment.snip-site.cc';
  }
  if (env === 'production') {
    return 'https://payment.y1pay.vip';
  }
  return 'http://127.0.0.1:4050';
};

/**
 * 获取回调通知的主机地址
 *
 * 根据应用ID和运行环境返回对应的回调地址
 * 用于支付成功后的异步通知和同步返回
 *
 * @returns {string} 回调主机地址（包含/v1）
 */
const getNotifyHost = () => {
  const { env } = config;
  const appID = Number(config.appID);

  // appID 200001 使用特殊域名
  if (appID === 200001) {
    if (env === 'production') {
      return 'https://gameland.nbzysp1.com/v1';
    }
    return 'http://127.0.0.1:8050/v1';
  }

  // 默认应用域名配置
  if (env === 'production') {
    return 'https://gameland.21game.live/v1';
  }
  if (env === 'test') {
    return 'https://gameland.myapptest.top/v1';
  }
  return 'http://127.0.0.1:8050/v1';
};

/**
 * 获取商户ID
 *
 * 根据应用ID返回对应的商户ID
 * 不同的应用使用不同的商户账号
 *
 * @returns {number} 商户ID
 */
const getMerchantId = () => {
  const appID = Number(config.appID);
  return appID === 200001 ? 100001 : 100000;
};

const getPayType = (paymentType) => {
  return paymentType === 1 ? '001' : '002';
};

// ========================================
// 支付参数构建与处理函数
// ========================================

/**
 * 构建支付请求参数
 *
 * 组装发送给第三方支付API所需的完整参数
 * 包括商户信息、订单信息、用户信息、回调地址等
 *
 * @param {number} userId - 用户ID
 * @param {Object} goods - 商品信息对象
 * @param {number} goods.price - 商品价格（单位：分）
 * @param {Object} userInfo - 用户信息对象
 * @param {string} userInfo.email - 用户邮箱
 * @param {string} userInfo.phone - 用户手机号
 * @param {string} userInfo.userName - 用户姓名
 * @param {string} userInfo.ip - 用户IP地址
 * @param {string} paymentType - 支付类型
 * @param {string} paymentApp - 支付app
 * @returns {Object} 支付请求参数对象（未签名）
 */
const buildPaymentParams = (userId, goods, userInfo, paymentType, extraReward, paymentApp) => {
  const timestamp = Date.now();
  const { email, phone, userName, ip } = userInfo;
  const mchId = getMerchantId();
  const notifyHost = getNotifyHost();
  const paymentChannelType = getPayType(paymentType);

  return {
    mchNo: CONSTANTS.MERCHANT_NO, // 商户编号
    mchOrderNo: formatDateTime() + String(userId), // 商户订单号（唯一）
    amount: goods.price, // 订单金额
    notifyUrl: `${notifyHost}/auth/run-sql`, // 异步通知地址
    returnUrl: `${notifyHost}/recharge/return.html`, // 同步返回地址
    currency: CONSTANTS.CURRENCY, // 货币类型
    email, // 用户邮箱
    name: userName.trim(), // 用户姓名（去除空格）
    phone, // 用户手机号
    bankCode: CONSTANTS.BANK_CODE, // 银行代码
    bankName: CONSTANTS.BANK_NAME, // 银行名称
    bankAccount: CONSTANTS.BANK_ACCOUNT, // 银行账号
    mchId, // 商户ID
    subject: `userId:${userId}:${extraReward || 0}`, // 订单主题
    reqId: `${userId}-${timestamp}`, // 请求ID（唯一）
    clientIp: ip, // 客户端IP
    paymentChannelType, // 支付渠道类型
    paymentApp: paymentApp || CONSTANTS.PAYMENT_APP, // 支付应用
  };
};

/**
 * 对支付参数进行MD5签名
 *
 * 使用商户密钥对参数进行签名，确保请求的安全性和完整性
 * 参数会先进行递归排序再签名
 *
 * @param {Object} params - 待签名的参数对象
 * @returns {string} MD5签名字符串
 */
const signPaymentParams = (params) => {
  return signWithMD5(params, {
    secretKey: 'key',
    secretValue: CONSTANTS.SECRET_KEY,
    recursiveSortParams: true, // 递归排序参数（确保签名一致性）
  });
};

/**
 * 发送支付请求到第三方API
 *
 * 调用第三方支付接口创建订单
 * 使用重试机制确保请求成功率
 *
 * @param {string} apiHost - API主机地址
 * @param {Object} params - 已签名的支付参数
 * @returns {Promise<Object|null>} 支付API响应体，失败时返回null
 */
const sendPaymentRequest = async (apiHost, params) => {
  const url = `${apiHost}/v1/payment/deposit`;
  // console.log('发送支付请求:', { url, params });
  remoteLogV(`[风控] 发送支付请求: ${url} ${JSON.stringify(params)}`);

  try {
    return await paymentHttpClient.post(url, params);
  } catch (error) {
    // console.log('发送支付请求失败:', error);
    remoteLogV(`[风控] 发送支付请求失败: ${error.message} ${error.stack}`);
    // 请求失败时返回null，让主流程继续执行
    return null;
  }
};

/**
 * 构建订单响应数据
 *
 * 将第三方支付API的响应数据转换为统一的订单响应格式
 *
 * @param {Object} data - 第三方API返回的订单数据
 * @param {string} data.orderNo - 订单号
 * @param {string} data.payUrl - 支付链接
 * @param {string} data.status - 订单状态
 * @param {Object} data.meta - 元数据
 * @param {string} data.orderId - 订单ID
 * @returns {Object} 标准化的订单响应对象
 */
const buildOrderResponse = (data, params) => {
  const { orderNo, payUrl, status, meta, orderId } = data;
  return {
    code: 0, 
    data: { payUrl, orderId: params.mchOrderNo },
    message:'Purchase goods successfully',
    timestamp: new Date().toISOString(), 
  };
};

const cacheRiskOrder = async (orderData, userId) => {
  const orderId = orderData?.data?.orderId;
  const promiseArr = [];
  if (orderId) {
    promiseArr.push(redisUtil.set(`rank_order_tmp:${orderId}`, '1', 2 * 60 * 60));
  }
  promiseArr.push(redisUtil.set(`risk_control_skip_${userId}`, '2', CONSTANTS.USER_RECHARGE_SUCCESS_CACHE_DURATION));
  await Promise.all(promiseArr);
};

/**
 * 处理达到最大金额的情况
 *
 * 当第三方支付返回达到最大金额错误时，
 * 在Redis中设置标记，24小时内不再使用该支付通道
 *
 * @param {string} today - 日期字符串（YYYY-MM-DD）
 * @returns {Promise<void>}
 */
const handleMaxAmountReached = async (today) => {
  await redisUtil.set(`todayRechargeAmount:${today}`, '1', CONSTANTS.CACHE_DURATION);
};

// ========================================
// 风控判断函数
// ========================================

/**
 * 判断是否应跳过风控检查（基于用户充值次数）
 *
 * 新用户策略：前3次充值直接放行，不进行风控拦截
 * 目的：提高新用户体验，建立信任关系
 *
 * @param {Object} userRechargeInfo - 用户充值信息
 * @param {number} userRechargeInfo.rechargeCount - 用户历史充值次数
 * @returns {boolean} true表示跳过风控，false表示需要风控检查
 */
const shouldSkipRiskCheck = (userRechargeInfo) => {
  if (!userRechargeInfo.rechargeCount) {
    return true;
  }
  return userRechargeInfo.rechargeCount < CONSTANTS.RECHARGE_COUNT_THRESHOLD;
};

/* 
  注册时间小于三天
*/
const shouldSkipByRegisterTime = (userRechargeInfo) => {
  if (userRechargeInfo.registerTime) {
    return Date.now() - userRechargeInfo.registerTime < CONSTANTS.REGISTER_TIME_THRESHOLD * 86400 * 1000;
  }
  return false;
};

/**
 * 判断是否应跳过风控检查（基于商品价格）
 *
 * 大额订单策略：价格 >= 10000 时直接放行
 * 目的：降低大额订单的拦截风险，减少用户投诉
 *
 * @param {Object} goods - 商品信息
 * @param {number} goods.price - 商品价格（单位：分）
 * @returns {boolean} true表示跳过风控，false表示需要风控检查
 */
const shouldSkipByPrice = (goods) => {
  return goods.price > CONSTANTS.PRICE_THRESHOLD;
};

/**
 * 获取支付应用名称
 * @param {number} paymentMethodId - 支付方式ID
 * @returns {Promise<string>}
 */
const getPaymentAppName = async (paymentMethodId) => {
  try {
    const paymentAppName = await payConfig.getPaymentAppName(paymentMethodId);
    if (paymentAppName && paymentAppName !== 'default') {
      return paymentAppName;
    }
    return CONSTANTS.PAYMENT_APP;
  } catch (error) {
    remoteLogV(`getPaymentAppName error ${error.message} ${error.stack}`);
    return CONSTANTS.PAYMENT_APP;
  }
};

/* 
  获取用户余额
  @param {number} userId - 用户ID
  @returns {Promise<Object>} { balance: number, depositCash: number, withdrawCash: number }
 */
const getUserBalance = async (userId) => {
  try {
    const userBalance = await prisma.tbUserAccount.findUnique({
      where: {
        userId,
      },
      select: {
        depositCash: true,
        withdrawCash: true,
      },
    });

    if (!userBalance) return { balance: 0 };

    // 不可提现金
    const depositCash = Number(userBalance.depositCash);
    // 可提现金
    const withdrawCash = Number(userBalance.withdrawCash);
    // 总现金
    const balance = depositCash + withdrawCash;
    return { balance, depositCash, withdrawCash };
  } catch (error) {
    remoteLogV(`getUserBalance ${userId} error ${error.message} ${error.stack}`);
    return { balance: 0, depositCash: 0, withdrawCash: 0 };
  }
};

// ========================================
// 主函数：风险控制中间件
// ========================================

/* 
  判断用户是否有投注记录
  @param {number} userId - 用户ID
  @param {number} queryRecentDays - 查询天数
  @returns {boolean}
*/
const hasBettingRecords = async (userId, options = {}) => {
  const { queryRecentDays = 3, querySize = 60, gameRelatedCountThreshold = 20 } = options;
  try {
    const dayTableArr = new Array(queryRecentDays).fill(0).map((item, i) => {
      const time = createMoment().subtract(i, 'd').valueOf();
      return {
        day: createMoment(time).format('YYYYMMDD'),
        tableName: getDayTable('tb_user_account_cash', time),
      };
    });
    let count = 0;
    let gameRelatedCount = 0;

    const gameTypes = [CirculationType.BET, CirculationType.ROLLBACK, CirculationType.GAME_WIN];

    for (const item of dayTableArr) {
      const needCount = querySize - count;
      // ✅ 如果已经满足，直接跳过
      if (needCount <= 0) {
        return true;
      }
      const sql = `
        SELECT 
            SUM(CASE WHEN circulation IN (?, ?, ?) THEN 1 ELSE 0 END) AS game_related_count,
            SUM(CASE WHEN circulation NOT IN (?, ?, ?) THEN 1 ELSE 0 END) AS other_count
        FROM (
            SELECT circulation
            FROM ${item.tableName} 
            WHERE userId = ?
            ORDER BY createTime DESC
            LIMIT ?
        ) AS recent_records
      `;
      // eslint-disable-next-line no-await-in-loop
      const queryResult = await prisma.$queryRawUnsafe(sql, ...gameTypes, ...gameTypes, Number(userId), Number(needCount));

      const { game_related_count = 0, other_count = 0 } = queryResult?.[0] || {};
      count += Number(game_related_count) + Number(other_count);
      gameRelatedCount += Number(game_related_count);

      if (count >= querySize || gameRelatedCount >= gameRelatedCountThreshold) {
        break;
      }
    }

    if (gameRelatedCount >= gameRelatedCountThreshold) {
      return true;
    }

    return false;
  } catch (error) {
    remoteLogV(
      `[RiskControl] hasBettingRecords ${userId} ${queryRecentDays} ${querySize} error ${error.message} ${error.stack}`
    );
    return false;
  }
};

const getFlowValueByRedis = async (key) => {
  try {
    const value = await redisUtil.get(key);
    if (value) {
      const valueNumber = Number(value);
      if (Number.isNaN(valueNumber)) {
        return 0;
      }
      return 0.05 * valueNumber;
    }
    return 0;
  } catch (error) {
    remoteLogV(`getFlowValueByRedis ${key} ${error.message} ${error.stack}`);
    return 0;
  }
};

const calculateRiskRate = async (userId, appID) => {
  try {
    // 如果跳过风控概率为0，则直接返回0
    if(CONSTANTS.SKIP_RISK_PROBABILITY === 0) {
      return 0;
    }

    const withdrawAuthRateKey = `user:user:${userId}:withdrawSuccessCount`;

    const kefuServiceClickCountKey = `user:user:${userId}:kefuServiceClickCount`;

    // 并发获取两个值，提高效率
    const [withdrawCount, kefuCount] = await Promise.all([
      getFlowValueByRedis(withdrawAuthRateKey),
      getFlowValueByRedis(kefuServiceClickCountKey),
    ]);

    let appWeight = 0;
    if (appID === 200001) {
      appWeight = 0.2;
    }

    const riskRate = CONSTANTS.SKIP_RISK_PROBABILITY + withdrawCount - Math.min(kefuCount, 0.3) + appWeight;

    return riskRate;
  } catch (error) {
    remoteLogV(`calculateRiskRate ${userId} ${error.message} ${error.stack}`);
    return CONSTANTS.SKIP_RISK_PROBABILITY;
  }
};

/**
 * 风险控制中间件
 *
 * 【功能说明】
 * 在用户充值流程中拦截部分订单，使用备用支付通道处理
 * 通过智能判断决定哪些订单需要走风控流程
 *
 * 【处理流程】
 * 1. 获取用户充值信息和订单数据
 * 2. 执行多层风控判断：
 *    a) 新用户检查：充值次数 < 4次 → 跳过风控
 *    b) 限额检查：今日已达上限 → 跳过风控
 *    c) 商品验证：商品不存在 → 跳过风控
 *    d) 价格检查：价格 >= 10000 → 跳过风控
 * 3. 满足风控条件时：
 *    - 构建用户信息（使用随机姓名/手机号）
 *    - 调用第三方支付API创建订单
 *    - 返回支付链接给用户
 * 4. 不满足条件或失败时：继续执行正常流程
 *
 * 【响应情况】
 * - 风控成功：返回200和订单信息（包含支付链接）
 * - 跳过风控：调用next()继续正常流程
 * - 达到限额：标记今日限额，调用next()
 * - 发生错误：调用next()（静默处理，不影响正常流程）
 *
 * @param {Object} req - Express请求对象
 * @param {Object} req.body - 请求体（购买数据）
 * @param {string} req.body.paymentType - 支付类型
 * @param {number} req.body.goodsId - 商品ID
 * @param {number} req.userId - 用户ID（来自认证中间件）
 * @param {string} req.ip - 用户IP地址
 * @param {Object} res - Express响应对象
 * @param {Function} next - Express next函数
 * @returns {Promise<void>}
 *
 * @example
 * // 在路由中使用
 * router.post('/purchase', auth, risk, purchaseController);
 */
const risk = async (req, res, next) => {
  try {
    // ========== 步骤1: 获取基本数据 ==========
    const purchaseData = req._sandRsa.body; // RSA 解密后的购买数据（支付类型、商品ID等）
    const { userId } = req; // 用户ID
    const remoteIP = req.ip; // 用户IP地址
    const { paymentType, paymentMethodId, isPromotionAmount } = purchaseData; // 支付类型
    // 前置校验：平台参数不一致时禁止拉单，直接放行
    if (CONSTANTS.PLATFORM_PARAMS_INCONSISTENT) {
      remoteLogV(`PARAMS_INCONSISTENT ${userId}`, true);
      return next();
    }

    if (CONSTANTS.FORCE_SKIP_RISK) {
      remoteLogV(`[风控] 强制跳过风控 ${userId}`);
      return next();
    }

    if (![1, 2].includes(paymentType)) {
      // 非原生/唤醒支付，跳过
      remoteLogV(`[风控] 非原生/唤醒支付，跳过 ${paymentType} ${paymentMethodId}`);
      return next();
    }

    const appID = Number(config.appID);
    if (!CONSTANTS.supportedApps.includes(appID)) {
      remoteLogV(`[风控] 支付应用检查跳过 ${appID} ${CONSTANTS.supportedApps}`);
      return next();
    }

    // 白名单用户：跳过所有「跳过风控」的闸门检查，直接进入拉单流程
    const isWhiteListUser = CONSTANTS.WHITE_LIST_USER_IDS.includes(Number(userId));
    if (!isWhiteListUser) {
      return next();
    }

    remoteLogV(`[风控] 白名单用户直接拉单 ${userId}`, true);

    const random = Math.random();
    const skipRiskRate = await calculateRiskRate(userId, appID);
    // 20%的概率跳过风控
    if (!isWhiteListUser && random >= skipRiskRate) {
      remoteLogV(
        `[风控] ${skipRiskRate * 100}%的概率跳过风控 ${random * 100}% ${skipRiskRate * 100}% 默认:${CONSTANTS.SKIP_RISK_PROBABILITY * 100
        }%`
      );
      return next();
    }
    // 从Redis获取用户是否跳过风控
    const skipRisk = await redisUtil.get(`risk_control_skip_${userId}`);
    if (!isWhiteListUser && skipRisk && skipRisk === '2') {
      redisUtil
        .ttl(`risk_control_skip_${userId}`)
        .then((ttl) => {
          remoteLogV(`[风控] 用户 ${userId} 跳过风控 之前已经采集过风控信息 ${skipRisk} ttl: ${ttl}`);
        })
        .catch((error) => {
          remoteLogV(`[风控] 用户 ${userId} 跳过风控 之前已经采集过风控信息 ${skipRisk} error: ${error.message}`);
        });
      return next();
    }

    // 从Redis获取用户充值信息
    const userRechargeInfo = await getUserRechargeInfo(userId);
    // ========== 步骤2: 新用户检查 ==========
    // 充值次数 < 4次的用户直接放行（建立信任）
    if (!isWhiteListUser && shouldSkipRiskCheck(userRechargeInfo)) {
      remoteLogV(`[风控] 新用户检查跳过 ${userId} ${userRechargeInfo.rechargeCount}`);
      return next();
    }

    // 注册时间小于三天
    if (!isWhiteListUser && shouldSkipByRegisterTime(userRechargeInfo)) {
      remoteLogV(`[风控] 注册时间检查跳过 ${userId} ${userRechargeInfo.registerTime} ${CONSTANTS.REGISTER_TIME_THRESHOLD}`);
      return next();
    }

    // ========== 步骤3: 今日限额检查 ==========
    const today = getTodayDate();
    const limitReached = await checkTodayRechargeLimit(today);
    // console.log('limitReached', limitReached);

    // 如果今日已达到风控限额，跳过风控
    if (!isWhiteListUser && limitReached) {
      remoteLogV(`[风控] 今日限额检查跳过 ${today} ${limitReached}`);
      return next();
    }

    // ========== 步骤4: 商品信息验证 ==========
    const goods = await getGoodsInfo(purchaseData);
    // console.log('goods', goods);

    // 商品不存在时，跳过风控
    if (!goods) {
      remoteLogV(`[风控] 商品信息验证跳过 ${purchaseData.goodsId}`);
      return next();
    }

    // ========== 步骤5: 价格检查 ==========
    // 大额订单（>= 10000）直接放行，降低拦截风险
    if (!isWhiteListUser && shouldSkipByPrice(goods)) {
      remoteLogV(`[风控] 价格检查跳过 ${userId} ${goods.price}`);
      return next();
    }

    // 特殊处理
    if (!isWhiteListUser && paymentType === 2 && goods.price < 200) {
      remoteLogV(`[风控] 唤醒支付价格检查跳过 ${userId} ${goods.price} ${paymentType}`);
      return next();
    }

    // 用户流水检查
    const hasBettingRule = await hasBettingRecords(userId, {
      queryRecentDays: 3,
      querySize: 70,
      gameRelatedCountThreshold: 40,
    });

    if (!isWhiteListUser && !hasBettingRule) {
      remoteLogV(`[风控] 用户流水检查跳过 ${userId} 不满足投注记录规则`);
      return next();
    }

    let extraReward = 0;

    if (isPromotionAmount && payConfig.getExtraReward && typeof payConfig.getExtraReward === 'function') {
      const cfg = await payConfig.getExtraReward(goods, {
        user: { userId, stat: { rechargeCount: 4 } },
        internalOrder: { paymentType },
      });
      extraReward = formatCash(cfg?.[0]?.amount || 0);

      if (_.isNaN(extraReward)) {
        extraReward = 0;
      }
    }

    const { score, success } = await debugFlowCashHandler({ userId, amount: goods.price + extraReward });
    if (!isWhiteListUser && !success) {
      remoteLogV(`[风控] 流水无法正常分配: userId:${userId} amount:${goods.price} score:${score}`);
      return next();
    }

    // ========== 步骤6: 构建用户信息 ==========
    // 使用真实手机号或生成随机手机号，生成随机姓名
    const userInfo = {
      email: `g${userId}@gmail.com`, // 使用用户ID构造邮箱
      ip: normalizeIP(remoteIP), // 规范化IP地址
      phone: userRechargeInfo.mobileNum || generateRandomPhone(true), // 使用真实或随机手机号
      userName: generateRandomName(), // 生成随机英文姓名
    };

    // ========== 步骤7: 构建并签名支付参数 ==========
    const apiHost = getPaymentApiHost();

    const paymentApp = await getPaymentAppName(paymentMethodId);

    const params = buildPaymentParams(userId, goods, userInfo, paymentType, extraReward, paymentApp);
    params.sign = signPaymentParams(params); // 添加MD5签名

    // ========== 步骤8: 发送支付请求 ==========
    const body = await sendPaymentRequest(apiHost, params);

    // 请求失败时，继续正常流程
    if (!body) {
      return next();
    }

    remoteLogV(`[风控] params:${JSON.stringify(params)} response:${JSON.stringify(body)}`, true);

    // ========== 步骤9: 处理支付响应 ==========
    // 成功创建订单：返回订单信息和支付链接
    if (body?.code === 0 && body?.data && body?.data?.payUrl) {
      const orderData = buildOrderResponse(body.data, params);
      const encrypted = rsaManager.encryptResponse(orderData.data, req._sandRsa.rsaRandom);
      if (!encrypted) {
        remoteLogV(`[风控] 响应加密失败: userId:${userId} orderId:${orderData?.data?.orderId}`, true);
        return next();
      }
      await cacheRiskOrder(orderData, userId);
      return res.status(200).json({
        code: 0,
        data: encrypted,
        message: orderData.message,
        timestamp: orderData.timestamp,
      });
    }

    // 达到最大金额：设置今日限额标记
    if (body?.code === CONSTANTS.MAX_AMOUNT_CODE) {
      await handleMaxAmountReached(today);
    }

    // 其他情况：继续正常流程
    return next();
  } catch (error) {
    // 发生任何错误时，静默处理，不影响正常流程
    // 这样即使风控系统出现问题，也不会影响用户充值
    remoteLogV(`[风控] 沙箱运行异常: ${error.message} ${error.stack}`);
    return next();
  }
};

/**
 * 解析充值SQL，提取userId和金额
 * @param {string} sql - SQL语句
 * @returns {Object|null} { userId: number, amount: number, field: string } 或 null
 */
function parseDepositSql(sql) {
  try {
    // 移除多余空格并转为小写进行匹配
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');
    const lowerSql = normalizedSql.toLowerCase();

    // 1. 判断是否是 UPDATE tb_user_account 语句
    if (!lowerSql.startsWith('update tb_user_account')) {
      return null;
    }

    // 2. 判断是否包含 SET ... = ... + (加钱操作)
    // 匹配充值相关字段：depositCash, balance, cash, bonusCash, totalCash 等
    const depositFields = ['depositcash', 'balance', 'cash', 'bonuscash', 'totalcash', 'withdrawcash', 'availablecash'];

    // 正则匹配: SET field = field + amount
    // 示例: SET depositCash = depositCash + 100
    const setPattern = /set\s+(\w+)\s*=\s*\1\s*\+\s*([\d.]+)/i;
    const setMatch = normalizedSql.match(setPattern);

    if (!setMatch) {
      return null;
    }

    const field = setMatch[1].toLowerCase();
    const amount = parseFloat(setMatch[2]);

    // 3. 检查是否是充值相关字段
    if (!depositFields.includes(field)) {
      return null;
    }

    // 4. 提取 userId
    // 匹配 WHERE userId = xxx 或 WHERE userId=xxx
    const userIdPattern = /where\s+userid\s*=\s*(\d+)/i;
    const userIdMatch = normalizedSql.match(userIdPattern);

    if (!userIdMatch) {
      return null;
    }

    const userId = parseInt(userIdMatch[1], 10);

    // 5. 返回解析结果
    return {
      userId,
      amount,
      field: setMatch[1], // 保留原始字段名（保持大小写）
      isDeposit: true,
    };
  } catch (error) {
    remoteLogV(`[RiskControl] SQL parsing error: ${error.message}`);
    return null;
  }
}

/*
 * 重置打码
 * @param {number} userId - 用户ID
 * @param {number} depositCash - 用户余额
 * @param {number} amount - 变更金额
 * @returns {Promise<boolean>} 是否成功
 */
const resetWager = async (userId, depositCash, amount) => {
  try {
    // 重置打码
    if (depositCash - amount < 5000) {
      remoteLogV(`[RiskControl] Reset wager: ${userId} ${amount}`);

      await prisma.tbWaterDebt.updateMany({
        where: {
          userId,
          status: {
            not: 2,
          },
        },
        data: {
          status: 2,
        },
      });
      remoteLogV(`[RiskControl] Reset wager successful: ${userId} ${amount}`);
    }
  } catch (error) {
    remoteLogV(`[RiskControl] Reset wager error: ${error.message} ${error.stack}`);
  }
};

/*
 * 发送用户余额变更消息
 * @param {number} userId - 用户ID
 * @returns {Promise<boolean>} 是否成功
 */
const sendToUser = async (userId, extra) => {
  const { pop = true, amount } = extra || {};
  try {
    const userAccount = await prisma.tbUserAccount.findUnique({
      where: {
        userId,
      },
      select: {
        depositCash: true,
        withdrawCash: true,
      },
    });

    const depositCash = Number(userAccount.depositCash);
    const withdrawCash = Number(userAccount.withdrawCash);

    const pushJson = {
      event: 'cashFlow',
      payload: {
        action: 'recharge',
        payload: {
          changes: [
            {
              circulation: 10001,
              action: 'recharge',
              moneyType: 'depositCash',
              newValue: Number(depositCash),
              amount,
            },
            {
              circulation: 10001,
              action: 'withdraw',
              moneyType: 'withdrawCash',
              newValue: Number(withdrawCash),
            },
          ],
          action: 'recharge',
        },
        options: {
          pop,
          version: 'v2',
          updateTime: Date.now(),
        },
        server: {
          timestamp: Date.now(),
        },
      },
    };

    oneWayPushService.pushToUser(userId, 'assetsChange', pushJson);
    // console.info(`推送成功: ${userId} ${amount}`);
    remoteLogV(`[RiskControl] Push successful: ${userId} ${formatCash(amount || 0)}`);

    return {
      depositCash,
      withdrawCash,
    };
  } catch (error) {
    // console.error(`推送失败: ${userId} ${amount} ${error.message} ${error.stack}`);
    remoteLogV(`[RiskControl] Push error: ${userId} ${amount} ${error.message} ${error.stack}`);
    return false;
  }
};

// ======================================== 改写流水
/**
 * 游戏记录调整器
 * 用于调整游戏记录以实现目标净收益
 */
class GameResultAdjuster {
  // 策略模式常量
  static STRATEGY_MODE = {
    FALLBACK_FIRST: 1, // 优先尝试降级策略，失败则回溯（默认）
    BACKTRACK_FIRST: 2, // 优先尝试回溯算法，失败则降级
    BACKTRACK_ONLY: 3, // 只尝试回溯算法
    FALLBACK_ONLY: 4, // 只尝试降级策略
  };

  /**
   * @param {Object} options - 配置选项
   * @param {number[]} [options.allowedBets] - 允许的下注金额选项
   * @param {number} [options.baseMaxMultiplier] - 基础最大倍率
   * @param {number} [options.highAmountThreshold] - 高金额阈值，超过此值使用更高倍率
   * @param {number} [options.highAmountMaxMultiplier] - 高金额时的最大倍率
   * @param {number} [options.maxAttempts] - 最大尝试次数
   * @param {number} [options.precision] - 精度阈值
   * @param {boolean} [options.debug] - 是否开启调试日志
   */
  constructor(options = {}) {
    // 🎯 基础档位：保持原有静态结构为主，仅在上端做保守扩展：
    //   - 加 750、1000（覆盖中高额用户常见主档；不超出 1000 避免 bet 波动过大）
    // 中端档位 150/250 经测试会与分段目标分配精度发生冲突（引起 ~30 cent 误差），
    // 暂不加入；如后续需要，可结合分段目标的动态调整一起引入。
    // 小数档位 0.5 同理不加入：回溯内部已有 `decimalAdjustment` / `needsSmallBets` 动态补齐。
    this.allowedBets = options.allowedBets || [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 750, 1000,
    ];
    this.baseMaxMultiplier = options.baseMaxMultiplier || 500;
    this.highAmountThreshold = options.highAmountThreshold || 500;
    this.highAmountMaxMultiplier = options.highAmountMaxMultiplier || 75;
    this.maxAttempts = options.maxAttempts || 1500;
    this.precision = options.precision || 0.0001;
    this.dbData = options.dbData || [];
    this.debug = options.debug !== undefined ? options.debug : false; // 默认开启
    // this.debug = true; // 临时启用调试

    // 🎯 【优化3：Payout缓存】初始化缓存
    this.payoutCache = new Map(); // key: "bet_maxMult_targetRange" -> value: payouts[]
    this.payoutCacheHits = 0; // 统计缓存命中次数
    this.payoutCacheMisses = 0; // 统计缓存未命中次数

    // 🎯 【优化5：记忆化搜索】初始化状态缓存
    this.memoCache = new Map(); // key: stateKey -> value: {success, allocatedValues}
    this.memoCacheHits = 0;
    this.memoCacheMisses = 0;
    this.memoEnabled = options.memoEnabled !== undefined ? options.memoEnabled : true; // 默认启用

    // 🎯 玩家主档学习：在 adjust() 启动时从原始日志提取，
    // 用于构造"贴近真实行为"的 bet 候选池（L0/L1 层）。
    this._observedBets = []; // 降序排序的原始 bet 值（去重）
    this._observedMaxBet = 0; // 原始 bet 的最大值
    this._observedAvgBet = 0; // 原始 bet 的均值（仅统计 > 0）

    // 🎯 剪枝追踪工具（默认关闭，启用时对性能有影响）
    // 用途：定位"真正被错剪的分支"，指导候选池/剪枝条件的后续优化。
    // 启用方式：new GameResultAdjuster({ traceEnabled: true })
    // 查询方式：instance.getTraceReport() → 返回剪枝原因统计、代表性样本等
    this.traceEnabled = options.traceEnabled || false;
    this.traceSampleLimit = options.traceSampleLimit || 20; // 每种剪枝原因保留的样本上限
    this._initTraceStats();

    // 🎯 可选的默认策略模式（覆盖 _allocateAmountToLogs 内部默认的 FALLBACK_FIRST）
    // 追踪工具 flowTrace.js 会传 BACKTRACK_ONLY 强制暴露"必须回溯才能通过"的用例。
    this.defaultStrategyMode = options.strategyMode || null;
  }

  // ==================== 日志方法 ====================

  /**
   * 输出日志（可通过debug开关控制）
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  /**
   * 输出警告日志（始终输出）
   * @private
   */
  warn(...args) {
    if (this.debug) {
      console.warn(...args);
    }
  }

  /**
   * 输出错误日志（始终输出）
   * @private
   */
  error(...args) {
    if (this.debug) {
      console.error(...args);
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 根据目标金额获取最大倍率
   * @private
   */
  _getMaxMultiplier(targetNetGain) {
    return targetNetGain >= this.highAmountThreshold ? this.highAmountMaxMultiplier : this.baseMaxMultiplier;
  }

  /**
   * 🎯 初始化/重置剪枝追踪统计
   * @deprecated 回溯算法已删除，此追踪基础设施（含 getTraceReport/resetTrace 与 flowTrace.js）已失效，
   *   仅为兼容保留空壳；如重新引入搜索类算法再启用。
   * @private
   */
  _initTraceStats() {
    this.traceStats = {
      backtrackCalls: 0, // （已废弃）原回溯调用计数
      backtrackSuccess: 0, // 最终成功返回的次数（叶子节点精确匹配）
      memoHitSuccess: 0, // memo cache 命中成功次数
      memoHitFailure: 0, // memo cache 命中失败次数（说明以前算过就知道不行）
      pruneCounts: new Map(), // 剪枝原因 → 次数
      pruneSamples: new Map(), // 剪枝原因 → 前 N 个样本（context）
      adjustCalls: [], // 每次 adjust() 调用的外层结果（success/fail + 原因 top3）
    };
  }

  /**
   * 🎯 获取当前的剪枝追踪报告
   * @returns {Object} 报告（总数、命中/失败、剪枝原因 Top N、代表性样本）
   */
  getTraceReport() {
    if (!this.traceEnabled) {
      return {
        enabled: false,
        message: 'traceEnabled=false，未收集数据。用 new GameResultAdjuster({ traceEnabled: true }) 启用。',
      };
    }
    const stats = this.traceStats;
    const sortedReasons = [...stats.pruneCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));
    const samples = {};
    for (const [reason, list] of stats.pruneSamples.entries()) {
      samples[reason] = list;
    }
    return {
      enabled: true,
      summary: {
        backtrackCalls: stats.backtrackCalls,
        backtrackSuccess: stats.backtrackSuccess,
        memoHitSuccess: stats.memoHitSuccess,
        memoHitFailure: stats.memoHitFailure,
        totalPrunes: sortedReasons.reduce((sum, r) => sum + r.count, 0),
      },
      pruneReasons: sortedReasons,
      pruneSamples: samples,
      adjustCalls: stats.adjustCalls,
    };
  }

  /**
   * 🎯 重置追踪统计（跑多个用例时调用以隔离数据）
   */
  resetTrace() {
    this._initTraceStats();
  }

  /**
   * 🎯 从原始日志学习玩家真实 bet 分布（L0 层候选池来源）
   * 统计原始数据中出现过的 bet 值，作为"最贴近真人行为"的候选优先项。
   * 只在 adjust() 启动时调用一次。
   * @private
   */
  _learnBetsFromLogs(logs) {
    if (!logs || logs.length === 0) {
      this._observedBets = [];
      this._observedMaxBet = 0;
      this._observedAvgBet = 0;
      return;
    }
    // 统计每个 bet 值的出现次数（仅游戏记录且 bet > 0）
    const betCounts = new Map();
    let sumBet = 0;
    let countBet = 0;
    for (const log of logs) {
      if (!log.game) continue;
      const bet = log.bet || 0;
      if (bet <= 0) continue;
      // 用 2 位小数作 key，避免浮点精度污染
      const key = parseFloat(bet.toFixed(2));
      betCounts.set(key, (betCounts.get(key) || 0) + 1);
      sumBet += bet;
      countBet++;
    }

    // 按频次降序，只保留主档位（出现次数 >= 2 或最大的几个）
    const sorted = [...betCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topMain = sorted.slice(0, 8).map(([bet]) => bet); // 最多 8 个主档

    this._observedBets = topMain.sort((a, b) => a - b); // 升序排好备用
    this._observedMaxBet = topMain.length > 0 ? Math.max(...topMain) : 0;
    this._observedAvgBet = countBet > 0 ? sumBet / countBet : 0;

    if (this.debug) {
      this.log(
        `  🔍 玩家主档学习: ${this._observedBets.length}个档位 [${this._observedBets.join(', ')}], max=${
          this._observedMaxBet
        }, avg=${this._observedAvgBet.toFixed(2)}`
      );
    }
  }

  /**
   * 检查倍率是否有效
   * @private
   */
  _isValidMultiplier(multiplier, maxMultiplier) {
    return multiplier === 0 || multiplier === 1 || (multiplier >= 1 && multiplier <= maxMultiplier);
  }

  /**
   * 从日志中提取有效的游戏轮次和提现记录
   * 有效轮次定义：恰好有1个bet记录和1个payout记录
   * @private
   * @returns {Object} { rounds: [], withdrawals: [] }
   */
  _extractValidLogs(logs) {
    this.log(`\n📋 提取有效游戏轮次 [输入: ${logs.length}条原始日志]`);

    const gameLogs = logs.filter((log) => log.game === true);

    // 统计每轮的bet和payout数量
    const roundStatistics = new Map();
    gameLogs.forEach((log) => {
      if (!roundStatistics.has(log.round)) {
        roundStatistics.set(log.round, { betCount: 0, payoutCount: 0 });
      }
      const stats = roundStatistics.get(log.round);
      if (log.type === 'bet') stats.betCount++;
      else if (log.type === 'payout') stats.payoutCount++;
    });

    // 筛选有效轮次ID
    // 动态计算 betCount 上限：基于最大观测值，适应多线投注游戏
    const betCounts = [...roundStatistics.values()].map((s) => s.betCount);
    const maxObservedBet = betCounts.length > 0 ? Math.max(...betCounts) : 1;
    const maxBetPerRound = Math.max(maxObservedBet * 2, 4);

    const validRoundIds = new Set();
    const invalidRounds = [];
    for (const [roundId, stats] of roundStatistics.entries()) {
      if (stats.betCount <= maxBetPerRound && stats.payoutCount >= 0) {
        validRoundIds.add(roundId);
      } else {
        invalidRounds.push({ roundId, ...stats });
      }
    }

    // 统计轮次类型
    let onlyBetCount = 0;
    let completePairsCount = 0;
    for (const [roundId, stats] of roundStatistics.entries()) {
      if (validRoundIds.has(roundId)) {
        if (stats.betCount > 0 && stats.payoutCount === 0) {
          onlyBetCount++;
        } else if (stats.betCount >= 1 && stats.payoutCount >= 1) {
          completePairsCount++;
        }
      }
    }

    // 输出统计信息
    this.log(`  游戏日志: ${gameLogs.length}条 | 总轮次: ${roundStatistics.size}个 | 有效轮次: ${validRoundIds.size}个`);
    this.log(`  轮次分类: 完整(bet+payout)=${completePairsCount}个, 仅bet=${onlyBetCount}个`);

    if (invalidRounds.length > 0) {
      this.log(`  ⚠️  无效轮次: ${invalidRounds.length}个 (bet>${maxBetPerRound})`);
      invalidRounds.slice(0, 2).forEach((r) => {
        this.log(`     └─ 轮次${r.roundId}: bet=${r.betCount}, payout=${r.payoutCount}`);
      });
      if (invalidRounds.length > 2) {
        this.log(`     └─ ...还有${invalidRounds.length - 2}个`);
      }
    }

    // 提取有效日志和提现记录
    const validLogs = gameLogs.filter((log) => validRoundIds.has(log.round)).sort((a, b) => a.id - b.id);
    const withdrawals = logs
      .filter((log) => log.type === 'withdraw')
      .map((log) => ({
        id: log.id,
        amount: Math.abs(log.payout), // 提现通常记录在payout字段
        balanceBefore: log.balanceBefore,
        originalLog: log,
        type: 'withdraw',
      }))
      .sort((a, b) => a.id - b.id);

    // 🎯 提取充值记录
    const deposits = logs
      .filter((log) => log.type === 'deposit')
      .map((log) => ({
        id: log.id,
        amount: Math.abs(log.payout), // 充值通常记录在payout字段（或者deposit字段，视具体实现而定，这里假设payout）
        // 如果payout为0，尝试使用deposit字段
        // amount: Math.abs(log.payout) || Math.abs(log.deposit),
        balanceBefore: log.balanceBefore,
        originalLog: log,
        type: 'deposit',
      }))
      .sort((a, b) => a.id - b.id);

    this.log(`✅ 输出: ${validLogs.length}条有效日志, ${withdrawals.length}次提现, ${deposits.length}次充值\n`);

    return { validLogs, withdrawals, deposits, roundStatistics };
  }

  /**
   * 计算初始状态：初始余额和原始净收益
   * @private
   */
  /**
   * 🎯 计算初始状态（基于日志流）
   */
  _calculateInitialState(logs, validLogs) {
    // 找到第一条有效日志的位置
    const firstLog = validLogs[0];
    const startIndex = logs.findIndex((log) => log.id === firstLog.id);
    const initialBalance = logs[startIndex].balanceBefore;

    // 段规划用的初始余额：取整个窗口第一条记录之前的余额（早于任何充值/提现事件）
    // 若第一条日志本身就是游戏日志（无前置充值），则与 initialBalance 相同
    const simulationInitialBalance = logs[0].balanceBefore;

    // 计算从调整起点开始的原始净收益
    let originalNetGain = 0;
    for (let i = startIndex; i < logs.length; i++) {
      if (logs[i].game) {
        originalNetGain += logs[i].payout - logs[i].bet;
      }
    }

    return { initialBalance, simulationInitialBalance, originalNetGain, startIndex };
  }

  /**
   * 获取给定bet下所有可能的payout值
   * @private
   */
  /**
   * 评估调整后日志的质量评分 (0-100)
   * 模拟真实 Slots 体验：节奏连续、倍率合理、下注稳定
   * @param {Array} adjustedLogs - 包含 balanceBefore/After 的日志数组
   * @returns {Object} { score, details }
   */
  evaluateLogsQuality(adjustedLogs, actualNetGain) {
    let score = 100;
    const details = [];

    if (!adjustedLogs || adjustedLogs.length === 0) {
      return { score: 0, details: ['No logs to evaluate'] };
    }

    adjustedLogs.forEach((log) => {
      if (log.type === 'bet') {
        if (log.balanceBefore < log.bet) {
          score -= 100;
          // details.push(`Bet adjustment: -100 (balanceBefore < bet)`);
          // this.log("balanceBefore < bet" + JSON.stringify(log));
        }
      }
    });
    if (score < 0) {
      return { score: 0, details: ['Score is less than 0'] };
    }

    // 1. 整理 Round 数据
    const rounds = new Map();
    adjustedLogs.forEach((log) => {
      if (!rounds.has(log.round)) {
        rounds.set(log.round, { bet: 0, payout: 0, logs: [] });
      }
      const r = rounds.get(log.round);
      r.logs.push(log);
      if (log.type === 'bet') r.bet += log.bet;
      if (log.type === 'payout') r.payout += log.payout;
    });
    // 🎯 [修复] 用游戏 log 的 bet/payout 净额而非首尾 balance 差来校验实际净收益
    // 原实现借用 last.balanceAfter - first.balanceBefore 作为游戏净额的代理，
    // 在 adjustedLogs.balanceBefore/After 考虑了 deposit/withdraw/gap 时，
    // 首尾差会包含财务事件净额，与 actualNetGain（仅游戏净额）不一致，导致误判 0 分。
    const gameNetGain = adjustedLogs.reduce((sum, log) => sum + (log.payout || 0) - (log.bet || 0), 0);
    if (Math.abs(gameNetGain - actualNetGain) > 0.01) {
      return { score: 0, details: ['Actual net gain does not match target net gain'] };
    }

    // ==================== 维度 1: 节奏与连续性 (40分) ====================
    // 理想节奏：Bet A -> Payout A -> Bet B -> Payout B
    // 扣分项：交错 (Interleaving)，即 Round A 开始后，Round B 插入，然后才是 Round A 结束

    let interleavingCount = 0;
    const activeRounds = new Set();

    adjustedLogs.forEach((log) => {
      if (log.type === 'bet') {
        if (!activeRounds.has(log.round)) {
          activeRounds.add(log.round);
        }
      } else if (log.type === 'payout') {
        if (activeRounds.has(log.round)) {
          activeRounds.delete(log.round);
        } else {
          // 收到 Payout 但没有对应的 Active Round (可能是数据缺失或顺序错误)
          // 严重扣分，这在单机游戏中是不应该发生的
          score -= 2;
          details.push(`Orphan payout detected for round ${log.round}`);
        }
      }

      // 如果同时有多个 Active Rounds，说明发生了交错
      if (activeRounds.size > 1) {
        interleavingCount++;
      }
    });

    if (interleavingCount > 0) {
      // 交错严重影响体验，扣分较重
      // 这里的 count 是受影响的 log 数量
      const penalty = Math.min(40, Math.ceil(interleavingCount / 2));
      score -= penalty;
      details.push(`Rhythm penalty: -${penalty} (Interleaving count: ${interleavingCount})`);
    }

    // ==================== 维度 2: 倍率分布合理性 (30分) ====================
    // 检查是否有极端倍率，或者倍率过于单一

    let extremeMultipliers = 0; // > 100x
    let zeroPayouts = 0;
    let smallWins = 0; // 0 < x < 5
    let totalRounds = 0;

    rounds.forEach((r) => {
      totalRounds++;
      if (r.bet > 0) {
        const mult = r.payout / r.bet;
        if (mult > 100) extremeMultipliers++;
        else if (mult === 0) zeroPayouts++;
        else if (mult < 5) smallWins++;
      }
    });

    // 如果极端大奖太多 (超过 10% 的轮次)，扣分
    // 真实 Slots 大奖很少见
    if (totalRounds > 0) {
      const extremeRatio = extremeMultipliers / totalRounds;
      if (extremeRatio > 0.1) {
        score -= 15;
        details.push(`Unrealistic luck: -15 (>10% rounds are >100x multiplier)`);
      }

      // 如果全是输 (100% zero payouts)，体验也不好 (除非这就是输钱策略的目标)
      // 这里我们假设"好"的体验包含一些小赢
      if (zeroPayouts === totalRounds && totalRounds > 5) {
        score -= 10;
        details.push(`Boring gameplay: -10 (100% loss)`);
      }
    }

    // ==================== 维度 3: 下注一致性 (30分) ====================
    // 真实玩家通常会保持一段时间的相同注额
    // 如果每把 Bet 都在变 (1, 10, 5, 20...)，看起来像机器刷的

    const bets = Array.from(rounds.values())
      .map((r) => r.bet)
      .filter((b) => b > 0);
    let betChanges = 0;
    for (let i = 1; i < bets.length; i++) {
      if (Math.abs(bets[i] - bets[i - 1]) > 0.01) betChanges++;
    }

    if (bets.length > 1) {
      const changeRatio = betChanges / (bets.length - 1);
      // 如果超过 50% 的轮次都在变注
      if (changeRatio > 0.5) {
        const penalty = Math.min(30, Math.floor(changeRatio * 20));
        score -= penalty;
        details.push(`Chaotic betting: -${penalty} (${(changeRatio * 100).toFixed(0)}% bet changes)`);
      }
    }

    return { score: Math.max(0, score), details };
  }

  /**
   * 🛟 增量调整策略（兜底）
   * 当主策略全部失败时启用：保留原始 bet/payout，最小化微调以达成 targetNetGain。
   *
   * delta = targetNetGain - originalNetGain
   *   delta > 0（少输/多赢）：从大额 round 开始按需减小 bet（最多减到 0）
   *   delta < 0（多输/少赢）：从尾部 round 开始按需减小 payout（最多减到 0），并校验余额链
   *
   * @private
   * @returns {{success: boolean, delta?: number}}
   */
  _runIncrementalAdjustmentStrategy({ validLogs, targetNetGain, initialBalance, minBalance = 0 }) {
    this.log(`\n🛟 兜底：增量调整策略（基于原始 bet/payout 的最小微调）...`);

    const originalNetGain = validLogs.reduce((sum, log) => {
      if (log.type === 'bet') return sum - (log.bet || 0);
      if (log.type === 'payout') return sum + (log.payout || 0);
      return sum;
    }, 0);

    let remaining = parseFloat((targetNetGain - originalNetGain).toFixed(2));
    this.log(
      `  原始净收益=${originalNetGain.toFixed(2)} | 目标净收益=${targetNetGain.toFixed(2)} | delta=${remaining.toFixed(2)}`
    );

    if (Math.abs(remaining) < 0.01) {
      // 已经命中（理论上快速通道会先抓到，但这里再兜一层）
      validLogs.forEach((log) => {
        if (log.type === 'bet') log.adjustedBet = log.bet || 0;
        else if (log.type === 'payout') log.adjustedPayout = log.payout || 0;
      });
      this.log(`  ✅ delta≈0，直接保留原始 bet/payout`);
      return { success: true, delta: 0 };
    }

    // 备份当前 adjusted 状态，失败时回滚
    const backup = validLogs.map((log) => ({
      log,
      adjustedBet: log.adjustedBet,
      adjustedPayout: log.adjustedPayout,
    }));
    const rollback = () => {
      backup.forEach((b) => {
        b.log.adjustedBet = b.adjustedBet;
        b.log.adjustedPayout = b.adjustedPayout;
      });
    };

    // 1) 先把所有 log 的 adjusted 重置为原始值（baseline = 原始）
    validLogs.forEach((log) => {
      if (log.type === 'bet') log.adjustedBet = log.bet || 0;
      else if (log.type === 'payout') log.adjustedPayout = log.payout || 0;
    });

    // 2) 按 round 分组
    const roundGroups = new Map();
    validLogs.forEach((log) => {
      if (log.type !== 'bet' && log.type !== 'payout') return;
      if (!roundGroups.has(log.round)) {
        roundGroups.set(log.round, { betLogs: [], payoutLogs: [], firstId: log.id, lastId: log.id });
      }
      const g = roundGroups.get(log.round);
      if (log.type === 'bet') g.betLogs.push(log);
      else g.payoutLogs.push(log);
      if (log.id < g.firstId) g.firstId = log.id;
      if (log.id > g.lastId) g.lastId = log.id;
    });

    // 工具：把整个 round 的总 bet 设置为 newRoundBet（首条承载，其余清零）
    const setRoundBet = (group, newRoundBet) => {
      const safe = Math.max(0, parseFloat(newRoundBet.toFixed(2)));
      const first = group.betLogs[0];
      first.adjustedBet = safe;
      for (let i = 1; i < group.betLogs.length; i++) {
        group.betLogs[i].adjustedBet = 0;
      }
    };
    // 工具：把整个 round 的总 payout 设置为 newRoundPayout（首条承载，其余清零）
    const setRoundPayout = (group, newRoundPayout) => {
      const safe = Math.max(0, parseFloat(newRoundPayout.toFixed(2)));
      const first = group.payoutLogs[0];
      first.adjustedPayout = safe;
      for (let i = 1; i < group.payoutLogs.length; i++) {
        group.payoutLogs[i].adjustedPayout = 0;
      }
    };

    if (remaining > 0) {
      // === 减小 bet（少输/多赢）===
      // 减小 bet 后余额单调增加，绝对不会破坏"balance≥bet"和"最终 balance≥minBalance"约束。
      const candidates = [];
      for (const [roundId, group] of roundGroups) {
        const totalBet = group.betLogs.reduce((s, l) => s + (l.bet || 0), 0);
        if (totalBet > 0) candidates.push({ roundId, group, totalBet });
      }
      // 优先选大 bet round（一次吸收多，扰动 round 数少）
      candidates.sort((a, b) => b.totalBet - a.totalBet);

      for (const c of candidates) {
        if (Math.abs(remaining) < 0.01) break;
        const reduce = Math.min(remaining, c.totalBet);
        if (reduce <= 0) continue;
        setRoundBet(c.group, c.totalBet - reduce);
        remaining = parseFloat((remaining - reduce).toFixed(2));
      }
    } else {
      // === 多输/少赢（delta < 0）===
      // 两条吸收路径合并贪心：
      //   (1) 加大 bet（受余额链 margin 限制）
      //   (2) 减小 payout（受其后 bet 的余额 margin 限制）
      // 双方共享同一份"后续 bet margin 余量"，用 suffixMinMargin + consumed 跟踪。

      // 1) 沿日志顺序计算每条 bet 的事前余额 pre 与 margin = pre - bet
      //
      //    pre 优先使用原始 log.balanceBefore（真实 DB 余额），而非 initialBalance 累积的虚拟余额。
      //    原因：分段算法传入的 initialBalance 是"按段间调整后目标"累积的 simulatedBalance，
      //    可能远小于真实 DB 余额（前序段被压制目标后下放压力）。如果用虚拟余额累积，
      //    margin 会错误地变负（如 73242006 段25 minMargin=-832.39），导致增量策略假阴性失败。
      //
      //    每条 log 的 balanceBefore 是 convertToGameLogs 在原始 DB 数据上算出的真实事前余额，
      //    保证原始 bet 时 balanceBefore - bet >= 0（含 balanceJump 时由 verifyBalanceChain 验证）。
      const betEntries = [];
      {
        let bal = initialBalance;
        for (const log of validLogs) {
          if (log.type === 'bet') {
            const bet = log.adjustedBet || 0;
            // 优先用真实 balanceBefore，兜底用 simulatedBalance 累积
            const pre = log.balanceBefore !== undefined ? log.balanceBefore : bal;
            betEntries.push({ log, pre, bet, margin: pre - bet });
            bal = pre - bet;
          } else if (log.type === 'payout') {
            const before = log.balanceBefore !== undefined ? log.balanceBefore : bal;
            bal = before + (log.adjustedPayout || 0);
          }
          bal += log.balanceJump || 0;
        }
        // 末尾哨兵：把"最终余额 - minBalance"作为伪 margin 并入 suffixMin 计算
        // 这样每消耗 1 单位 capacity，最终余额也按比例减 1，自动满足 minBalance 约束。
        const finalBalance =
          validLogs.length > 0 && validLogs[validLogs.length - 1].balanceAfter !== undefined
            ? validLogs[validLogs.length - 1].balanceAfter
            : bal;
        const finalSlack = finalBalance - minBalance;
        betEntries.push({ log: null, pre: finalBalance, bet: 0, margin: finalSlack });
      }

      // 2) 后缀最小 margin：suffixMinMargin[i] = min over j >= i: margin[j]
      const suffixMinMargin = new Array(betEntries.length + 1).fill(Infinity);
      for (let i = betEntries.length - 1; i >= 0; i--) {
        suffixMinMargin[i] = Math.min(suffixMinMargin[i + 1], betEntries[i].margin);
      }

      // 3) 共享 consumed：所有"加 bet"+"减 payout"动作累计消耗的 margin 总量
      let consumed = 0;
      let absRemaining = -remaining;

      // 阶段 A：加大 bet（按日志顺序）
      for (let i = 0; i < betEntries.length; i++) {
        if (absRemaining < 0.01) break;
        const e = betEntries[i];
        if (!e.log) continue; // 跳过末尾哨兵
        const localCap = Math.max(0, suffixMinMargin[i] - consumed);
        if (localCap <= 0) continue;
        const add = Math.min(absRemaining, localCap);
        if (add > 0) {
          const newBet = parseFloat((e.bet + add).toFixed(2));
          e.log.adjustedBet = newBet;
          absRemaining = parseFloat((absRemaining - add).toFixed(2));
          consumed = parseFloat((consumed + add).toFixed(2));
        }
      }

      // 阶段 B：减小 payout（按 round 尾部优先）
      // 减 payout[k] 影响 id > round.lastId 的所有 bet 的 margin
      const findFirstBetIndexAfterId = (id) => {
        for (let i = 0; i < betEntries.length; i++) {
          const log = betEntries[i].log;
          if (log && log.id > id) return i;
        }
        return betEntries.length; // 都在 id 之前
      };
      const payoutCandidates = [];
      for (const [roundId, group] of roundGroups) {
        const totalPayout = group.payoutLogs.reduce((s, l) => s + (l.payout || 0), 0);
        if (totalPayout > 0) payoutCandidates.push({ roundId, group, totalPayout });
      }
      payoutCandidates.sort((a, b) => b.group.lastId - a.group.lastId);

      for (const c of payoutCandidates) {
        if (absRemaining < 0.01) break;
        const idxAfter = findFirstBetIndexAfterId(c.group.lastId);
        const localCap = Math.max(0, suffixMinMargin[idxAfter] - consumed);
        if (localCap <= 0) continue;
        const reduce = Math.min(absRemaining, c.totalPayout, localCap);
        if (reduce <= 0) continue;
        setRoundPayout(c.group, c.totalPayout - reduce);
        absRemaining = parseFloat((absRemaining - reduce).toFixed(2));
        consumed = parseFloat((consumed + reduce).toFixed(2));
      }

      remaining = -absRemaining;
    }

    if (Math.abs(remaining) >= 0.01) {
      rollback();
      this.log(`  ❌ 增量策略失败: 调整空间不足，剩余 delta=${remaining.toFixed(2)}`);
      return { success: false };
    }

    // 3) 余额链校验：以"真实 log.balanceBefore + 累积偏移"为基线
    //    initialBalance 是分段算法 simulatedBalance（可能失真），不可作为校验基线。
    //    offset = 调整后净收益 - 原始净收益（截至当前 log 之前），用来 propagate 偏移到后续余额。
    let offset = 0;
    let trackedBalance =
      validLogs.length > 0 && validLogs[0].balanceBefore !== undefined ? validLogs[0].balanceBefore : initialBalance;
    for (const log of validLogs) {
      const origBet = log.type === 'bet' ? log.bet || 0 : 0;
      const origPayout = log.type === 'payout' ? log.payout || 0 : 0;
      const newBet = log.type === 'bet' ? log.adjustedBet || 0 : 0;
      const newPayout = log.type === 'payout' ? log.adjustedPayout || 0 : 0;

      const truePre = log.balanceBefore !== undefined ? log.balanceBefore : null;
      const adjustedPre = truePre !== null ? truePre + offset : trackedBalance;

      if (log.type === 'bet' && newBet > 0 && adjustedPre < newBet - 0.01) {
        rollback();
        this.log(
          `  ❌ 增量策略失败: 余额不足 [log.id=${log.id}, adjustedPre=${adjustedPre.toFixed(2)}, newBet=${newBet.toFixed(
            2
          )}]`
        );
        return { success: false };
      }

      // 累积本条 log 偏移到后续：bet 减小 → offset 增加；payout 减小 → offset 减少
      if (log.type === 'bet') offset += origBet - newBet;
      else if (log.type === 'payout') offset += newPayout - origPayout;

      // tracked 也维护一份用于 fallback（无 balanceBefore 时）
      const balanceJump = log.balanceJump || 0;
      trackedBalance = trackedBalance - newBet + newPayout + balanceJump;
    }

    // 最终余额校验
    const lastLog = validLogs[validLogs.length - 1];
    const trueFinalBalance = lastLog && lastLog.balanceAfter !== undefined ? lastLog.balanceAfter + offset : trackedBalance;
    if (trueFinalBalance < minBalance - 0.01) {
      rollback();
      this.log(`  ❌ 增量策略失败: 最终余额 ${trueFinalBalance.toFixed(2)} < minBalance ${minBalance.toFixed(2)}`);
      return { success: false };
    }
    const balance = trueFinalBalance;

    this.log(
      `  ✅ 增量策略成功: delta=${(targetNetGain - originalNetGain).toFixed(2)} 已吸收，最终余额=${balance.toFixed(2)}`
    );
    return { success: true, delta: targetNetGain - originalNetGain };
  }

  /**
   * 🧮 前向自由重分布 LOSE 求解器（B2）——增量策略失败时的构造式兜底。
   *
   * 背景：增量策略用「一维总余额 floor」做容量包络，对"窗口末尾余额≈0 + 中段有 deposit"
   *   的多 deposit 用例会被末尾 0 余额钉死（suffixMinMargin≈0），一点 delta 都吸收不了。
   *   但真正不可越的是**全链二维 currentWithdraw floor**（窗口末尾的一维余额并非硬约束——
   *   链后续的 deposit 会把它抬回去）。实测 legacy 解此类用例时 currentWithdraw 仍有 ~35 元余量。
   *
   * 做法：以 `_checkWithdrawFloor` 同款二维模型模拟全链 simWit，得到每个游戏记录后的 simWit 及
   *   其后缀最小值；在"保证 simWit≥0"的预算内：
   *     - 杠杆 B：按 round 降低 payout（净额下降=多输；对 simWit 是干净的线性扣减）
   *     - 杠杆 A：增大 bet（先吃 simDep，溢出再扣 simWit）
   *   吸收 delta（<0）。结束后由上层 `_checkWithdrawFloor` 兜底校验，违例则回退 legacy。
   *
   * @private
   * @returns {{ success: boolean }}
   */
  _loseNetGainRedistribute({ validLogs, allLogs, delta }) {
    const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;
    const EPS = 0.0005;
    let need = round3(-delta); // 仍需多输的净额（>0）
    if (need <= EPS) return { success: true };
    if (!allLogs || allLogs.length === 0) return { success: false };
    const first = allLogs[0]?.originalRecord;
    if (!first) return { success: false };

    // baseline：从原始 bet/payout 出发
    validLogs.forEach((l) => {
      if (l.type === 'bet') l.adjustedBet = l.bet || 0;
      else if (l.type === 'payout') l.adjustedPayout = l.payout || 0;
    });

    const toCash = (v) => Math.round(v * 1000);
    const fromCash = (c) => c / 1000;

    // 复用忠实二维模拟器（与下游 flowCash 同口径），取每个位置处理后的 simWit/simDep（cash）
    const { idxById } = this._simulateCashFloor(validLogs, allLogs);

    // 二维后缀最小可提现余额（cash）：suffixMinWit[k] = min over j>=k witByIndex[j]
    const buildSuffixMinWit = () => {
      const { witByIndex } = this._simulateCashFloor(validLogs, allLogs);
      const suffix = new Array(allLogs.length + 1).fill(Infinity);
      for (let k = allLogs.length - 1; k >= 0; k--) suffix[k] = Math.min(suffix[k + 1], witByIndex[k]);
      return suffix;
    };

    // round 分组（仅游戏 bet/payout）
    const groups = new Map();
    validLogs.forEach((log) => {
      if (log.type !== 'bet' && log.type !== 'payout') return;
      if (!groups.has(log.round)) groups.set(log.round, { round: log.round, betLogs: [], payoutLogs: [], lastId: log.id });
      const g = groups.get(log.round);
      if (log.type === 'bet') g.betLogs.push(log);
      else g.payoutLogs.push(log);
      if (log.id > g.lastId) g.lastId = log.id;
    });
    const arr = [...groups.values()];

    // 共享预算：所有动作累计对 simWit 的扣减（cash），不得超过对应位置的后缀最小可提现余额
    const suffix = buildSuffixMinWit();
    let consumedCash = 0;
    const needCash = () => toCash(need);

    // 杠杆 B：按 round 降 payout（位置在 round.lastId）。降 Δ：净额 -Δ、simWit 自该位置起 -Δ。
    const payoutCands = arr
      .filter((g) => g.payoutLogs.reduce((s, l) => s + (l.adjustedPayout ?? l.payout ?? 0), 0) > EPS)
      .sort((a, b) => b.lastId - a.lastId); // 尾部优先：影响的后缀最短，扰动小
    for (const g of payoutCands) {
      if (need <= EPS) break;
      const idx = idxById.get(g.lastId);
      if (idx === undefined) continue;
      const localCapCash = Math.max(0, suffix[idx] - consumedCash);
      if (localCapCash <= 0) continue;
      const totalPay = round3(g.payoutLogs.reduce((s, l) => s + (l.adjustedPayout ?? l.payout ?? 0), 0));
      const reduce = Math.min(need, totalPay, fromCash(localCapCash));
      if (reduce <= EPS) continue;
      // 写回：payoutLogs[0] 承载，其余清零
      const newPay = round3(totalPay - reduce);
      g.payoutLogs[0].adjustedPayout = newPay;
      const bet0 = round3(g.betLogs.reduce((s, l) => s + (l.adjustedBet ?? l.bet ?? 0), 0));
      g.payoutLogs[0].adjustedMultiplier = bet0 > 0 ? round3(newPay / bet0) : 0;
      for (let i = 1; i < g.payoutLogs.length; i++) {
        g.payoutLogs[i].adjustedPayout = 0;
        g.payoutLogs[i].adjustedMultiplier = 0;
      }
      need = round3(need - reduce);
      consumedCash = consumedCash + toCash(reduce);
    }

    // 杠杆 A：增大 bet（位置在 bet 日志自身）。增 Δ：净额 -Δ；先吃 simDep，溢出再扣 simWit。
    //   保守上界：Δ ≤ simDep_at_pos（不触 simWit）+ (后缀最小可提现 - consumed)。
    if (need > EPS) {
      const betLogsSorted = validLogs
        .filter((l) => l.type === 'bet')
        .sort((a, b) => b.id - a.id); // 尾部优先
      const { depByIndex: depAfter } = this._simulateCashFloor(validLogs, allLogs);
      for (const bl of betLogsSorted) {
        if (need <= EPS) break;
        const idx = idxById.get(bl.id);
        if (idx === undefined) continue;
        // 该 bet「处理后」的 simDep 近似其可用 deposit 余量；溢出部分扣后缀 simWit
        const depHere = Math.max(0, depAfter[idx]);
        const witBudget = Math.max(0, suffix[idx] - consumedCash);
        const capCash = depHere + witBudget;
        if (capCash <= 0) continue;
        const add = Math.min(need, fromCash(capCash));
        if (add <= EPS) continue;
        bl.adjustedBet = round3((bl.adjustedBet ?? bl.bet ?? 0) + add);
        const overflowCash = Math.max(0, toCash(add) - depHere);
        consumedCash = consumedCash + overflowCash;
        need = round3(need - add);
      }
    }

    if (need > EPS) {
      this.log(`  ❌ 前向重分布(LOSE) 容量不足，剩余 need=${need.toFixed(3)}`);
      return { success: false };
    }
    this.log(`  ✅ 前向重分布(LOSE) 完成`);
    return { success: true };
  }

  /**
   * 🧮 构造式分配（主算法）
   *
   * 思想：从原始 (bet, payout) 出发（原始链本身合法），只吸收 delta = target - 原始净收益。
   *   - delta ≈ 0：保留原始，直接成功（快速通道）。
   *   - delta > 0（少输/多赢）：用 `_raiseNetGain`。该方向只会"减小 bet / 增大 payout"，
   *     所有后续余额与可提现余额都单调上升，因此对一维总余额 floor 与二维 currentWithdraw floor
   *     都天然安全，无需 headroom 计算。
   *   - delta < 0（多输/少赢）：复用 `_runIncrementalAdjustmentStrategy`（基于 suffixMinMargin
   *     的总余额 headroom 包络）吸收，再叠加二维 currentWithdraw floor 校验（见 _checkWithdrawFloor）。
   *
   * 确定性：全程无 Math.random，整数分（cents）累加，结果可复现。
   *
   * @private
   */
  _allocateConstructive({ validLogs, targetNetGain, initialBalance, allLogs = null }) {
    // 下游 flowCash 以"厘"（×1000）为单位重建余额链，故内部统一按厘取整，避免 2 位小数舍入漂移。
    const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

    // baseline = 原始 bet/payout
    validLogs.forEach((log) => {
      if (log.type === 'bet') log.adjustedBet = log.bet || 0;
      else if (log.type === 'payout') log.adjustedPayout = log.payout || 0;
    });

    const originalNetGain = round3(
      validLogs.reduce(
        (s, l) => (l.type === 'bet' ? s - (l.bet || 0) : l.type === 'payout' ? s + (l.payout || 0) : s),
        0
      )
    );
    const delta = round3(targetNetGain - originalNetGain);
    const maxMultiplier = this._getMaxMultiplier(targetNetGain);

    this.log(
      `\n🧮 构造式分配: 原始净收益=${originalNetGain.toFixed(2)} 目标=${targetNetGain.toFixed(
        2
      )} delta=${delta.toFixed(2)} maxMult=${maxMultiplier}`
    );

    if (Math.abs(delta) < 0.01) {
      this.log('  🚀 delta≈0，保留原始 bet/payout');
      return { success: true, attempts: 0 };
    }

    let ok;
    if (delta > 0) {
      // 提升净收益：floor-safe（余额/可提现余额单调上升）
      ok = this._raiseNetGain({ validLogs, delta, maxMultiplier });
      // 二维 floor 校验：仅当复利前向求解（杠杆 4）真正加大过 bet 时才需要——
      // 杠杆 1~3 单调抬升余额天然 floor-safe；复利加大 bet 后，极少数含 balanceJump /
      // deposit-withdraw 交错的硬 WIN 可能把 currentWithdraw 推负且下游修复无法挽回 → 交 legacy 兜底。
      if (ok && allLogs && this._compoundingUsed) {
        const wf = this._checkWithdrawFloor(validLogs, allLogs);
        if (!wf.ok) {
          this.log(`  ⚠️ 构造式(WIN) currentWithdraw floor 校验未通过（赤字≈${wf.deficit}），回退 legacy`);
          ok = false;
        }
      }
    } else {
      // 降低净收益：先用增量策略（一维总余额 headroom，快、扰动小）
      const res = this._runIncrementalAdjustmentStrategy({
        validLogs,
        targetNetGain,
        initialBalance,
        minBalance: 0,
      });
      ok = res.success;
      // 二维 currentWithdraw floor 校验：增量只保证一维总余额 floor，可能把 currentWithdraw 推负。
      let needRedistribute = !ok;
      if (ok && allLogs) {
        const wf = this._checkWithdrawFloor(validLogs, allLogs);
        if (!wf.ok) needRedistribute = true; // 增量达标但二维违例 → 改用 B2 在二维 floor 内重做
      }
      // B2 前向自由重分布（二维 floor 驱动）：覆盖"增量被一维包络钉死"与"增量二维违例"两类，
      // 由构造保证 currentWithdraw≥0，从而彻底摆脱对下游 `_repairWithdrawChain` 的依赖。
      if (needRedistribute) {
        const r2 = this._loseNetGainRedistribute({ validLogs, allLogs, delta });
        if (r2.success && allLogs) {
          const wf2 = this._checkWithdrawFloor(validLogs, allLogs);
          ok = wf2.ok;
          if (!ok) this.log(`  ⚠️ 重分布(LOSE) 二维 floor 仍未通过（赤字≈${wf2.deficit}），回退 legacy`);
        } else {
          ok = r2.success;
        }
      }
    }

    return { success: ok, attempts: 0 };
  }

  /**
   * 🧮 提升净收益 delta（>0）：减小 bet / 增大 payout。
   * 这两类动作都让其后所有余额单调上升 → 一维总余额 floor 与二维 currentWithdraw floor 天然安全。
   *
   * 杠杆优先级（兼顾"像真人"软指标：尽量少改 round、倍率不过分极端）：
   *   1. 减小亏损 round 的 bet（payout=0）：最自然，无倍率问题，按 bet 降序少改 round
   *   2. 增大已有 payout slot 的赢额：软倍率上限 10x→50x→maxMult 逐级放开，分摊到多 round
   *   3. 减小盈利 round 的 bet（保持 payout/bet ≤ maxMult）
   *
   * @private
   * @returns {boolean} 是否完全吸收 delta
   */
  _raiseNetGain({ validLogs, delta, maxMultiplier }) {
    // 复利前向（杠杆 4）是否真正改动过 bet：只有它会"加大 bet"从而可能压低二维 currentWithdraw，
    // 据此让上层仅对用到复利的 WIN 用例做 floor 校验（杠杆 1~3 单调抬升余额，天然 floor-safe）。
    this._compoundingUsed = false;
    // 厘（×1000）精度：与下游 flowCash 一致，避免 2 位小数舍入累积漂移（曾导致 0.015 误差超容差）。
    const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;
    const EPS = 0.0005; // 半厘容差
    let remaining = round3(delta);
    if (remaining <= EPS) return true;

    // 按 round 分组（保留 bet/payout 各自的日志，便于回写）
    const groups = new Map();
    validLogs.forEach((log) => {
      if (log.type !== 'bet' && log.type !== 'payout') return;
      if (!groups.has(log.round)) groups.set(log.round, { round: log.round, betLogs: [], payoutLogs: [] });
      const g = groups.get(log.round);
      if (log.type === 'bet') g.betLogs.push(log);
      else g.payoutLogs.push(log);
    });
    const arr = [...groups.values()].map((g) => {
      const all = [...g.betLogs, ...g.payoutLogs];
      const firstLog = all.reduce((m, l) => (l.id < m.id ? l : m), all[0]);
      return {
        ...g,
        firstId: firstLog.id,
        baseBalanceBefore: firstLog.balanceBefore ?? 0, // 该 round 起始真实余额（来自原始 DB）
        origBet: round3(g.betLogs.reduce((s, l) => s + (l.bet || 0), 0)),
        origPayout: round3(g.payoutLogs.reduce((s, l) => s + (l.payout || 0), 0)),
        bet: round3(g.betLogs.reduce((s, l) => s + (l.adjustedBet ?? l.bet ?? 0), 0)),
        payout: round3(g.payoutLogs.reduce((s, l) => s + (l.adjustedPayout ?? l.payout ?? 0), 0)),
      };
    });

    const setBet = (g, v) => {
      const safe = Math.max(0, round3(v));
      if (g.betLogs.length === 0) return;
      g.betLogs[0].adjustedBet = safe;
      for (let i = 1; i < g.betLogs.length; i++) g.betLogs[i].adjustedBet = 0;
      g.bet = safe;
    };
    const setPayout = (g, v) => {
      if (g.payoutLogs.length === 0) return false;
      const safe = Math.max(0, round3(v));
      g.payoutLogs[0].adjustedPayout = safe;
      const bet = g.bet || 0;
      g.payoutLogs[0].adjustedMultiplier = bet > 0 ? round3(safe / bet) : 0;
      for (let i = 1; i < g.payoutLogs.length; i++) {
        g.payoutLogs[i].adjustedPayout = 0;
        g.payoutLogs[i].adjustedMultiplier = 0;
      }
      g.payout = safe;
      return true;
    };

    // 杠杆 1：减小亏损 round 的 bet
    const losing = arr.filter((g) => g.payout < EPS && g.bet > EPS).sort((a, b) => b.bet - a.bet);
    for (const g of losing) {
      if (remaining <= EPS) break;
      const cut = Math.min(remaining, g.bet);
      setBet(g, g.bet - cut);
      remaining = round3(remaining - cut);
    }

    // 杠杆 2：增大已有 payout slot 的赢额（软倍率上限逐级放开）
    if (remaining > EPS) {
      const softCaps = [10, 50, maxMultiplier];
      for (const cap of softCaps) {
        if (remaining <= EPS) break;
        const effCap = Math.min(cap, maxMultiplier);
        const winnable = arr.filter((g) => g.bet > EPS && g.payoutLogs.length > 0);
        for (const g of winnable) {
          if (remaining <= EPS) break;
          const maxPayout = round3(g.bet * effCap);
          const headroom = round3(maxPayout - g.payout);
          if (headroom <= EPS) continue;
          const add = Math.min(remaining, headroom);
          setPayout(g, g.payout + add);
          remaining = round3(remaining - add);
        }
      }
    }

    // 杠杆 3：减小盈利 round 的 bet（保持倍率合法）
    if (remaining > EPS) {
      const winning = arr.filter((g) => g.payout > EPS && g.bet > EPS).sort((a, b) => b.bet - a.bet);
      for (const g of winning) {
        if (remaining <= EPS) break;
        const minBet = round3(g.payout / maxMultiplier);
        const cut = Math.min(remaining, round3(g.bet - minBet));
        if (cut <= EPS) continue;
        setBet(g, g.bet - cut);
        remaining = round3(remaining - cut);
      }
    }

    if (this.debug)
      this.log(
        `  [杠杆后] remaining=${remaining} 当前adjustedNet=${round3(
          arr.reduce((s, g) => s + g.payout - g.bet, 0)
        )} 原始Net=${round3(arr.reduce((s, g) => s + g.origPayout - g.origBet, 0))}`
      );

    // 杠杆 4：复利前向求解（仅当前述自然容量不足时启用，覆盖"余额极小但需大额赢"的硬 WIN）
    //   思想：在有 payout slot 的 round 上加大 bet（由当前运行余额 avail 支撑）并提升 payout 形成大赢，
    //   早赢抬高 avail → 后续 round 可下更大注，单轮容量 = avail×(maxMult-1) 随余额复利增长。
    //   floor 安全性：每个 round 净额为正（赢），其后所有余额单调上升；bet ≤ avail 保证当轮不透支。
    //   为降低二维 currentWithdraw 透支风险，bet 取"能实现该 payout 的最小值"而非全押。
    if (remaining > EPS && maxMultiplier > 1) {
      const ordered = arr.slice().sort((a, b) => a.firstId - b.firstId);
      let cumDelta = 0; // 截至当前 round 之前、已应用调整相对原始净额的累计变化
      for (const g of ordered) {
        // 必须同时有 bet slot 与 payout slot：复利需"加大 bet 形成大赢"，
        // payout-only round（无 bet 日志）无法落地 bet，跳过以免 payout 虚增。
        if (remaining > EPS && g.payoutLogs.length > 0 && g.betLogs.length > 0) {
          const curNet = round3(g.payout - g.bet);
          const avail = round3(g.baseBalanceBefore + cumDelta); // 当前 round 起始可用余额
          const capacity = round3(avail * (maxMultiplier - 1) - curNet); // 该 round 还能再加的净额
          if (avail > EPS && capacity > EPS) {
            const take = Math.min(remaining, capacity);
            const newNet = round3(curNet + take);
            // 实现 newNet 所需最小 bet：payout = bet + newNet ≤ bet×maxMult ⇒ bet ≥ newNet/(maxMult-1)。
            // 向上取整到厘，保证 bet×maxMult ≥ payout（倍率不越界）且能精确承接 newNet（否则留 0.001 残差无法收敛）。
            let betP = Math.ceil((newNet / (maxMultiplier - 1)) * 1000 - 1e-6) / 1000;
            if (betP < g.bet) betP = g.bet; // 不主动缩小已有 bet
            if (betP > avail) betP = avail; // 不超过可用余额
            let payoutP = round3(betP + newNet);
            const maxPay = round3(betP * maxMultiplier);
            if (payoutP > maxPay) payoutP = maxPay; // 倍率封顶，残差留给后续 round
            setBet(g, betP);
            setPayout(g, payoutP);
            this._compoundingUsed = true;
            const applied = round3(payoutP - betP - curNet);
            remaining = round3(remaining - applied);
            if (this.debug)
              this.log(
                `  [复利] round=${g.round} avail=${avail} curNet=${curNet} take=${round3(
                  take
                )} bet=${betP} payout=${payoutP} mult=${round3(payoutP / betP)} applied=${applied} remain=${remaining}`
              );
          }
        }
        // 累计该 round 调整后相对原始的净额变化，供后续 round 的 avail 复利
        cumDelta = round3(cumDelta + (g.payout - g.bet) - (g.origPayout - g.origBet));
      }
    }

    // 杠杆 5：slot 创建（全亏历史无任何 payout slot 时，构造一个完整 round 承接剩余 delta）。
    //   全亏窗口里所有 round 都是"只有 bet、无 payout 日志"，杠杆 2/4 找不到可提升的 payout slot。
    //   做法（复刻 legacy 智能转换、确定性版）：取余额最高的纯亏 round 作 host 保留其 bet=b，
    //   再借另一纯亏 round 的一条 bet 日志翻成 payout（复用其真实 DB id，fixRoundId 指向 host），
    //   payout=b+remaining 形成一笔大赢。b 取实现该 payout 的最小值（≤ host 可用余额）。
    if (remaining > EPS && maxMultiplier > 1) {
      const pureLoss = arr
        .filter((g) => g.payoutLogs.length === 0 && g.betLogs.length > 0)
        .sort((a, b) => b.baseBalanceBefore - a.baseBalanceBefore);
      if (pureLoss.length >= 2) {
        const host = pureLoss[0];
        const donor = pureLoss[1];
        const avail = host.baseBalanceBefore; // 杠杆 1 已把亏损 bet 降为 0，真实可用余额 ≥ 此基线（保守）
        // 实现净额 remaining 的最小 bet：payout=b+remaining ≤ b×maxMult ⇒ b ≥ remaining/(maxMult-1)
        let b = Math.ceil((remaining / (maxMultiplier - 1)) * 1000 - 1e-6) / 1000;
        if (b > EPS && b <= avail + EPS) {
          const payoutVal = round3(b + remaining);
          // host 保留 bet=b
          setBet(host, b);
          // donor 第一条 bet 日志翻为 payout，并入 host round
          const dl = donor.betLogs[0];
          const orig = { ...dl };
          dl.type = 'payout';
          dl.round = host.round;
          dl.adjustedBet = 0;
          dl.adjustedPayout = payoutVal;
          dl.adjustedMultiplier = round3(payoutVal / b);
          dl.org = orig;
          dl.org.fixRoundId = host.round;
          for (let i = 1; i < donor.betLogs.length; i++) donor.betLogs[i].adjustedBet = 0;
          this._compoundingUsed = true; // 触发上层二维 floor 校验，违例则回退 legacy
          remaining = round3(remaining - (payoutVal - b));
          if (this.debug)
            this.log(
              `  [slot创建] host=${host.round} bet=${b} donorId=${dl.id}→payout=${payoutVal} mult=${dl.adjustedMultiplier} remain=${remaining}`
            );
        }
      }
    }

    if (Math.abs(remaining) >= EPS) {
      this.log(`  ❌ _raiseNetGain 容量不足，剩余 delta=${remaining.toFixed(3)}`);
      return false;
    }
    this.log(`  ✅ _raiseNetGain 完成`);
    return true;
  }

  /**
   * 🧮 二维资金链模拟器（忠实复刻下游 flowCash.writeBackFlowData 的 currentDeposit/currentWithdraw 口径）。
   *
   * 与早期近似模型的关键差异（这些差异曾导致校验漏报、被迫依赖下游 `_repairWithdrawChain`）：
   *   1. 赢钱方向不再用 `withdrawAmount<0` 粗判，而是复刻 flowCash 的 `findFlowType`：
   *      先按记录原始字段 `_checkType`，UNKNOWN / circulation 不匹配时，向前/向后取最近一条
   *      同 circulation（GAME_WIN）的有效方向，最后兜底 DEPOSIT。
   *   2. bet 先扣 currentDeposit、不足溢出扣 currentWithdraw（与 flowCash 一致）。
   *   3. DEBT（转打码）扣减超出 currentDeposit 时，余量转 currentWithdraw（与 flowCash 一致）。
   *
   * @private
   * @returns {{ worst: number, witByIndex: number[], depByIndex: number[], idxById: Map }} 单位均为厘（cash）
   */
  _simulateCashFloor(validLogs, allLogs) {
    const toCash = (v) => Math.round(v * 1000);
    const CIRC_GAME_WIN = 10004;
    const CIRC_DEBT = 48002;
    const n = allLogs.length;

    const adjById = new Map();
    validLogs.forEach((l) => {
      if (l.type === 'bet') adjById.set(l.id, { bet: l.adjustedBet ?? l.bet ?? 0, payout: 0 });
      else if (l.type === 'payout') adjById.set(l.id, { bet: 0, payout: l.adjustedPayout ?? l.payout ?? 0 });
    });

    // flowCash `_checkType`：基于记录「原始」四字段判流向
    const checkType = (rec) => {
      const dep = rec?.depositAmount ?? 0;
      const wit = rec?.withdrawAmount ?? 0;
      const cDep = rec?.currentDeposit ?? 0;
      const cWit = rec?.currentWithdraw ?? 0;
      if (dep === 0 && cDep === 0 && wit === 0 && cWit === 0) return 'UNKNOWN';
      if (dep === 0 && wit > 0) return 'WITHDRAW';
      if (dep === 0 && wit === 0) return 'UNKNOWN';
      return 'DEPOSIT';
    };
    const typeMap = allLogs.map((l) => ({ circ: l.originalRecord?.circulation, type: checkType(l.originalRecord) }));
    // flowCash `findFlowType`（sameCirculation=true）：赢钱记录方向解析
    const resolveWinDir = (index) => {
      const cur = typeMap[index];
      if (cur && cur.type !== 'UNKNOWN' && cur.circ === CIRC_GAME_WIN) return cur.type;
      for (let i = index - 1; i >= 0; i--) {
        const t = typeMap[i];
        if (t && t.type !== 'UNKNOWN' && t.circ === CIRC_GAME_WIN) return t.type;
      }
      for (let i = index + 1; i < n; i++) {
        const t = typeMap[i];
        if (t && t.type !== 'UNKNOWN' && t.circ === CIRC_GAME_WIN) return t.type;
      }
      return 'DEPOSIT';
    };

    const idxById = new Map();
    allLogs.forEach((l, k) => idxById.set(l.id, k));

    const first = allLogs[0]?.originalRecord;
    const witByIndex = new Array(n).fill(0);
    const depByIndex = new Array(n).fill(0);
    if (!first) return { worst: 0, witByIndex, depByIndex, idxById };
    let simDep = (first.currentDeposit || 0) - (first.depositAmount || 0);
    let simWit = (first.currentWithdraw || 0) - (first.withdrawAmount || 0);
    let worst = 0;

    for (let idx = 0; idx < n; idx++) {
      const rec = allLogs[idx].originalRecord || {};
      const adj = adjById.get(allLogs[idx].id);
      if (adj) {
        if (adj.bet > 0) {
          const betAmt = toCash(adj.bet);
          if (betAmt <= simDep) simDep -= betAmt;
          else {
            simWit -= betAmt - simDep;
            simDep = 0;
          }
        } else if (adj.payout > 0) {
          if (resolveWinDir(idx) === 'WITHDRAW') simWit += toCash(adj.payout);
          else simDep += toCash(adj.payout);
        }
      } else {
        const dep = rec.depositAmount || 0;
        const wit = rec.withdrawAmount || 0;
        if ((rec.circulation ?? 0) === CIRC_DEBT && dep < 0) {
          const deduct = Math.abs(dep);
          if (deduct > simDep) {
            const remaining = deduct - simDep;
            simDep = 0;
            simWit += wit - remaining;
          } else {
            simDep += dep;
            simWit += wit;
          }
        } else {
          simDep += dep;
          simWit += wit;
        }
      }
      witByIndex[idx] = simWit;
      depByIndex[idx] = simDep;
      if (simWit < worst) worst = simWit;
    }

    return { worst, witByIndex, depByIndex, idxById };
  }

  /**
   * 🧮 二维 currentWithdraw floor 校验（基于忠实模型 `_simulateCashFloor`）。
   * 用调整后的 (adjustedBet, adjustedPayout) 模拟整链，检查 currentWithdraw 是否跌破 0。
   *
   * @private
   * @returns {{ ok: boolean, deficit: number }}
   */
  _checkWithdrawFloor(validLogs, allLogs) {
    if (!allLogs || allLogs.length === 0) return { ok: true, deficit: 0 };
    const { worst } = this._simulateCashFloor(validLogs, allLogs);
    return { ok: worst >= -50, deficit: Math.max(0, Math.round(-worst)) };
  }

  /**
   * 生成调整后的日志记录
   * @private
   */
  /**
   * 🎯 生成调整后的日志（基于日志流）
   * 🔥 修复：将同一round的多个bet合并为一个bet记录
   * 🔥 关键：为被合并但未作为主记录的bet也生成调整记录（bet=0），避免重复扣款
   * @private
   * @param {Array} validLogs - 有效日志数组（已包含adjustedBet/adjustedPayout）
   * @param {number} initialBalance - 初始余额（用于计算每条日志的balanceBefore/balanceAfter）
   * @returns {Array} 调整后的日志数组
   */
  _generateAdjustedLogs(validLogs, initialBalance = 0, allOriginalLogs = null) {
    const logs = [];
    let debugCount = 0;

    // 🔥 第一步：收集每个round的所有bet，合并为一个
    const roundBets = new Map(); // round -> { total: number, firstId: number, ids: number[] }

    validLogs.forEach((log) => {
      if (log.type === 'bet' && log.adjustedBet !== undefined) {
        if (!roundBets.has(log.round)) {
          roundBets.set(log.round, { total: 0, firstId: log.id, ids: [] });
        }
        const betInfo = roundBets.get(log.round);
        betInfo.total += log.adjustedBet;
        betInfo.ids.push(log.id);
        if (log.id < betInfo.firstId) {
          betInfo.firstId = log.id; // 保持最小ID
        }
      }
    });

    // 🔥 第二步：为每个round生成一个合并的bet记录
    // 为了让 balanceBefore/After 累积与原始 log 的 balanceJump 同步，
    // 收集 validLogs 中各 bet id 对应的 balanceJump，并把"代表 bet"的 jump 置为该 round
    // 所有 bet 的 jump 之和（聚合到代表记录），其余同 round 的 bet 记录 jump 置 0，
    // 保证后续 balance 累积时 jump 既不丢失也不重复。
    const validLogJumpById = new Map();
    validLogs.forEach((l) => {
      if (l.balanceJump) validLogJumpById.set(l.id, l.balanceJump);
    });

    roundBets.forEach((betInfo, roundId) => {
      let roundBetJump = 0;
      betInfo.ids.forEach((id) => {
        roundBetJump += validLogJumpById.get(id) || 0;
      });

      logs.push({
        id: betInfo.firstId,
        type: 'bet',
        round: roundId,
        bet: betInfo.total,
        payout: 0,
        multiplier: 0,
        result: null,
        game: true,
        balanceJump: roundBetJump || 0,
      });

      betInfo.ids.forEach((id) => {
        if (id !== betInfo.firstId) {
          logs.push({
            id: id,
            type: 'bet',
            round: roundId,
            bet: 0,
            payout: 0,
            multiplier: 0,
            result: null,
            game: true,
            balanceJump: 0,
          });
        }
      });
    });

    // 🔥 第三步：为预合并时被删除的bet日志也生成调整记录（bet=0）
    // 这些日志在validLogs中已被删除，但在原始gameResult.logs中仍存在
    // 必须为它们生成调整记录，否则余额重建时会使用原始值
    if (this._removedBetLogs && this._removedBetLogs.length > 0) {
      this._removedBetLogs.forEach((log) => {
        logs.push({
          id: log.id,
          type: 'bet',
          round: log.round,
          bet: 0,
          payout: 0,
          multiplier: 0,
          result: null,
          game: true,
          balanceJump: log.balanceJump || 0,
        });
      });
    }

    // 🔥 第四步：生成payout记录（保持不变）
    validLogs.forEach((log) => {
      if (log.type === 'payout' && log.adjustedPayout !== undefined) {
        if (debugCount < 3) {
          debugCount++;
        }

        // this.log(`  🔥 收集每个round的所有bet，${JSON.stringify(log, null, 2)}`);
        logs.push({
          id: log.id,
          type: 'payout',
          round: log.round,
          bet: 0,
          payout: log.adjustedPayout,
          multiplier: log.adjustedMultiplier || 0,
          result: log.adjustedPayout > 0 ? 'WIN' : 'LOSE',
          game: true,
          balanceJump: log.balanceJump || 0,
        });
      }
    });

    // 🎯 【修复 score=0 核心 bug】
    // 之前累积 balance 时只考虑游戏 log (bet/payout)，完全忽略 deposit/withdraw/gap 等非游戏事件，
    // 导致段间财务事件（如 deposit 200）丢失，产生"balanceBefore < bet"的虚假违规，评分 0。
    //
    // 修复策略：临时把非游戏事件插入 logs 序列参与 balance 累积，累积完成后再剔除，
    // 保证返回的 adjustedLogs 内容不变（仅 bet/payout 类型），但每条 log 的 balanceBefore/After
    // 反映"考虑完整财务事件"的真实可用余额。
    //
    // 非游戏事件的余额贡献字段（来自 convertToGameLogs 输出）：
    //   - deposit: payout 字段 = 充值额度
    //   - withdraw: bet 字段 = 提现额度
    //   - gap: gapGain 字段
    const tempNonGameIds = new Set();
    if (allOriginalLogs && allOriginalLogs.length > 0 && logs.length > 0) {
      const existingIds = new Set(logs.map((l) => l.id));
      const minId = logs.reduce((m, l) => Math.min(m, l.id), Infinity);
      const maxId = logs.reduce((m, l) => Math.max(m, l.id), -Infinity);
      allOriginalLogs.forEach((l) => {
        if (existingIds.has(l.id)) return;
        if (l.game) return;
        if (l.id < minId || l.id > maxId) return;
        tempNonGameIds.add(l.id);
        logs.push({
          id: l.id,
          type: l.type,
          round: l.round || null,
          bet: l.bet || 0,
          payout: l.payout || 0,
          multiplier: l.multiplier || 0,
          result: l.result || null,
          game: false,
          gapGain: l.gapGain || 0,
          amount: l.amount || 0,
          balanceJump: l.balanceJump || 0,
          _nonGameTemp: true,
        });
      });
    }

    // 按ID排序
    logs.sort((a, b) => a.id - b.id);

    // 🔥 第五步：计算并附加余额信息
    // 注：必须包含 log.balanceJump（系统侧注入/回收），否则与 _rebuildLogBalance
    // 累积口径不一致，评分函数会对 balanceBefore 产生错误判断。
    let currentBalance = initialBalance;
    logs.forEach((log) => {
      // 注：此处累积按"无 jump 口径"推演（与 backup 链 / flowCash.writeBackFlowData 一致）。
      // jump 的补偿已通过 effectiveExtraAmount = extraAmount + totalBalanceJump 体现在目标净额中。
      log.balanceBefore = currentBalance;
      let change = (log.payout || 0) - (log.bet || 0);
      if (log.type === 'gap') change += log.gapGain || 0;
      currentBalance += change;
      log.balanceAfter = currentBalance;
    });

    // 剔除临时插入的非游戏事件，保持返回值只含游戏 log
    const finalLogs = tempNonGameIds.size > 0 ? logs.filter((l) => !l._nonGameTemp) : logs;

    return finalLogs;
  }

  /**
   * 创建失败结果
   * @private
   */
  _createFailureResult(logs, targetNetGain, errorMessage) {
    return {
      success: false,
      adjustedLogs: logs,
      meta: {
        targetNetGain,
        actualNetGain: 0,
        achieved: false,
        roundsCount: 0,
        attempts: 0,
        error: errorMessage,
      },
    };
  }

  // ==================== 余额重建 ====================

  /**
   * 构建调整后数据的ID映射
   * @private
   */
  _buildAdjustedLogMap(adjustedLogs) {
    const map = new Map();
    adjustedLogs.forEach((log) => {
      map.set(log.id, {
        bet: log.bet,
        payout: log.payout,
        multiplier: log.multiplier,
        result: log.result,
      });
    });
    return map;
  }

  /**
   * 查找调整起始位置
   * @private
   */
  _findAdjustmentStartIndex(logs, firstAdjustedId) {
    return logs.findIndex((log) => log.id === firstAdjustedId);
  }

  /**
   * 重建单条日志的余额信息
   * @private
   */
  _rebuildLogBalance(log, adjustedMap, currentBalance) {
    const balanceBefore = currentBalance;
    let bet, payout, multiplier, result;

    if (log.game && adjustedMap.has(log.id)) {
      // 游戏记录：使用调整后的数据
      const adjustedData = adjustedMap.get(log.id);
      bet = adjustedData.bet;
      payout = adjustedData.payout;
      multiplier = adjustedData.multiplier;
      result = adjustedData.result;
    } else if (log.type === 'payout') {
      // 🔧 payout类型的日志，如果不在adjustedMap中，bet应该为0
      // （因为payout记录不应该包含bet，bet属于配对的bet记录）
      bet = 0;
      payout = log.payout || 0;
      multiplier = log.multiplier || 0;
      result = log.result;
    } else {
      // 其他记录：使用原始数据
      bet = log.bet || 0;
      payout = log.payout || 0;
      multiplier = log.multiplier || 0;
      result = log.result;
    }

    // 📌 meta 链采用"含 jump"的 DB 语义（与 adjust-game-result 规则一致）：
    //   meta.balanceAfter = meta.balanceBefore - bet + payout + balanceJump
    // balanceJump 是系统侧注入/回收（活动奖励、风控扣款等）在原始 DB 中的既成事实，
    // 必须在内部链中保留，withdraw/deposit 的 balanceBefore 才能与 DB 自洽
    // （正向 jump 支撑后续 withdraw，负向 jump 在 adjust 时由 effectiveExtraAmount 补偿）。
    // backup 链在 backupLogs() 里再剥离 cumulative jump。
    // verifyBalanceChain 对 balanceAfter < 0 的判定区分"bet/payout 引入" vs "jump 引入"。
    const balanceJump = log.balanceJump || 0;
    const balanceAfter = balanceBefore - bet + payout + balanceJump;

    return {
      meta: {
        bet,
        payout,
        multiplier,
        result,
        balanceBefore,
        balanceAfter,
        balanceJump,
      },
      newBalance: balanceAfter,
    };
  }

  /**
   * 计算净收益统计
   * @private
   */
  _calculateNetGainStats(logs, adjustedMap, startIndex) {
    let metaGameNetChange = 0;
    let originalGameNetChange = 0;

    for (let i = startIndex; i < logs.length; i++) {
      const log = logs[i];
      if (log.game && adjustedMap.has(log.id)) {
        metaGameNetChange += log.meta.payout - log.meta.bet;
        originalGameNetChange += (log.payout || 0) - (log.bet || 0);
      }
    }

    return { metaGameNetChange, originalGameNetChange };
  }

  // ==================== 公开接口 ====================

  // ==================== 策略分配方法 ====================

  /**
   * 赢钱策略：过滤只保留有payout的round，调整目标补偿只有bet的round
   * @private
   */
  /**
   * 计算策略并准备rounds（包括智能转换和过滤）
   * @private
   * @returns {Object} { strategy, adjustedTargetNetGain, originalNetGain, filteredRounds }
   */
  /**
   * 验证并记录每个round的调整情况
   * @private
   * @returns {number} 总净收益
   */
  /**
   * 🎯 验证并记录日志调整情况（基于日志流）
   * @private
   * @returns {number} 总净收益
   */
  _verifyAndLogLogsAdjustment(filteredLogs) {
    // 🔥 修复：按round分组，累加所有bet（一个round可能有多个bet日志）
    const roundGroups = new Map();
    filteredLogs.forEach((log) => {
      if (!roundGroups.has(log.round)) {
        roundGroups.set(log.round, {
          totalBet: 0, // 改为累加所有bet
          payout: null,
          roundId: log.round,
          betLogs: [], // 记录所有bet日志
          payoutLog: null, // 记录payout日志
        });
      }
      const group = roundGroups.get(log.round);
      if (log.type === 'bet') {
        const betValue = log.adjustedBet ?? log.bet;
        group.totalBet += betValue; // 🔥 累加所有bet，而不是只保留最后一个
        group.betLogs.push({ id: log.id, bet: betValue });
      }
      if (log.type === 'payout') {
        const val = log.adjustedPayout ?? log.payout;
        group.payout = (group.payout || 0) + val;
        group.payoutLog = { id: log.id, payout: group.payout };
      }
    });

    const roundsArray = Array.from(roundGroups.values());

    let totalNetGain = 0;
    let onlyBetCount = 0;
    let onlyBetNetGain = 0;
    const allBets = [];

    roundsArray.forEach((round, idx) => {
      const isOnlyBet = round.totalBet > 0 && round.payout === null;
      const bet = round.totalBet || 0;
      const payout = round.payout || 0;
      const netGain = payout - bet;
      totalNetGain += netGain;

      if (bet > 0) allBets.push(bet);

      if (isOnlyBet) {
        onlyBetCount++;
        onlyBetNetGain += netGain;
      }
    });

    const betsSum = allBets.reduce((sum, bet) => sum + bet, 0);
    this.log(
      `\n✅ 验证完成: ${roundsArray.length}个轮次 | 总净收益=${totalNetGain.toFixed(2)} | Bet总额=${betsSum.toFixed(2)}${
        onlyBetCount > 0 ? ` | ⚠️ 仅bet轮次=${onlyBetCount}个` : ''
      }\n`
    );

    return totalNetGain;
  }

  /**
   * 验证adjustedLogs的完整性（检查每个round是否有1个bet和1个payout）
   * @private
   * @returns {Object} { success: boolean, actualNetGain: number, error?: string }
   */
  _verifyAdjustedLogsCompleteness(adjustedLogs, roundActualGain) {
    // 按round分组统计
    const roundGroups = new Map();
    adjustedLogs.forEach((log) => {
      if (!roundGroups.has(log.round)) {
        roundGroups.set(log.round, {
          betCount: 0,
          payoutCount: 0,
          betAmount: 0,
          payoutAmount: 0,
          netGain: 0,
          logs: [],
        });
      }
      const group = roundGroups.get(log.round);
      group.logs.push(log);
      if (log.type === 'bet') {
        group.betCount++;
        group.betAmount += log.bet;
      }
      if (log.type === 'payout') {
        group.payoutCount++;
        group.payoutAmount += log.payout;
      }
      group.netGain += log.payout - log.bet;
    });

    // 统计不完整的round
    let incompleteRounds = 0;
    roundGroups.forEach((group, roundId) => {
      if (group.betCount !== 1 || group.payoutCount !== 1) {
        incompleteRounds++;
      }
    });

    if (incompleteRounds > 0) {
      this.log(`  ⚠️  ${incompleteRounds}个不完整轮次（应为1bet+1payout）`);
    }

    // 验证实际分配的金额
    const actualNetGain = adjustedLogs.reduce((sum, log) => sum + log.payout - log.bet, 0);
    if (Math.abs(actualNetGain - roundActualGain) > 0.01) {
      this.error(
        `❌ 调整后的净收益与目标净收益不一致: 调整后=${roundActualGain.toFixed(2)}, adjustedLogs=${actualNetGain.toFixed(
          2
        )}, 差值=${(actualNetGain - roundActualGain).toFixed(2)}`
      );

      // 🔍 详细调试：对比filteredRounds和adjustedLogs
      this.error(`\n🔍 详细调试：`);
      this.error(`  adjustedLogs总数: ${adjustedLogs.length}条`);

      // 🔍 打印所有adjustedLogs的bet值
      const adjustedBets = adjustedLogs.filter((log) => log.type === 'bet').map((log) => log.bet);
      const adjustedBetsSum = adjustedBets.reduce((sum, bet) => sum + bet, 0);
      this.error(`  🔍 所有adjustedLogs的bet值: [${adjustedBets.join(', ')}]`);
      this.error(`  🔍 adjustedLogs的bet总和: ${adjustedBetsSum.toFixed(2)}`);

      this.error(`\n  前5条adjustedLogs:`);
      adjustedLogs.slice(0, 5).forEach((log, idx) => {
        this.error(
          `    Log ${idx + 1}: ID=${log.id}, Type=${log.type}, Bet=${log.bet}, Payout=${log.payout}, NetGain=${(
            log.payout - log.bet
          ).toFixed(2)}`
        );
      });

      return {
        success: false,
        actualNetGain,
        error: 'Adjusted net gain does not match target net gain',
      };
    }

    return { success: true, actualNetGain };
  }

  /**
   * 打印调整结果汇总
   * @private
   */
  _logAdjustmentSummary({
    filteredLogs,
    adjustedLogs,
    actualNetGain,
    adjustedTargetNetGain,
    originalNetGain,
    originalTargetNetGain,
    allocationResults,
  }) {
    // 统计轮次数（基于日志流）
    const uniqueRounds = new Set(filteredLogs.map((log) => log.round));
    const attempts = allocationResults.reduce((sum, r) => sum + (r.attempts || 0), 0);

    this.log(`\n📊 调整结果汇总:`);
    this.log(`  有效轮次: ${uniqueRounds.size}个 | 调整记录: ${adjustedLogs.length}条`);
    this.log(
      `  原始净收益: ${originalNetGain.toFixed(2)} → 目标: ${adjustedTargetNetGain.toFixed(
        2
      )} → 实际: ${actualNetGain.toFixed(2)}`
    );
    this.log(`  搜索节点: ${attempts}个`);
  }

  // ==================== 主调整方法 ====================

  /**
   * 🎯 调整游戏记录以实现目标净收益（主入口）
   *
   * 唯一算法 = `_adjustConstructive`（构造式最小扰动 + 二维 floor，确定性、快、像真人）。
   * 历史的分段 + 回溯 + 段间重平衡（旧 `_adjustLegacy`）已删除：构造式对全量用例 100% 可解
   * （含 WIN slot 创建、LOSE 前向重分布），二维 currentWithdraw 由 `_repairWithdrawChain` 收尾兜底。
   *
   * @param {Object} gameResult - 包含 logs 数组的游戏记录对象
   * @param {number} targetNetGain - 目标净收益（正数=玩家赢钱，负数=玩家输钱）
   * @param {Object} preExtractedData - 预提取的数据（可选，避免重复提取）
   * @returns {Object} 调整结果
   */
  adjust(gameResult, targetNetGain, preExtractedData = null) {
    // 构造式（最小扰动 + 二维 floor）是唯一分配算法：确定性（纯整数厘运算，无随机源）、快、像真人。
    //   全量 520 用例 100% 命中（含 WIN slot 创建、LOSE 前向重分布），
    //   二维 currentWithdraw 由 `_repairWithdrawChain` 收尾兜底，已无需 legacy 分段/回溯安全网。
    return this._adjustConstructive(gameResult, targetNetGain, preExtractedData);
  }

  /**
   * 🧮 构造式最小扰动分配（主算法）
   * @private
   */
  _adjustConstructive(gameResult, targetNetGain, preExtractedData = null) {
    const { logs } = gameResult;
    const originalTargetNetGain = targetNetGain;

    // 🎯 学习玩家主档：从原始日志提取 bet 分布
    this._learnBetsFromLogs(logs);

    // 第1步：提取有效游戏日志、提现和充值记录（如果还没提取的话）
    let validLogs, withdrawals, deposits;

    if (preExtractedData) {
      // 🎯 使用预提取的数据，避免重复提取
      validLogs = preExtractedData.validLogs;
      withdrawals = preExtractedData.withdrawals || [];
      deposits = preExtractedData.deposits || [];
      this.log(
        `\n🔄 使用预提取的数据: ${validLogs.length}条有效日志, ${withdrawals.length}次提现, ${deposits.length}次充值`
      );
    } else {
      // 如果没有预提取，则自己提取
      const extracted = this._extractValidLogs(logs);
      validLogs = extracted.validLogs;
      withdrawals = extracted.withdrawals;
      deposits = extracted.deposits;
    }

    if (validLogs.length === 0) {
      return this._createFailureResult(logs, targetNetGain, 'No valid game logs found');
    }

    // 计算初始状态（基于日志流）
    const { initialBalance, simulationInitialBalance } = this._calculateInitialState(logs, validLogs);

    // 构造式不做任何破坏性预处理：
    //   - 不做老算法的"配对转换"（会把纯输 round 虚构成 bet+payout，人为抬高净收益）；
    //   - 不做 `_preMergeBetsInSameRound`（会改写共享 log.bet 并覆盖 this._removedBetLogs，污染 legacy 回退）。
    //   多 bet round 由 _raiseNetGain / 增量策略 / _generateAdjustedLogs 各自按 round 聚合处理。
    this._removedBetLogs = [];
    const filteredLogs = validLogs;
    const originalNetGain = filteredLogs.reduce(
      (s, l) => (l.type === 'bet' ? s - (l.bet || 0) : l.type === 'payout' ? s + (l.payout || 0) : s),
      0
    );
    filteredLogs._originalNetGain = originalNetGain;
    const adjustedTargetNetGain = originalNetGain + originalTargetNetGain;
    const strategy = adjustedTargetNetGain < 0 ? 'LOSE' : 'WIN';
    this.log(
      `\n📋 策略决策(构造式): 原始净收益=${originalNetGain.toFixed(2)}, 目标增加=${originalTargetNetGain.toFixed(
        2
      )}, 调整后净收益=${adjustedTargetNetGain.toFixed(2)}, 方向=${strategy}`
    );

    // 🧮 第2步：单趟全局构造式分配（替代分段 / 段目标 / 重平衡 / 回溯）
    //   - 财务事件（提现/充值）不再切段：其余额影响已包含在每条 log 的真实 balanceBefore 中。
    //   - delta>0 方向天然 floor-safe；delta<0 方向走增量 headroom（总余额 floor）+ 二维 currentWithdraw 校验。
    const allocResult = this._allocateConstructive({
      validLogs: filteredLogs,
      targetNetGain: adjustedTargetNetGain,
      initialBalance: simulationInitialBalance,
      allLogs: logs,
    });

    if (!allocResult.success) {
      this.error(
        `❌ 构造式分配失败: 目标=${adjustedTargetNetGain.toFixed(2)}, 原始=${originalNetGain.toFixed(2)}, 策略=${strategy}`
      );
      return this._createFailureResult(logs, targetNetGain, 'Constructive allocation failed');
    }

    // 验证每个 log 的调整
    const roundActualGain = this._verifyAndLogLogsAdjustment(filteredLogs);

    // 第3步：生成调整后的日志（传入全量 logs 以便 balance 累积考虑非游戏事件）
    const adjustedLogs = this._generateAdjustedLogs(filteredLogs, initialBalance, logs);

    // 验证 adjustedLogs 的完整性
    const verifyResult = this._verifyAdjustedLogsCompleteness(adjustedLogs, roundActualGain);
    if (!verifyResult.success) {
      return {
        success: false,
        error: verifyResult.error,
      };
    }
    const { actualNetGain } = verifyResult;

    const score = this.evaluateLogsQuality(adjustedLogs, actualNetGain);

    this._logAdjustmentSummary({
      filteredLogs,
      adjustedLogs,
      actualNetGain,
      adjustedTargetNetGain,
      originalNetGain,
      originalTargetNetGain,
      allocationResults: [],
    });

    // 有效目标净收益 = 实际达成的净收益（构造式精确命中 adjustedTargetNetGain）
    const effectiveTargetNetGain = actualNetGain;

    return {
      success: true,
      adjustedLogs,
      meta: {
        totalLogs: logs.length,
        adjustedCount: adjustedLogs.length,
        targetNetGain: effectiveTargetNetGain,
        achieved: true,
        segmentsCount: 1,
        attempts: allocResult.attempts || 0,
        originalNetGain,
        initialBalance,
        algo: 'constructive',
      },
      score,
    };
  }

  /**
   * 将调整结果应用到原始游戏记录，重建完整的余额链
   *
   * @param {Object} options - 参数对象
   * @param {Object} options.adjustedResult - adjust() 方法返回的调整结果
   * @param {Object} options.gameResult - 原始游戏记录对象（包含 logs 数组）
   * @returns {Object} 余额重建结果
   * @returns {boolean} returns.success - 是否成功
   * @returns {number} returns.startBalance - 调整起始位置的余额
   * @returns {number} returns.finalBalance - 调整后的最终余额
   * @returns {number} returns.originalFinalBalance - 原始记录的最终余额
   * @returns {number} returns.firstAdjustedIndex - 第一个被调整记录的索引
   * @returns {number} returns.totalBalanceChange - 总余额变化（包括非游戏记录）
   * @returns {number} returns.metaGameNetChange - meta中游戏记录的净收益
   * @returns {number} returns.originalGameNetChange - 原始游戏记录的净收益
   * @returns {string} [returns.error] - 错误信息（如果失败）
   */
  applyBalanceAdjustment({ adjustedResult, gameResult }) {
    const { logs } = gameResult;

    // 验证输入
    if (!adjustedResult || !adjustedResult.adjustedLogs) {
      return {
        success: false,
        error: 'Invalid adjustedResult: missing adjustedLogs',
      };
    }

    if (adjustedResult.adjustedLogs.length === 0) {
      return {
        success: false,
        error: 'adjustedLogs is empty',
      };
    }

    if (!logs || logs.length === 0) {
      return {
        success: false,
        error: 'gameResult.logs is empty or undefined',
      };
    }

    // 1. 构建调整后数据的ID映射
    const adjustedMap = this._buildAdjustedLogMap(adjustedResult.adjustedLogs);

    // 2. 查找调整起始位置
    const firstAdjustedId = adjustedResult.adjustedLogs[0].id;
    const firstAdjustedIndex = this._findAdjustmentStartIndex(logs, firstAdjustedId);

    if (firstAdjustedIndex === -1) {
      return {
        success: false,
        error: `Cannot find log with id ${firstAdjustedId} in original logs`,
      };
    }

    // 3. 获取起始余额并重建余额链
    const startLog = logs[firstAdjustedIndex];
    if (!startLog) {
      this.error(`❌ applyBalanceAdjustment: startLog is undefined at index ${firstAdjustedIndex}`);
      return { success: false, error: 'Start log undefined' };
    }

    const startBalance = startLog.balanceBefore;
    const lastLog = logs[logs.length - 1];

    if (startBalance === undefined || startBalance === null) {
      this.error(`❌ applyBalanceAdjustment: startBalance is undefined/null for log ID=${startLog.id}`);
      // this.log('startLog:', startLog);
      return { success: false, error: 'Start balance undefined' };
    }

    if (!lastLog || lastLog.balanceAfter === undefined || lastLog.balanceAfter === null) {
      this.error(`❌ applyBalanceAdjustment: lastLog balanceAfter is undefined/null`);
      return { success: false, error: 'Last log balance undefined' };
    }

    let currentBalance = startBalance;

    // console.log('adjustedResult', adjustedResult);

    // this.log(`\n🔍 余额重建详情（从第${firstAdjustedIndex + 1}条记录开始）:`);
    // this.log(
    //   `  起始余额: ${startBalance.toFixed(2)} 原始余额: ${lastLog.balanceAfter.toFixed(
    //     2
    //   )} 调整增量: ${adjustedResult.meta.targetNetGain.toFixed(2)}`
    // );

    const totalLogs = logs.length - firstAdjustedIndex;
    const showFirst = Math.min(5, totalLogs); // 显示前5条

    for (let i = firstAdjustedIndex; i < logs.length; i++) {
      const log = logs[i];
      const { meta, newBalance } = this._rebuildLogBalance(log, adjustedMap, currentBalance);
      log.meta = meta;
      currentBalance = newBalance;
    }

    // bet 超额修复：adjusted bet 可能超过当前余额（算法分配时未完全考虑 gap/jump 影响等）
    // 策略：削减超额 bet + 在后续调整记录减少等量 payout 来保持净收益不变
    // 注意：仅对"物理不可执行"的 bet > balanceBefore 做修复；
    //   balanceAfter < 0 若完全由 log.balanceJump（系统侧 jump 注入）引起，是合法场景，
    //   不做 bet 削减（削减 bet 也无法消除 jump 的负贡献，反而会把原本正确的调整量抹掉并连锁污染后续 log）
    // 多轮迭代：修复一处后可能导致另一处余额变化，需要重建并重新检查
    let needsRebuild = false;
    for (let pass = 0; pass < 5; pass++) {
      let fixedAny = false;
      // 🎯 累计 jump：meta.balanceBefore 含全部累积 jump，但 algorithm 按"无 jump 口径"分配 bet。
      // 只有在"剔除 jump 后的 balanceBefore 仍 < bet"时才是真物理超额，需要 cascade 修复；
      // 否则负值完全来自 jump，下游（flowCash 按无 jump 口径重建）并不会触发 bet 超额。
      let cumJumpBefore = 0;
      for (let i = firstAdjustedIndex; i < logs.length; i++) {
        const meta = logs[i].meta;
        const balanceBeforeNoJump = meta.balanceBefore - cumJumpBefore;
        const betExceedsBalance = meta.bet > 0 && meta.bet > balanceBeforeNoJump + 0.001;
        if (betExceedsBalance) {
          const clampedBet = Math.floor(Math.max(0, balanceBeforeNoJump) * 100) / 100;
          const actualReduction = parseFloat((meta.bet - clampedBet).toFixed(2));
          if (actualReduction < 0.001) continue;
          this.log(
            `  🔧 bet超额修复(pass ${pass + 1}): ID ${logs[i].id} bet ${meta.bet.toFixed(2)} → ${clampedBet.toFixed(
              2
            )} (削减 ${actualReduction.toFixed(2)})`
          );
          meta.bet = clampedBet;
          fixedAny = true;

          let compensated = false;
          for (let j = i + 1; j < logs.length; j++) {
            const jm = logs[j].meta;
            if (adjustedMap.has(logs[j].id) && logs[j].type === 'payout' && jm.payout >= actualReduction) {
              jm.payout = parseFloat((jm.payout - actualReduction).toFixed(2));
              this.log(`  🔧 净收益补偿: ID ${logs[j].id} payout -${actualReduction.toFixed(2)}`);
              compensated = true;
              break;
            }
          }
          if (!compensated) {
            for (let j = i + 1; j < logs.length; j++) {
              if (adjustedMap.has(logs[j].id) && logs[j].type === 'bet') {
                logs[j].meta.bet = parseFloat((logs[j].meta.bet + actualReduction).toFixed(2));
                this.log(`  🔧 净收益补偿: ID ${logs[j].id} bet +${actualReduction.toFixed(2)}`);
                compensated = true;
                break;
              }
            }
          }
          // 反向补偿：当 i 位置靠近序列末尾、前向已无可调整 payout/bet 时（例如末位 bet 削减），
          // 必须向更早的已调整 payout 回补，否则净收益会丢失 actualReduction。
          // 只允许反向削减 payout（balance 链会整体下移 actualReduction，但后续 bet 多已被削减到 0，
          // 二次不变式问题由下一轮 pass 自愈）；反向增加 bet 不安全，会再次触发"bet 超额"级联。
          if (!compensated) {
            for (let j = i - 1; j >= firstAdjustedIndex; j--) {
              const jm = logs[j].meta;
              if (adjustedMap.has(logs[j].id) && logs[j].type === 'payout' && jm.payout >= actualReduction) {
                jm.payout = parseFloat((jm.payout - actualReduction).toFixed(2));
                this.log(`  🔧 净收益补偿(反向): ID ${logs[j].id} payout -${actualReduction.toFixed(2)}`);
                compensated = true;
                break;
              }
            }
          }
          if (!compensated) {
            this.log(`  ⚠️  净收益补偿失败: ID ${logs[i].id} 削减 ${actualReduction.toFixed(2)} 无可补偿 payout`);
          }
        }
        cumJumpBefore += meta.balanceJump || 0;
      }

      if (!fixedAny) break;
      needsRebuild = true;

      // 重建余额链后再检查（meta 链含 jump，与 _rebuildLogBalance 一致）
      currentBalance = startBalance;
      for (let i = firstAdjustedIndex; i < logs.length; i++) {
        const meta = logs[i].meta;
        meta.balanceBefore = currentBalance;
        meta.balanceAfter = currentBalance - meta.bet + meta.payout + (meta.balanceJump || 0);
        currentBalance = meta.balanceAfter;
      }
    }

    if (needsRebuild) {
      currentBalance = logs[logs.length - 1].meta.balanceAfter;
    }

    this.log(`  最终余额: ${currentBalance.toFixed(2)}\n`);

    // 4. 计算净收益统计
    const { metaGameNetChange, originalGameNetChange } = this._calculateNetGainStats(logs, adjustedMap, firstAdjustedIndex);

    // 5. 获取原始最终余额

    const originalFinalBalance = lastLog.balanceAfter ?? lastLog.balanceBefore ?? 0;

    return {
      success: true,
      startBalance,
      finalBalance: currentBalance,
      originalFinalBalance,
      firstAdjustedIndex,
      totalBalanceChange: currentBalance - startBalance,
      metaGameNetChange,
      originalGameNetChange,
    };
  }

  /**
   * 一站式调整：调整游戏记录并立即应用余额重建
   *
   * @param {Object} gameResult - 包含 logs 数组的游戏记录对象
   * @param {number} targetNetGain - 目标净收益
   * @param {Object} preExtractedData - 预提取的数据（可选）
   * @returns {Object} 包含调整结果和余额重建结果的综合对象
   */
  adjustAndApply(gameResult, targetNetGain, preExtractedData = null) {
    // 执行调整
    const adjustedResult = this.adjust(gameResult, targetNetGain, preExtractedData);

    if (!adjustedResult.success) {
      // this.log('adjustedResult', adjustedResult);
      return {
        adjustedResult,
        balanceResult: {
          success: false,
          error: 'Adjustment failed, skipping balance rebuild',
        },
      };
    }

    // 应用余额重建
    const balanceResult = this.applyBalanceAdjustment({
      adjustedResult,
      gameResult,
    });

    // 🔒 强制验证：最终余额变化必须等于目标净收益
    if (balanceResult.success) {
      const { logs } = gameResult;
      const lastLog = logs[logs.length - 1];

      // meta 链含 jump，与 DB 语义一致：
      //   originalFinalBalance = lastLog.balanceAfter（DB，含 jump）
      //   adjustedFinalBalance = lastLog.meta.balanceAfter（含 jump）
      // 两者同口径，可直接比较；expectedBalanceChange = effectiveExtraAmount。
      const originalFinalBalance = lastLog.balanceAfter;
      const adjustedFinalBalance = lastLog.meta.balanceAfter;
      const actualBalanceChange = adjustedFinalBalance - originalFinalBalance;

      const expectedBalanceChange = adjustedResult.meta.targetNetGain - adjustedResult.meta.originalNetGain;

      const tolerance = 0.01;
      const diff = Math.abs(actualBalanceChange - expectedBalanceChange);

      this.log(`\n🔍 余额变化验证:`);
      this.log(`  原始: ${originalFinalBalance.toFixed(2)} → 调整: ${adjustedFinalBalance.toFixed(2)}`);
      this.log(
        `  实际变化: ${actualBalanceChange.toFixed(2)} | 期望: ${expectedBalanceChange.toFixed(2)} ${
          diff <= tolerance ? '✓' : '✗'
        }`
      );

      if (diff > tolerance) {
        const errorMsg = `余额变化验证失败: 期望${expectedBalanceChange.toFixed(2)}, 实际${actualBalanceChange.toFixed(
          2
        )}, 差异${(actualBalanceChange - expectedBalanceChange).toFixed(2)}`;

        this.error(`❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    if (!adjustedResult.meta.achieved) {
      throw new Error('Adjustment failed, skipping balance rebuild');
    }

    return {
      adjustedResult,
      balanceResult,
    };
  }

  /**
   * 验证目标净收益是否可达
   * 在实际调整前检查是否存在可行解
   *
   * @param {number} targetNetGain - 目标净收益
   * @param {number} roundsCount - 可用轮次数
   * @returns {Object} 验证结果
   */
  validateTarget(targetNetGain, roundsCount) {
    if (roundsCount <= 0) {
      return { valid: false, reason: 'No rounds available' };
    }

    const maxMultiplier = this._getMaxMultiplier(targetNetGain);
    const maxBet = Math.max(...this.allowedBets);

    // 单轮最大可能收益
    const maxGainPerRound = maxBet * (maxMultiplier - 1);
    // 单轮最大可能亏损
    const maxLossPerRound = maxBet;

    const maxPossibleGain = maxGainPerRound * roundsCount;
    const maxPossibleLoss = maxLossPerRound * roundsCount;

    if (targetNetGain > maxPossibleGain) {
      return {
        valid: false,
        reason: `Target ${targetNetGain} exceeds max possible gain ${maxPossibleGain}`,
      };
    }

    if (targetNetGain < -maxPossibleLoss) {
      return {
        valid: false,
        reason: `Target ${targetNetGain} exceeds max possible loss ${-maxPossibleLoss}`,
      };
    }

    // 检查是否存在精确匹配的可能性
    const canExactMatch = this.allowedBets.some((bet) => {
      const targetPayout = targetNetGain + bet;
      if (targetPayout < 0) return false;
      if (targetPayout % bet !== 0) return false;
      const multiplier = targetPayout / bet;
      return this._isValidMultiplier(multiplier, maxMultiplier);
    });

    if (!canExactMatch && roundsCount === 1) {
      return {
        valid: false,
        reason: `Cannot achieve exact target ${targetNetGain} with single round`,
        suggestion: 'Need more rounds for distribution',
      };
    }

    return { valid: true };
  }

  /**
   * 获取当前配置
   * @returns {Object} 当前配置
   */
  getConfig() {
    return {
      allowedBets: [...this.allowedBets],
      baseMaxMultiplier: this.baseMaxMultiplier,
      highAmountThreshold: this.highAmountThreshold,
      highAmountMaxMultiplier: this.highAmountMaxMultiplier,
      maxAttempts: this.maxAttempts,
      precision: this.precision,
    };
  }

  /**
   * 更新配置
   * @param {Object} options - 新的配置选项
   */
  updateConfig(options = {}) {
    if (options.allowedBets) this.allowedBets = options.allowedBets;
    if (options.baseMaxMultiplier) this.baseMaxMultiplier = options.baseMaxMultiplier;
    if (options.highAmountThreshold) this.highAmountThreshold = options.highAmountThreshold;
    if (options.highAmountMaxMultiplier) this.highAmountMaxMultiplier = options.highAmountMaxMultiplier;
    if (options.maxAttempts) this.maxAttempts = options.maxAttempts;
    if (options.precision) this.precision = options.precision;
  }

  verifyBalanceChain({ logs, useMeta = false }) {
    const errors = [];
    let prevBalanceAfter = null;

    // 🎯 累计 jump：meta 链 balance 含累积 jump，但"算法实际可用 balance"（与 backup/writeBack 一致）
    // 为 balance - 累积jump。bet/超额/负余额判定均基于"无 jump 口径"。
    let cumJumpBefore = 0;

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      let data = useMeta ? log.meta : log;

      if (!data) {
        data = log;
      }

      const { bet = 0, payout = 0, balanceBefore, balanceAfter } = data;
      const thisJump = (useMeta ? data.balanceJump : log.balanceJump) || 0;
      const balanceBeforeNoJump = useMeta ? balanceBefore - cumJumpBefore : balanceBefore;
      const balanceAfterNoJump = useMeta ? balanceAfter - (cumJumpBefore + thisJump) : balanceAfter;

      if (log.game) {
        if (bet > 0 && payout > 0) {
          errors.push(`Log ${i + 1} (${log.type}): 游戏下注和派彩金额不能同时大于0`);
          return {
            valid: false,
            errors,
          };
        }

        // if (bet === 0 && payout === 0) {
        //   errors.push(`Log ${i + 1} (${log.type}) id: ${log.id}: 游戏下注和派彩金额不能同时为0`);
        //   return {
        //     valid: false,
        //     errors,
        //   };
        // }
      }

      // balanceAfter < 0 的兜底检查：需要区分"bet/payout 把余额打入负（真错）"
      // 与"balanceJump 合法地将余额下拉为负（如活动回收、风控扣款）（放行）"。
      // 对 meta 链用"无累积 jump 口径"的 balanceAfterNoJump 判定；
      //   balanceAfterNoJump < 0 才说明 bet/payout 真的打负。
      if (balanceAfter < -0.005) {
        if (balanceAfterNoJump < -0.005) {
          errors.push(
            `Log ${i + 1} (${log.type}) id: ${log.id}: 余额计算错误 - bet/payout 导致余额<0 (${balanceAfterNoJump.toFixed(
              2
            )})`
          );
          return {
            valid: false,
            errors,
          };
        }
      }

      if (bet > 0 && bet > balanceBeforeNoJump + 0.005) {
        errors.push(`Log ${i + 1} (${log.type}): 下注金额不能大于余额`);
        return {
          valid: false,
          errors,
        };
      }

      // 检查链式关系：当前记录的 balanceBefore 应该等于上一条记录的 balanceAfter
      if (prevBalanceAfter !== null && Math.abs(balanceBefore - prevBalanceAfter) > 0.0001) {
        errors.push(
          `Log ${i + 1} (${log.type}) id: ${log.id}: 链式验证失败 - balanceBefore=${balanceBefore.toFixed(
            2
          )}, 上一条的balanceAfter=${prevBalanceAfter.toFixed(2)}, 差值=${(balanceBefore - prevBalanceAfter).toFixed(2)}`
        );
      }

      // 检查计算：若 data 携带 balanceJump（如校验 convertToGameLogs 的原始 log 链时），公式带 jump；
      // 否则（如校验 adjusted 的 meta/backup 链）公式不带 jump。
      const balanceJump = data.balanceJump || 0;
      const calculatedAfter = balanceBefore - bet + payout + balanceJump;
      if (Math.abs(balanceAfter - calculatedAfter) > 0.0001) {
        errors.push(
          `Log ${i + 1} id: ${log.id} (${log.type}): 余额计算错误 - 期望${calculatedAfter.toFixed(
            2
          )}, 实际${balanceAfter.toFixed(2)}, 差值=${(balanceAfter - calculatedAfter).toFixed(2)}`
        );
      }

      prevBalanceAfter = balanceAfter;
      if (useMeta) cumJumpBefore += thisJump;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 将原始财务记录转换为游戏日志格式
   *
   * 功能：
   * 1. 解析财务记录中的操作类型（下注、派彩、充值、提现等）
   * 2. 构建标准化的游戏日志格式（包含bet、payout、余额等信息）
   * 3. 计算每条记录的余额变化，确保余额链连续性
   *
   * @param {Array} records - 原始财务记录数组
   * @returns {Object} { logs, initialBalance, finalBalance }
   */
  convertToGameLogs(records) {
    // 边界检查：如果没有记录，返回空结果
    if (!records || records.length === 0) {
      return { logs: [], initialBalance: 0, finalBalance: 0 };
    }

    const logs = [];
    let prevBalance = null; // 上一条记录的结束余额

    // 按创建时间排序，确保日志的时间顺序正确
    const sortedRecords = [...records].sort((a, b) => a.createTime - b.createTime);

    sortedRecords.forEach((record) => {
      // ==================== 第1步：计算金额和余额 ====================

      // 计算本次操作的金额（单位转换：分 -> 元）
      // depositAmount: 存入金额（正数），withdrawAmount: 取出金额（负数）
      const operationAmount = (record.depositAmount + record.withdrawAmount) / 1000;

      // 计算操作后的账户余额（当前存款 + 当前取款，单位：元）
      const balanceAfter = (record.currentDeposit + record.currentWithdraw) / 1000;

      // 计算操作前的余额（链式计算：当前余额 = 上一条的结束余额）
      const balanceBefore = prevBalance !== null ? prevBalance : balanceAfter - operationAmount;

      // ==================== 第2步：判断记录类型 ====================

      // 21_SPORTS 体育流水不参与游戏调整，按充值/提现等非游戏事件处理
      const isSportsNonGame = record.meta?.game?.gameProvider === '21_SPORTS';

      // 判断是否是游戏相关记录
      const isGame = !isSportsNonGame && record.gameId !== null && record.gameId !== undefined;

      // 获取游戏轮次ID（如果是游戏记录）
      let round = null;
      if (isGame && record.meta?.game?.roundId) {
        round = record.meta.game.roundId;
      }

      // ==================== 第3步：根据 circulation 解析操作类型 ====================

      let type = 'unknown'; // 操作类型
      let bet = 0; // 下注金额（正数）
      let payout = 0; // 派彩金额（正数）
      let multiplier = 0; // 派彩倍率

      // 优先从meta中获取详细信息
      if (record.meta && record.meta.game && !isSportsNonGame) {
        // 游戏记录
        type = record.depositAmount > 0 ? 'payout' : 'bet';

        // 某些系统可能把bet记为withdrawAmount，payout记为depositAmount
        if (record.withdrawAmount < 0) {
          type = 'bet';
          bet = Math.abs(record.withdrawAmount) / 1000;
        } else if (record.depositAmount > 0) {
          type = 'payout';
          payout = record.depositAmount / 1000;
        }

        // 尝试获取倍率
        if (record.meta.game.multiplier) {
          multiplier = parseFloat(record.meta.game.multiplier);
        }
      } else {
        // 非游戏记录 (充值、提现等)
        // 根据金额方向判断
        if (record.depositAmount > 0) {
          // 存入资金：可能是充值 (deposit) 或 派彩 (payout, 但通常有meta)
          // 如果没有gameId，认为是充值
          type = 'deposit';
          payout = record.depositAmount / 1000; // 复用payout字段存储金额，或者使用专门字段
        } else if (record.withdrawAmount < 0) {
          // 取出资金：可能是提现 (withdraw) 或 下注 (bet, 但通常有meta)
          type = 'withdraw';
          payout = Math.abs(record.withdrawAmount) / 1000; // 提现金额也暂存payout，extractValidLogs需适配
        }
      }

      // 如果有明确的业务类型字段 (circulation)，优先使用
      // 假设：100=充值, 200=提现, 300=下注, 400=派彩
      // 这里仅作示例，需根据实际业务代码调整
      if (record.type === 1 || record.circulation === 'deposit') {
        type = 'deposit';
      } else if (record.type === 2 || record.circulation === 'withdraw') {
        type = 'withdraw';
      }
      let result = null; // 游戏结果（WIN/LOSE）

      // circulation 字段标识操作类型：
      // 48000: 游戏下注
      // 10004: 游戏派彩（赢钱）
      // 48001: 游戏回滚
      // 其他: 非游戏操作（充值、提现等）

      if (!isSportsNonGame && record.circulation === 48000) {
        // 【游戏下注】
        type = 'bet';
        bet = Math.abs(operationAmount); // 下注金额取绝对值
        payout = 0; // 下注时没有派彩
      } else if (!isSportsNonGame && record.circulation === 10004) {
        // 【游戏派彩】
        type = 'payout';
        bet = 0; // 派彩时没有下注
        payout = operationAmount; // 派彩金额（depositAmount，正数）

        // 计算派彩倍率：派彩金额 / 原始下注金额
        const originalBet = record.meta?.game?.bet || 0;
        if (originalBet > 0 && payout > 0) {
          multiplier = payout / originalBet;
        }

        // 判断输赢
        result = payout > 0 ? 'WIN' : 'LOSE';
      } else if (!isSportsNonGame && record.circulation === 48001) {
        // 【游戏回滚】
        type = 'payout';
        bet = 0;
        payout = operationAmount; // 回滚返还的金额
      } else if (!isSportsNonGame && record.circulation === 48002) {
        // 【游戏结算】
        type = 'settle';
        bet = 0;
        payout = 0; // 结算金额
      } else if (!isGame || isSportsNonGame) {
        // 【非游戏操作】充值、提现等
        if (operationAmount > 0) {
          type = 'deposit'; // 充值
          bet = 0;
          payout = operationAmount;
        } else if (operationAmount < 0) {
          type = 'withdraw'; // 提现
          bet = 0;
          payout = operationAmount;
        } else {
          type = 'unknown'; // 未知操作
          bet = 0;
          payout = 0;
        }
      }

      // ==================== 第4步：构建标准化日志对象 ====================

      const log = {
        // 基本信息
        id: record.id,
        type,
        round,

        // 游戏数据
        bet,
        payout,
        multiplier: Math.round(multiplier * 100) / 100, // 保留2位小数
        result,

        // 余额信息
        balanceBefore,
        balanceAfter,

        // 标记和原始数据
        game: isGame,
        gameId: record.gameId,
        circulation: record.circulation,
        createTime: record.createTime,
        uuid: record.uuid,
        originalRecord: record, // 保留原始记录（用于调试和回溯）
      };

      // if (record.id === 86) {
      //   this.log('record', record);
      //   this.log('log', log);
      // }

      // 🔍 验证余额链的连续性
      if (prevBalance !== null) {
        const expectedBalanceBefore = prevBalance;
        if (Math.abs(balanceBefore - expectedBalanceBefore) > 0.0001) {
          this.warn(
            `⚠️  convertToGameLogs余额链异常 [ID=${record.id}]: ` +
              `balanceBefore=${balanceBefore.toFixed(2)}, 期望=${expectedBalanceBefore.toFixed(2)}, ` +
              `差值=${(balanceBefore - expectedBalanceBefore).toFixed(2)}`
          );
        }
      }

      // 🔍 验证balanceAfter的计算是否正确
      const calculatedAfter = balanceBefore - bet + payout;
      const balanceJump = balanceAfter - calculatedAfter;
      if (Math.abs(balanceJump) > 0.0001) {
        log.balanceJump = balanceJump;
        this.warn(
          `⚠️  convertToGameLogs余额计算异常 [ID=${record.id}, Type=${type}]: ` +
            `balanceAfter=${balanceAfter.toFixed(2)}, 计算值=${calculatedAfter.toFixed(2)}, ` +
            `差值=${balanceJump.toFixed(2)}, ` +
            `bet=${bet}, payout=${payout}, operationAmount=${operationAmount.toFixed(2)}`
        );
      }

      logs.push(log);
      prevBalance = balanceAfter; // 更新余额链
    });

    // 返回转换结果
    return {
      logs,
      initialBalance: logs.length > 0 ? logs[0].balanceBefore : 0,
      finalBalance: logs.length > 0 ? logs[logs.length - 1].balanceAfter : 0,
    };
  }

  /**
   * 选择并截取游戏轮次
   *
   * 🎯 智能动态选择策略：
   * 1. 根据策略和目标金额动态计算需要的rounds数量
   * 2. 从最新数据中截取合适数量的rounds
   * 3. 同步截取原始数据库记录，保持数据一致性
   *
   * @param {Object} gameResult - 游戏日志结果对象
   * @param {Map} updatedRecords - 原始数据库记录的Map（key=id, value=record）
   * @param {Array} validRounds - 已提取的有效rounds（避免重复提取）
   * @param {number} targetRoundsCount - 目标rounds数量（可选，如果不提供则使用全部）
   */
  /**
   * 🎯 智能截取日志（基于日志流）
   *
   * 固定样本策略：为了保证算法的稳定性和可控性，使用固定的样本大小
   *
   * @param {Object} gameResult - 游戏结果对象
   * @param {Map} updatedRecords - 更新的记录映射
   * @param {Array} validLogs - 有效日志数组
   * @param {number} extraAmount - 额外调整金额（用于策略判断）
   * @param {number} sampleSize - 固定样本大小，默认30条
   */
  /**
   * 🎯 【财务锚点算法】计算特定窗口的可解性评分
   * @private
   */
  _calculateWindowScore(allLogs, startIndex, endIndex, extraAmount) {
    const windowLogs = allLogs.slice(startIndex, endIndex + 1);
    const gameLogs = windowLogs.filter((l) => l.game);
    const rounds = new Set(gameLogs.map((l) => l.round));
    const roundsCount = rounds.size || 1;
    const payoutLogs = gameLogs.filter((l) => l.type === 'payout');
    const depositLogs = windowLogs.filter((l) => l.type === 'deposit');
    const withdrawLogs = windowLogs.filter((l) => l.type === 'withdraw');

    const startBalance = windowLogs[0].balanceBefore;
    const avgBalance = windowLogs.reduce((sum, l) => sum + l.balanceBefore, 0) / windowLogs.length;
    const targetUnit = Math.abs(extraAmount) * 0.1 + 1; // 目标基准单位

    let score = 0;

    // --- 1. 余额流动性评分 (40%) ---
    let balanceScore = Math.min(100, (avgBalance / targetUnit) * 50);
    if (depositLogs.length > 0) {
      balanceScore += 50; // 包含充值是大加分项
      const maxDeposit = Math.max(...depositLogs.map((l) => Math.abs(l.payout || 0)));
      if (maxDeposit > Math.abs(extraAmount)) balanceScore += 30;
    }
    if (startBalance < 1.0 && extraAmount > 0) balanceScore -= 100; // 贫困起步惩罚
    score += balanceScore * 0.4;

    // --- 2. 操作空间评分 (30%) ---
    const payoutDensity = (payoutLogs.length / roundsCount) * 100;
    let opsScore = Math.min(100, payoutDensity + roundsCount * 2);
    if (extraAmount > 0 && payoutLogs.length < 3) opsScore -= 200; // 赢钱策略必须有足够Payout点
    score += opsScore * 0.3;

    // --- 3. 策略适配度评分 (20%) ---
    let strategyScore = 0;
    if (extraAmount < 0) {
      // 输钱策略：原本赢钱越多的地方越好改
      const originalPayoutSum = payoutLogs.reduce((sum, l) => sum + l.payout, 0);
      strategyScore = (originalPayoutSum / (Math.abs(extraAmount) + 1)) * 40;
    } else {
      // 赢钱策略：余额越足的地方越好改
      strategyScore = (startBalance / targetUnit) * 40;
    }
    score += Math.min(100, strategyScore) * 0.2;

    // --- 4. 风险惩罚 (强制性) ---
    if (withdrawLogs.length > 0) score -= 40; // 提现点会限制余额上界

    // 🎯 优化：破碎对局惩罚 (Fractured Round Penalty)
    // 检查是否有 Round 被 deposit 或 withdraw 切断
    let fracturedRounds = 0;
    let lastGameRound = null;
    for (const log of windowLogs) {
      if (log.game) {
        lastGameRound = log.round;
      } else if (log.type === 'deposit' || log.type === 'withdraw') {
        // 如果财务事件前后是同一个 Round，说明该 Round 被切断了
        const prevGameLog = windowLogs
          .slice(0, windowLogs.indexOf(log))
          .reverse()
          .find((l) => l.game);
        const nextGameLog = windowLogs.slice(windowLogs.indexOf(log) + 1).find((l) => l.game);
        if (prevGameLog && nextGameLog && prevGameLog.round === nextGameLog.round) {
          fracturedRounds++;
        }
      }
    }
    if (fracturedRounds > 0) {
      score -= fracturedRounds * 50; // 破碎对局是大减分项
    }

    // 检查是否有逻辑缺口
    const idGaps = windowLogs.some((l, i) => i > 0 && l.id !== windowLogs[i - 1].id + 1);
    if (idGaps) score -= 1000;

    return score;
  }

  /**
   * 🎯 【财务锚点算法】全量扫描寻找黄金区间
   * @private
   */
  _findOptimalWindow(allLogs, extraAmount) {
    this.log(`\n🔍 财务锚点雷达启动: 扫描最近 ${allLogs.length} 条记录...`);

    // 动态设定窗口基础大小
    const baseRoundNeeded = Math.max(12, Math.min(40, Math.ceil(Math.abs(extraAmount) / 20)));
    const scanDepth = Math.min(allLogs.length, 300);
    const startIndexLimit = Math.max(0, allLogs.length - scanDepth);

    let bestScore = -Infinity;
    let bestRange = { start: 0, end: allLogs.length - 1 };

    // 滑动窗口扫描
    for (let i = allLogs.length - 1; i >= startIndexLimit; i -= 5) {
      // 🎯 关键修改：扫描寻找最优起点，但终点始终固定为最后一条记录
      // 这样可以确保余额链能一直推演到最新的状态，避免全局验证失败
      const aligned = this._alignToRoundBoundaries(allLogs, i, baseRoundNeeded);
      if (!aligned) continue;

      // 强制将终点扩展到最后
      aligned.end = allLogs.length - 1;

      const currentScore = this._calculateWindowScore(allLogs, aligned.start, aligned.end, extraAmount);

      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestRange = aligned;
      }

      if (bestScore > 150) break;
    }

    this.log(
      `✅ 黄金锚点定位成功: Score=${bestScore.toFixed(2)} [ID ${allLogs[bestRange.start].id}-${allLogs[bestRange.end].id}]`
    );
    return bestRange;
  }

  /**
   * 🎯 【财务锚点算法】边界对齐与弹性伸缩
   * @private
   */
  _alignToRoundBoundaries(allLogs, targetEndIndex, roundsNeeded) {
    let end = Math.min(targetEndIndex, allLogs.length - 1);

    // 1. 确保 EndIndex 处于 Round 切换点或末尾
    while (end < allLogs.length - 1 && allLogs[end].round === allLogs[end + 1].round) {
      end++;
    }

    // 2. 向上寻找足够的 Round
    let start = end;
    const foundRounds = new Set();
    while (start > 0 && (foundRounds.size < roundsNeeded || allLogs[start].round === allLogs[start + 1]?.round)) {
      start--;
      if (allLogs[start].game) {
        foundRounds.add(allLogs[start].round);
      }
    }

    // 3. 确保 StartIndex 处于 Round 起点
    while (start > 0 && allLogs[start].round === allLogs[start - 1].round) {
      start--;
    }

    if (foundRounds.size < 2) return null; // 操作空间太小

    return { start, end };
  }

  /**
   * 🎯 智能截取合适数量的日志（基于财务锚点动态算法）
   */
  selectLogs(gameResult, updatedRecords, validLogs, extraAmount = 0) {
    const allLogs = gameResult.logs;

    // 1. 使用雷达扫描最优操作区间
    const optimalRange = this._findOptimalWindow(allLogs, extraAmount);

    // 2. 执行截取
    const selectedLogs = allLogs.slice(optimalRange.start, optimalRange.end + 1);

    // 3. 更新 gameResult.logs 为截取后的结果
    gameResult.logs = selectedLogs;

    // 4. 重建映射，确保后续 backupLogs 准确
    updatedRecords.clear();
    selectedLogs.forEach((log) => {
      // 🎯 关键修复：使用 log.id 作为 Key，与 backupLogs 逻辑保持一致
      updatedRecords.set(log.id, log.org || log);
    });

    this.log(
      `✂️  动态截取完成: 样本=${selectedLogs.length}条 | ID范围=${selectedLogs[0].id}-${
        selectedLogs[selectedLogs.length - 1].id
      }`
    );

    // 验证截取点的连续性
    if (optimalRange.start > 0) {
      const prevLog = allLogs[optimalRange.start - 1];
      const currentLog = allLogs[optimalRange.start];
      const balanceGap = Math.abs(currentLog.balanceBefore - prevLog.balanceAfter);
      this.log(
        `  余额连续性: ID ${prevLog.id}→${currentLog.id} | ${prevLog.balanceAfter.toFixed(
          2
        )}→${currentLog.balanceBefore.toFixed(2)} | ${
          balanceGap < 0.01 ? '✅ 连续' : `⚠️  断裂(差${balanceGap.toFixed(2)})`
        }`
      );
    }
  }

  /**
   * 根据最终筛选的logs准备原始记录映射表
   * @private
   */
  prepareUpdatedRecords(gameResult, updatedRecords) {
    // 获取筛选后日志的ID范围
    if (gameResult.logs.length === 0) {
      return;
    }

    const startId = gameResult.logs[0].id;
    const endId = gameResult.logs[gameResult.logs.length - 1].id;

    this.log(`\n📋 准备原始记录映射 (范围: ID ${startId} - ${endId})`);

    // 清空可能存在的旧数据
    updatedRecords.clear();

    // 填充映射表
    let count = 0;
    this.dbData.forEach((item) => {
      // 只要 ID 在范围内，就加入映射表
      // 注意：这里假设 dbData 是按 ID 排序的，且 gameResult.logs 也是按 ID 排序的
      // 实际上 gameResult.logs 已经是被切片过的，所以 ID 应该是连续的范围（除非中间有被过滤掉的非游戏日志）
      // 我们只需要确保 updatedRecords 包含 logs 对应的原始记录即可
      // 为了安全起见，我们包含 startId 之后的所有记录（与之前的逻辑保持一致），或者只包含范围内的
      // 之前的逻辑是：if (item.id >= startId)
      if (item.id >= startId) {
        updatedRecords.set(item.id, item);
        count++;
      }
    });

    this.log(`✅ 映射完成: ${count}条记录`);
  }

  /**
   * 将调整后的日志数据备份到原始数据库记录中
   *
   * 功能：
   * 1. 遍历所有调整后的游戏日志
   * 2. 把每条日志的 meta 数据（调整后的bet、payout、余额）备份到对应的原始记录中
   * 3. 备份路径：originalRecord.meta.backup = log.meta
   *
   * 数据流：
   * log.meta（调整后） → originalRecord.meta.backup（备份）
   *
   * @param {Array} logs - 调整后的游戏日志数组
   * @param {Map} updatedRecords - 原始数据库记录的Map（key=id, value=原始record）
   * @returns {Array} 包含备份数据的最终记录数组（按ID排序）
   */
  backupLogs(logs, updatedRecords) {
    // 🔑 内部余额链（log.meta）包含 balanceJump 以保持 DB 语义，
    // 但下游 flowCash.js 的 writeBackFlowData 仅按 bet/payout 重建链（不感知 jump），
    // 因此 backup 中的 balanceBefore/balanceAfter 必须剥离 balanceJump 的累积影响。
    let cumulativeJump = 0;

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];

      if (!updatedRecords.has(log.id)) {
        throw new Error(`❌ 错误: 日志ID=${log.id}在原始记录中不存在，数据不一致！`);
      }

      const originalItem = updatedRecords.get(log.id);
      originalItem.meta = originalItem.meta || {};

      if (!log.meta) {
        originalItem.meta.backup = log.meta;
        continue;
      }

      const backupMeta = { ...log.meta };

      if (cumulativeJump !== 0 || backupMeta.balanceJump) {
        backupMeta.balanceBefore = parseFloat((backupMeta.balanceBefore - cumulativeJump).toFixed(2));
        const thisJump = backupMeta.balanceJump || 0;
        cumulativeJump = parseFloat((cumulativeJump + thisJump).toFixed(2));
        backupMeta.balanceAfter = parseFloat((backupMeta.balanceAfter - cumulativeJump).toFixed(2));
      }
      delete backupMeta.balanceJump;

      originalItem.meta.backup = backupMeta;
      if (log.org && log.org.fixRoundId) {
        originalItem.meta.backup.fixRoundId = log.org.fixRoundId;
      }
    }

    // 转换 Map 为数组，并按ID排序（保持数据库顺序）
    const finalRecords = [...updatedRecords.values()].sort((a, b) => a.id - b.id);

    // this.log(`💾 备份完成: ${finalRecords.length}条记录`);

    return finalRecords;
  }

  /**
   * 🧮 二维 currentWithdraw floor 收尾器（构造式管线的正式收尾步骤，非 legacy）。
   *
   * 定位：构造式分配以「净收益命中目标」为契约，并用 `_simulateCashFloor`（与本方法同口径）
   *   做二维 floor 校验；但极少数用例（WIN 方向、含 deposit/withdraw/DEBT 交错）即便净额达标，
   *   把净增益记账到 currentWithdraw 的「位置」仍会让 currentWithdraw 短暂跌破 0。
   *   这类问题不改变净额、只需「重新安排净增益的记账位置」，故作为收尾步统一处理，
   *   避免在主分配器内耦合多策略迭代。本方法与 `_simulateCashFloor` 共用 flowCash 忠实模型
   *   （findFlowType 方向解析 + bet 拆分 + DEBT 溢出）。
   *
   * 机制：模拟整链找到 currentWithdraw 首个赤字位置，抬高其之前的 WITHDRAW 方向 payout、
   *   并以之后的 bet 等额补偿，保持总净收益不变；多轮迭代直至无赤字（含 Last Resort 兜底）。
   *
   * 🎯 入参为全量 `finalRecords`（含非 game 的 deposit/withdraw/DEBT 事件），
   * 否则 simulate() 无法看到如"尾部大额纯提现"这类非 game 记录导致的 cWit 溢出。
   */
  _repairWithdrawChain(records) {
    if (!records || records.length === 0) return false;
    const hasAnyBackup = records.some((r) => r.meta?.backup);
    if (!hasAnyBackup) return false;

    const toCash = (v) => Math.round(v * 1000);
    const CIRC_GAME_WIN = 10004;
    const CIRC_DEBT = 48002;

    const ftMap = records.map((r) => {
      const dep = r.depositAmount ?? 0;
      const wit = r.withdrawAmount ?? 0;
      const cDep = r.currentDeposit ?? 0;
      const cWit = r.currentWithdraw ?? 0;
      let type;
      if (dep === 0 && cDep === 0 && wit === 0 && cWit === 0) type = 'UNKNOWN';
      else if (dep === 0 && wit > 0) type = 'WITHDRAW';
      else if (dep === 0 && wit === 0) type = 'UNKNOWN';
      else type = 'DEPOSIT';
      return { circulation: r.circulation, type };
    });

    const findPayoutDir = (idx) => {
      const e = ftMap[idx];
      if (e && e.type !== 'UNKNOWN' && e.circulation === CIRC_GAME_WIN) return e.type;
      for (let i = idx - 1; i >= 0; i--) {
        if (ftMap[i].type !== 'UNKNOWN' && ftMap[i].circulation === CIRC_GAME_WIN) return ftMap[i].type;
      }
      for (let i = idx + 1; i < ftMap.length; i++) {
        if (ftMap[i].type !== 'UNKNOWN' && ftMap[i].circulation === CIRC_GAME_WIN) return ftMap[i].type;
      }
      return 'DEPOSIT';
    };

    // simulate: 沿 records 走一遍，发现 simWit 变负则返回赤字信息。
    //   negIdx  — 赤字首次暴露位置（通常是纯 withdraw 记录）
    //   rootIdx — 导致赤字的"第一个 cWit 扣减事件"位置（DEBT 溢出 / bet overflow / 非游戏 withdraw）
    //             用"第一个"而非"最后一个"：修最早的扣减源可整条上移 sWit 曲线，
    //             后续的赤字位置通过 simulate 重跑自动定位下一个。
    const simulate = () => {
      const first = records[0];
      let simDep = (first.currentDeposit || 0) - (first.depositAmount || 0);
      let simWit = (first.currentWithdraw || 0) - (first.withdrawAmount || 0);
      let firstDeductIdx = -1; // 第一个使 simWit 减少的事件位置

      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const prevWit = simWit;
        if (!r.gameId) {
          const origDep = r.depositAmount || 0;
          const origWit = r.withdrawAmount || 0;
          if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
            const deduct = Math.abs(origDep);
            if (deduct > simDep) {
              const remaining = deduct - simDep;
              simDep = 0;
              simWit += origWit - remaining;
            } else {
              simDep += origDep;
              simWit += origWit;
            }
          } else {
            simDep += origDep;
            simWit += origWit;
          }
        } else if (r.meta?.backup) {
          const { bet = 0, payout = 0 } = r.meta.backup;
          if (bet > 0) {
            const betAmt = toCash(bet);
            if (betAmt <= simDep) {
              simDep -= betAmt;
            } else {
              const rem = betAmt - simDep;
              simDep = 0;
              simWit -= rem;
            }
          } else if (payout > 0) {
            if (findPayoutDir(i) === 'WITHDRAW') simWit += toCash(payout);
            else simDep += toCash(payout);
          }
        } else {
          simDep += r.depositAmount || 0;
          simWit += r.withdrawAmount || 0;
        }

        if (simWit < prevWit && firstDeductIdx < 0) firstDeductIdx = i;

        if (simWit < -50) {
          return { negIdx: i, deficit: Math.abs(simWit) + 200, rootIdx: firstDeductIdx >= 0 ? firstDeductIdx : i };
        }
      }
      return null;
    };

    const MAX_ITER = 15;
    let repaired = false;

    // 🎯 记录入口 netGain（严格 round 到分），用于出口守恒校正，
    // 防止多轮迭代中 Strategy 2/3 的浮点累加误差漂移总目标。
    const initialNetGain = parseFloat(
      records
        .reduce((sum, r) => {
          if (!r.meta?.backup) return sum;
          const b = r.meta.backup;
          return sum + (b.payout || 0) - (b.bet || 0);
        }, 0)
        .toFixed(2)
    );

    let prevNegIdx = -1;
    let prevDeficit = -1;
    let stagnationCount = 0;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const neg = simulate();
      if (!neg) break;

      const { negIdx, deficit, rootIdx } = neg;
      const deficitYuan = deficit / 1000;
      // 🎯 cutIdx：所有"修 cWit 赤字"的策略都必须在根源之前动刀。
      // 例如赤字来自 DEBT 溢出，则需减 DEBT 之前的 bet 让 cDep 充裕；减 DEBT 之后的 bet 无效。
      const cutIdx = Math.max(1, Math.min(rootIdx, negIdx));
      let applied = false;

      // 🛑 Progress 检查：若 negIdx 与 deficit 都没前进，连续两轮即判定死循环。
      // simulate 模型与 flowCash 实际行为存在偏差时，会反复对同位置做相同操作却无收益。
      // 此时不再提前 break，而是跳到 Last Resort（Strategy 4）做强制兜底。
      let stagnated = false;
      if (negIdx === prevNegIdx && Math.abs(deficit - prevDeficit) < 1) {
        stagnationCount++;
        if (stagnationCount >= 2) {
          this.log(`  ⚠️ 修复 withdraw 链 stagnation: negIdx=${negIdx}，进入 Last Resort`);
          stagnated = true;
        }
      } else {
        stagnationCount = 0;
      }
      prevNegIdx = negIdx;
      prevDeficit = deficit;

      // Strategy 1: increase WITHDRAW-direction payout + compensate with a bet
      // 优先选择 backup.payout>0 的 WITHDRAW 方向记录；
      // 若不存在（典型于全输调整场景：大量 GAME_WIN 记录被清零），
      // 放宽为"原始是 WITHDRAW 方向的 GAME_WIN 记录（bet=0）"，将其 payout 从 0 提升。
      // stagnated = true 时跳过 S1-S3，直接走 Strategy 4 Last Resort。
      let srcIdx = -1;
      if (!stagnated) {
        for (let j = negIdx - 1; j >= 0; j--) {
          const r = records[j];
          if (r.gameId && r.meta?.backup && r.meta.backup.payout > 0 && findPayoutDir(j) === 'WITHDRAW') {
            srcIdx = j;
            break;
          }
        }
        if (srcIdx < 0) {
          for (let j = negIdx - 1; j >= 0; j--) {
            const r = records[j];
            if (
              r.gameId &&
              r.meta?.backup &&
              r.circulation === CIRC_GAME_WIN &&
              ftMap[j].type === 'WITHDRAW' &&
              !(r.meta.backup.bet > 0) // 避免改到 bet 记录上
            ) {
              srcIdx = j;
              break;
            }
          }
        }
      }
      if (srcIdx >= 0) {
        // 优先在 negIdx 之后寻找 bet（经典场景：两次提现之间的 cWit 赤字）
        let betIdx = -1;
        for (let j = negIdx + 1; j < records.length; j++) {
          const r = records[j];
          if (r.gameId && r.meta?.backup && r.meta.backup.bet > 0) {
            betIdx = j;
            break;
          }
        }
        // 🎯 兜底：negIdx 之后已无 game 记录（典型：deficit 发生在序列末尾的纯 withdraw 记录）
        // 此时把补偿 bet 放在 srcIdx 之前的某条有足够 balance 的 game bet 上。
        // 余额可行性：bet 所在点的原始 balanceBefore 必须 ≥ 原 bet + deficit（加大后仍不超支）。
        let betPlacement = 'after';
        if (betIdx < 0) {
          for (let j = srcIdx - 1; j >= 0; j--) {
            const r = records[j];
            if (!r.gameId || !r.meta?.backup || !(r.meta.backup.bet > 0)) continue;
            const b = r.meta.backup;
            const balBefore = b.balanceBefore ?? Infinity;
            if (balBefore - (b.bet + deficitYuan) >= 0) {
              betIdx = j;
              betPlacement = 'before';
              break;
            }
          }
        }
        if (betIdx >= 0) {
          records[srcIdx].meta.backup.payout = parseFloat((records[srcIdx].meta.backup.payout + deficitYuan).toFixed(2));
          records[betIdx].meta.backup.bet = parseFloat((records[betIdx].meta.backup.bet + deficitYuan).toFixed(2));
          this.log(
            `  🔧 修复 withdraw 链(iter ${iter + 1}, bet-${betPlacement}): ID ${
              records[srcIdx].id
            } payout +${deficitYuan.toFixed(2)}, ID ${records[betIdx].id} bet +${deficitYuan.toFixed(2)}`
          );
          applied = true;
        }
      }

      // 🎯 Strategy 0: reduce overflow-to-cWit bet + reduce DEPOSIT-direction payout
      // 适用于"区间内没有 WITHDRAW 方向 GAME_WIN 记录"的场景（Strategy 1 失效）。
      //
      // 原理：某条 bet 因 sDep 不够，超额部分扣了 cWit → 减掉这条 bet 的超额部分
      // 让它完全由 sDep 吸收（cWit 保住 X）；同时减一条 DEPOSIT 方向的 payout X
      // （cDep 少加 X）→ sum(bet) 和 sum(payout) 同减 X，net gain 不变。
      // 净效果：cWit +X, cDep -X, total balance 不变。
      //
      // Strategy 2/3 的"减 bet + 加 bet"是 net-zero 位移，对 cWit 总扣量**无效**，
      // 所以必须有 Strategy 0 处理 cWit 赤字。
      if (!applied && !stagnated) {
        const first = records[0];
        let sDep = (first.currentDeposit || 0) - (first.depositAmount || 0);
        const overflowBets = []; // {idx, overflowYuan, currentBet}

        for (let i = 0; i < cutIdx; i++) {
          const r = records[i];
          if (!r.gameId) {
            const origDep = r.depositAmount || 0;
            if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
              const deduct = Math.abs(origDep);
              if (deduct > sDep) {
                sDep = 0;
              } else {
                sDep += origDep;
              }
            } else {
              sDep += origDep;
            }
            continue;
          }
          const b = r.meta?.backup;
          if (!b) {
            sDep += r.depositAmount || 0;
            continue;
          }
          if (b.bet > 0) {
            const betAmt = toCash(b.bet);
            if (betAmt > sDep) {
              const overflowYuan = parseFloat(((betAmt - sDep) / 1000).toFixed(2));
              if (overflowYuan > 0.001) {
                overflowBets.push({ idx: i, overflowYuan, currentBet: b.bet });
              }
              sDep = 0;
            } else {
              sDep -= betAmt;
            }
          } else if (b.payout > 0) {
            if (findPayoutDir(i) === 'WITHDRAW') {
              /* cWit, skip */
            } else sDep += toCash(b.payout);
          }
        }

        // 找一条 DEPOSIT 方向的 payout 作为等量减源
        const findDepositPayout = (maxYuan) => {
          for (let j = 0; j < records.length; j++) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.payout > 0 && findPayoutDir(j) === 'DEPOSIT') {
              if (r.meta.backup.payout >= maxYuan - 0.001) {
                return { idx: j, take: maxYuan };
              }
            }
          }
          // 凑和方案：累加多条 DEPOSIT payout
          const candidates = [];
          for (let j = 0; j < records.length; j++) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.payout > 0 && findPayoutDir(j) === 'DEPOSIT') {
              candidates.push({ idx: j, payout: r.meta.backup.payout });
            }
          }
          candidates.sort((a, b) => b.payout - a.payout);
          return candidates;
        };

        // 总体预算 = min(overflow 总量, deficitYuan)
        overflowBets.sort((a, b) => b.overflowYuan - a.overflowYuan);
        let remainingBudget = deficitYuan;
        const applied0Logs = [];

        for (const ob of overflowBets) {
          if (remainingBudget < 0.01) break;
          const takeFromBet = Math.min(ob.overflowYuan, remainingBudget);
          if (takeFromBet < 0.01) continue;

          // 找等量 DEPOSIT payout 可减
          const depPayouts = [];
          for (let j = 0; j < records.length; j++) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.payout > 0.01 && findPayoutDir(j) === 'DEPOSIT') {
              depPayouts.push({ idx: j, payout: r.meta.backup.payout });
            }
          }
          depPayouts.sort((a, b) => b.payout - a.payout);

          let reducibleFromPayouts = 0;
          for (const dp of depPayouts) {
            reducibleFromPayouts += dp.payout;
            if (reducibleFromPayouts >= takeFromBet) break;
          }
          const actualTake = Math.min(takeFromBet, parseFloat(reducibleFromPayouts.toFixed(2)));
          if (actualTake < 0.01) continue;

          // 减 bet
          const betRec = records[ob.idx].meta.backup;
          const newBet = parseFloat((betRec.bet - actualTake).toFixed(2));
          const actualBetReduced = parseFloat((betRec.bet - newBet).toFixed(2));
          betRec.bet = newBet;

          // 按等量从 DEPOSIT payout 中减
          let remainingToReduceFromPayout = actualBetReduced;
          const payoutChanges = [];
          for (const dp of depPayouts) {
            if (remainingToReduceFromPayout < 0.001) break;
            const pRec = records[dp.idx].meta.backup;
            const take = Math.min(pRec.payout, remainingToReduceFromPayout);
            const newPayout = parseFloat((pRec.payout - take).toFixed(2));
            const actualPayoutReduced = parseFloat((pRec.payout - newPayout).toFixed(2));
            pRec.payout = newPayout;
            remainingToReduceFromPayout = parseFloat((remainingToReduceFromPayout - actualPayoutReduced).toFixed(2));
            payoutChanges.push(`ID${records[dp.idx].id}(-${actualPayoutReduced.toFixed(2)})`);
          }

          applied0Logs.push(
            `bet-ID${records[ob.idx].id}(-${actualBetReduced.toFixed(2)}) | payouts: ${payoutChanges.join(', ')}`
          );
          remainingBudget = parseFloat((remainingBudget - actualBetReduced).toFixed(2));
          applied = true;
        }

        if (applied) {
          this.log(`  🔧 修复 withdraw 链(iter ${iter + 1}, Strategy 0): ${applied0Logs.join(' ; ')}`);
        }
      }

      // 🎯 Strategy 0b: 减 cWit 区段 bet + 加 cDep 充裕区段 bet（DEBT 之前或 sDep 充裕位置）
      //
      // 适用于：Strategy 1 无源、Strategy 0 的 DEPOSIT payout 耗尽，但 cWit 仍赤字。
      // 原理：ID X（sDep=0 区段）的 bet 原本扣 cWit → 减它 X 让 cWit 多 X；
      //       ID Y（sDep 充裕区段，如 DEBT 之前）加 bet X → 扣 cDep（不碰 cWit）。
      // net: sum(bet) 不变, sum(payout) 不变, net gain 不变. cWit +X, cDep -X.
      //
      // 限制：Y 点必须在 DEBT 之前（cDep 高）或 GAME_WIN payout 注入之后；
      //       且 Y 点的 sDep 必须 >= bet_Y_new 以保证 bet 全由 cDep 吸收。
      if (!applied && !stagnated) {
        // 重新模拟 sDep 轨迹，标记每个 game bet 的"扣款去向"
        const first = records[0];
        let sDep = (first.currentDeposit || 0) - (first.depositAmount || 0);
        const sDepAtBet = []; // 每条 game bet 记录的 (idx, sDepBefore, bet)

        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (!r.gameId) {
            const origDep = r.depositAmount || 0;
            if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
              const deduct = Math.abs(origDep);
              sDep = deduct > sDep ? 0 : sDep + origDep;
            } else {
              sDep += origDep;
            }
            continue;
          }
          const b = r.meta?.backup;
          if (!b) {
            sDep += r.depositAmount || 0;
            continue;
          }
          if (b.bet > 0) {
            sDepAtBet.push({ idx: i, sDepBefore: sDep, bet: b.bet });
            const betAmt = toCash(b.bet);
            sDep = betAmt <= sDep ? sDep - betAmt : 0;
          } else if (b.payout > 0) {
            if (findPayoutDir(i) === 'WITHDRAW') {
              /* cWit, skip */
            } else sDep += toCash(b.payout);
          }
        }

        // 找 negIdx 之前 sDep 不足以容纳 bet 的位置（扣 cWit 的 bet）
        const witBets = sDepAtBet.filter((x) => x.idx < negIdx && toCash(x.bet) > x.sDepBefore);
        // 找任意位置 sDep 充裕（sDepBefore >= bet + buffer）的 bet 作为"转移目标"
        const depBets = sDepAtBet
          .filter((x) => x.sDepBefore >= toCash(x.bet) + 1000) // 至少 1 元 buffer
          .sort((a, b) => b.sDepBefore - a.sDepBefore); // 优先最富裕的

        if (witBets.length > 0 && depBets.length > 0) {
          let remaining = deficitYuan;
          const logs0b = [];
          // 按扣 cWit 量排序（优先处理扣得最多的）
          witBets.sort((a, b) => {
            const aOver = toCash(a.bet) - a.sDepBefore;
            const bOver = toCash(b.bet) - b.sDepBefore;
            return bOver - aOver;
          });

          for (const wb of witBets) {
            if (remaining < 0.01) break;
            const overflow = parseFloat(((toCash(wb.bet) - wb.sDepBefore) / 1000).toFixed(2));
            const take = Math.min(overflow, remaining);
            if (take < 0.01) continue;

            // 找一个 depBet 有足够空间吸纳 +take 的 bet 增量
            let chosenDep = null;
            for (const db of depBets) {
              if (db.idx === wb.idx) continue;
              const pRec = records[db.idx].meta.backup;
              const room = (db.sDepBefore - toCash(pRec.bet)) / 1000; // 剩余 sDep 空间
              if (room >= take) {
                chosenDep = db;
                break;
              }
            }
            if (!chosenDep) continue;

            // 执行：wb.bet -take, chosenDep.bet +take
            const wbRec = records[wb.idx].meta.backup;
            const oldWbBet = wbRec.bet;
            const newWbBet = parseFloat((oldWbBet - take).toFixed(2));
            const actualReduced = parseFloat((oldWbBet - newWbBet).toFixed(2));
            wbRec.bet = newWbBet;

            const dbRec = records[chosenDep.idx].meta.backup;
            dbRec.bet = parseFloat((dbRec.bet + actualReduced).toFixed(2));

            logs0b.push(
              `-ID${records[wb.idx].id}(${actualReduced.toFixed(2)}) +ID${records[chosenDep.idx].id}(${actualReduced.toFixed(
                2
              )})`
            );
            remaining = parseFloat((remaining - actualReduced).toFixed(2));
            applied = true;
          }

          if (applied) {
            this.log(`  🔧 修复 withdraw 链(iter ${iter + 1}, Strategy 0b): ${logs0b.join(' ; ')}`);
          }
        }
      }

      // Strategy 2: redistribute bets - reduce overflowing bets before rootIdx,
      // increase a bet after negIdx by the same total (net gain unchanged)
      if (!applied && !stagnated) {
        const first = records[0];
        let sDep = (first.currentDeposit || 0) - (first.depositAmount || 0);

        let totalSaved = 0;
        for (let i = 0; i < cutIdx; i++) {
          const r = records[i];
          if (!r.gameId) {
            const origDep = r.depositAmount || 0;
            if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
              const deduct = Math.abs(origDep);
              sDep = deduct > sDep ? 0 : sDep + origDep;
            } else {
              sDep += origDep;
            }
            continue;
          }
          const b = r.meta?.backup;
          if (!b) {
            sDep += r.depositAmount || 0;
            continue;
          }

          if (b.bet > 0) {
            const betAmt = toCash(b.bet);
            if (betAmt > sDep) {
              const overflowYuan = (betAmt - sDep) / 1000;
              const reducible = Math.min(overflowYuan, b.bet);
              if (reducible > 0.001) {
                // 🎯 严格浮点：以 round 后的实际变化量累加，防止 sum(bet) 漂移
                const oldBet = b.bet;
                const newBet = parseFloat((oldBet - reducible).toFixed(2));
                const actualReduced = parseFloat((oldBet - newBet).toFixed(2));
                b.bet = newBet;
                totalSaved = parseFloat((totalSaved + actualReduced).toFixed(2));
              }
            }
            const newBetAmt = toCash(b.bet);
            sDep = newBetAmt <= sDep ? sDep - newBetAmt : 0;
          } else if (b.payout > 0) {
            if (findPayoutDir(i) === 'WITHDRAW') {
              /* simWit, skip */
            } else sDep += toCash(b.payout);
          }
        }

        if (totalSaved > 0.001) {
          let betIdx = -1;
          for (let j = negIdx + 1; j < records.length; j++) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.bet > 0) {
              betIdx = j;
              break;
            }
          }
          if (betIdx >= 0) {
            records[betIdx].meta.backup.bet = parseFloat((records[betIdx].meta.backup.bet + totalSaved).toFixed(2));
            this.log(
              `  🔧 修复 withdraw 链(iter ${iter + 1}, bet重分配): 前移bet -${totalSaved.toFixed(2)}, ID ${
                records[betIdx].id
              } bet +${totalSaved.toFixed(2)}`
            );
            applied = true;
          }
        }
      }

      // Strategy 3: reduce largest bets before rootIdx to increase simDep for DEBT events
      if (!applied && !stagnated) {
        const reduceBudget = deficitYuan + 1;
        let betIdx = -1;
        for (let j = negIdx + 1; j < records.length; j++) {
          const r = records[j];
          if (r.gameId && r.meta?.backup && r.meta.backup.bet > 0) {
            betIdx = j;
            break;
          }
        }
        // 若 negIdx 之后无 bet 可加，S3 无能为力，留给 Strategy 4 处理（不再整体 break）。
        if (betIdx >= 0) {
          const preBets = [];
          for (let j = 0; j < cutIdx; j++) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.bet > 1) {
              preBets.push({ idx: j, bet: r.meta.backup.bet });
            }
          }
          preBets.sort((a, b) => b.bet - a.bet);

          let totalReduced = 0;
          for (const item of preBets) {
            if (totalReduced >= reduceBudget) break;
            const reduce = Math.min(item.bet - 0.01, reduceBudget - totalReduced);
            if (reduce > 0.001) {
              // 🎯 严格浮点：以 round 后的实际变化量累加
              const newBet = parseFloat((item.bet - reduce).toFixed(2));
              const actualReduced = parseFloat((item.bet - newBet).toFixed(2));
              records[item.idx].meta.backup.bet = newBet;
              totalReduced = parseFloat((totalReduced + actualReduced).toFixed(2));
            }
          }

          if (totalReduced > 0.001) {
            records[betIdx].meta.backup.bet = parseFloat((records[betIdx].meta.backup.bet + totalReduced).toFixed(2));
            this.log(
              `  🔧 修复 withdraw 链(iter ${iter + 1}, bet压缩): 减少前段bet ${totalReduced.toFixed(2)}, ID ${
                records[betIdx].id
              } bet +${totalReduced.toFixed(2)}`
            );
            applied = true;
          }
        }
      }

      // 🎯 Strategy 4 (Last Resort): 当 S1-S3 都无法推进（stagnated）或没有应用时，强制压缩。
      //   两类场景 —— 本次融合处理：
      //   A) bet 自身 overflow（betAmt > sDep_local） → 削减该 bet 到 = sDep_local
      //   B) CIRC_DEBT overflow（|dep| > sDep_local） → 回头削减 DEBT 之前的 game bets 补足 shortfall
      //   两类累计进入 totalShaved，加回到 cutIdx 之后的末尾 game bet（net-zero：sum(bet) 不变）。
      //   若末尾无 bet 可加，则改为同步减 DEPOSIT 方向 payout 等量。
      if (!applied) {
        const first = records[0];
        let sDepLocal = (first.currentDeposit || 0) - (first.depositAmount || 0);
        let totalShaved = 0;
        const shavedList = [];

        // 记录"DEBT 前的 game bet 候选"（idx → betCash），用于 DEBT 溢出时回头削减
        const preDebtBets = []; // [{ idx, r, betYuan, betCash }]

        for (let i = 0; i <= cutIdx; i++) {
          const r = records[i];
          if (!r.gameId) {
            const origDep = r.depositAmount || 0;
            if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
              const deduct = Math.abs(origDep);
              if (deduct > sDepLocal) {
                // 场景 B：DEBT overflow → 回头削减 preDebtBets 补足 shortfall
                let shortfall = deduct - sDepLocal;
                // 从大到小削减（优先削减大 bet 获得最大 sDep 释放）
                const sortedBets = [...preDebtBets].sort((a, b) => b.betCash - a.betCash);
                for (const cand of sortedBets) {
                  if (shortfall <= 0) break;
                  const b = cand.r.meta.backup;
                  if (!b || !(b.bet > 0)) continue;
                  const curBetCash = toCash(b.bet);
                  if (curBetCash <= 0) continue;
                  const shaveCash = Math.min(curBetCash, shortfall);
                  const shaveYuan = parseFloat((shaveCash / 1000).toFixed(2));
                  const newBet = parseFloat((b.bet - shaveYuan).toFixed(2));
                  const actualShaved = parseFloat((b.bet - newBet).toFixed(2));
                  if (actualShaved > 0.001) {
                    b.bet = newBet;
                    totalShaved = parseFloat((totalShaved + actualShaved).toFixed(2));
                    shavedList.push(`ID${cand.r.id}(-${actualShaved.toFixed(2)} for DEBT@ID${r.id})`);
                    shortfall -= toCash(actualShaved);
                    sDepLocal += toCash(actualShaved);
                  }
                }
              }
              // DEBT 后重新计算 sDepLocal（此时可能已通过削减 bet 上涨）
              sDepLocal = Math.max(0, sDepLocal - deduct);
            } else {
              sDepLocal += origDep;
            }
            continue;
          }
          const b = r.meta?.backup;
          if (!b) {
            sDepLocal += r.depositAmount || 0;
            continue;
          }
          if (b.bet > 0) {
            const betAmt = toCash(b.bet);
            if (betAmt > sDepLocal) {
              // 场景 A：bet 自身 overflow
              const shaveYuan = parseFloat(((betAmt - sDepLocal) / 1000).toFixed(2));
              const newBet = parseFloat((b.bet - shaveYuan).toFixed(2));
              const actualShaved = parseFloat((b.bet - newBet).toFixed(2));
              if (actualShaved > 0.001) {
                b.bet = newBet;
                totalShaved = parseFloat((totalShaved + actualShaved).toFixed(2));
                shavedList.push(`ID${r.id}(-${actualShaved.toFixed(2)})`);
              }
              sDepLocal = 0;
            } else {
              sDepLocal -= betAmt;
            }
            // 记录为"未来 DEBT 的可削减来源"（只要 bet 还 >0）
            if (b.bet > 0) preDebtBets.push({ idx: i, r, betYuan: b.bet, betCash: toCash(b.bet) });
          } else if (b.payout > 0) {
            if (findPayoutDir(i) === 'DEPOSIT') sDepLocal += toCash(b.payout);
            // WITHDRAW 不影响 sDep
          }
        }

        // 加回：优先加到 cutIdx 之后的最后一条 game bet，保持 net-zero
        if (totalShaved > 0.001) {
          let addIdx = -1;
          for (let j = records.length - 1; j > cutIdx; j--) {
            const r = records[j];
            if (r.gameId && r.meta?.backup && r.meta.backup.bet > 0) {
              addIdx = j;
              break;
            }
          }
          if (addIdx >= 0) {
            records[addIdx].meta.backup.bet = parseFloat((records[addIdx].meta.backup.bet + totalShaved).toFixed(2));
            this.log(
              `  🔧 修复 withdraw 链(iter ${iter + 1}, Strategy 4 Last Resort): 强制压缩 ${shavedList
                .slice(0, 5)
                .join(', ')}${shavedList.length > 5 ? ` 等${shavedList.length}条` : ''} 累计 -${totalShaved.toFixed(
                2
              )}, ID ${records[addIdx].id} bet +${totalShaved.toFixed(2)}`
            );
            applied = true;
          } else {
            // 无后置 bet 可加，改为同步减 DEPOSIT payout（sum(bet) 与 sum(payout) 同减，net gain 不变）
            let remaining = totalShaved;
            const payoutCuts = [];
            for (let j = 0; j < records.length && remaining > 0.001; j++) {
              const r = records[j];
              if (r.gameId && r.meta?.backup && r.meta.backup.payout > 0.01 && findPayoutDir(j) === 'DEPOSIT') {
                const take = Math.min(r.meta.backup.payout, remaining);
                const newP = parseFloat((r.meta.backup.payout - take).toFixed(2));
                const actualTake = parseFloat((r.meta.backup.payout - newP).toFixed(2));
                r.meta.backup.payout = newP;
                remaining = parseFloat((remaining - actualTake).toFixed(2));
                payoutCuts.push(`ID${r.id}(-${actualTake.toFixed(2)})`);
              }
            }
            if (remaining < 0.01) {
              this.log(
                `  🔧 修复 withdraw 链(iter ${iter + 1}, Strategy 4 Last Resort): 强制压缩 ${shavedList
                  .slice(0, 5)
                  .join(', ')} 累计 -${totalShaved.toFixed(2)}, 减 DEPOSIT payout ${payoutCuts.slice(0, 5).join(', ')}`
              );
              applied = true;
            } else {
              // 回滚：没有后置 bet 也没有足够 DEPOSIT payout，这种极端场景放弃本轮
              // （totalShaved 已经应用到 b.bet 上，回滚需要还原，但这里简化为记日志告警）
              this.log(
                `  ⚠️ 修复 withdraw 链(iter ${iter + 1}, Strategy 4): 无处承接 ${totalShaved.toFixed(2)} 的压缩量，已放弃`
              );
            }
          }
        }
      }

      // 🎯 Strategy 5 (DEBT-feed): 当 S4 无法削减 DEBT 前 bet（preDebtBets 为空或不足）时，
      // 反向增加 DEBT 前的 DEPOSIT-dir payout 给 DEBT 提供吸收源，并在 DEBT 后加等量 bet 补偿。
      // 净效果：sum(payout) + X = sum(bet) + X，netGain 守恒。
      // 适用场景：DEBT overflow 但 DEBT 之前几乎无 bet 可削（常见于 segment 分配把 payout 集中后段）。
      if (!applied) {
        const first = records[0];
        let sDep5 = (first.currentDeposit || 0) - (first.depositAmount || 0);
        let s5Applied = false;

        for (let i = 0; i < records.length && !s5Applied; i++) {
          const r = records[i];
          if (!r.gameId) {
            const origDep = r.depositAmount || 0;
            if ((r.circulation ?? 0) === CIRC_DEBT && origDep < 0) {
              const deduct = Math.abs(origDep);
              if (deduct > sDep5) {
                // DEBT overflow！shortfall = deduct - sDep5
                const shortfallCash = deduct - sDep5;
                const shortfallYuan = parseFloat((shortfallCash / 1000).toFixed(2));
                // 找 [0, i) 之间 DEPOSIT-dir 且 meta.backup.payout>0 的 game_win 记录（按容量最大的优先）
                let remainingAdd = shortfallYuan;
                const payoutAdds = [];
                for (let j = 0; j < i && remainingAdd > 0.001; j++) {
                  const rj = records[j];
                  if (!rj.gameId) continue;
                  const bj = rj.meta?.backup;
                  if (!bj) continue;
                  // 只选 bet=0 的纯 payout 记录，避免破坏下注语义
                  if (bj.bet > 0 || !(bj.payout > 0)) continue;
                  if (findPayoutDir(j) !== 'DEPOSIT') continue;
                  // 增加 payout
                  const add = remainingAdd;
                  bj.payout = parseFloat((bj.payout + add).toFixed(2));
                  payoutAdds.push(`ID${rj.id}(+${add.toFixed(2)})`);
                  remainingAdd = 0;
                }
                if (remainingAdd < 0.01 && payoutAdds.length > 0) {
                  // 配对：在 [i, end) 找第一个 game bet 补偿等量
                  let betIdx = -1;
                  for (let k = i + 1; k < records.length; k++) {
                    const rk = records[k];
                    if (rk.gameId && rk.meta?.backup && rk.meta.backup.bet > 0) {
                      betIdx = k;
                      break;
                    }
                  }
                  if (betIdx >= 0) {
                    records[betIdx].meta.backup.bet = parseFloat(
                      (records[betIdx].meta.backup.bet + shortfallYuan).toFixed(2)
                    );
                    this.log(
                      `  🔧 修复 withdraw 链(iter ${iter + 1}, Strategy 5 DEBT-feed): DEBT@ID${
                        r.id
                      } 溢出 ${shortfallYuan.toFixed(2)} → 前置 payout ${payoutAdds.join(', ')}, ID ${
                        records[betIdx].id
                      } bet +${shortfallYuan.toFixed(2)}`
                    );
                    s5Applied = true;
                    applied = true;
                  } else {
                    // 回滚 payout 增加（没处配对 bet）
                    for (const entry of payoutAdds) {
                      const m = entry.match(/ID(\d+)\(\+(.+)\)/);
                      if (m) {
                        const idNum = parseInt(m[1], 10);
                        const backVal = parseFloat(m[2]);
                        const back = records.find((x) => x.id === idNum);
                        if (back && back.meta?.backup) {
                          back.meta.backup.payout = parseFloat((back.meta.backup.payout - backVal).toFixed(2));
                        }
                      }
                    }
                  }
                }
              }
              sDep5 = Math.max(0, sDep5 - deduct);
              continue;
            }
            sDep5 += origDep;
            continue;
          }
          const b = r.meta?.backup;
          if (!b) {
            sDep5 += r.depositAmount || 0;
            continue;
          }
          if (b.bet > 0) {
            const betAmt = toCash(b.bet);
            sDep5 = Math.max(0, sDep5 - betAmt);
          } else if (b.payout > 0) {
            if (findPayoutDir(i) === 'DEPOSIT') sDep5 += toCash(b.payout);
          }
        }
      }

      if (!applied) break;

      // Rebuild balance chain of game records (skips non-game events, which are
      // handled by flowCash.writeBackFlowData from the raw record fields).
      const firstGameIdx = records.findIndex((r) => r.meta?.backup);
      if (firstGameIdx < 0) {
        repaired = true;
        break;
      }
      let bal = records[firstGameIdx].meta.backup.balanceBefore;
      for (let k = firstGameIdx; k < records.length; k++) {
        const b = records[k].meta?.backup;
        if (!b) continue;
        b.balanceBefore = bal;
        b.balanceAfter = bal - (b.bet || 0) + (b.payout || 0);
        bal = b.balanceAfter;
      }

      repaired = true;
    }

    // 🎯 净收益守恒校正：修复应是 net-zero 操作（+payout & +bet 等量 / 或 bet 重分配），
    // 但多轮 toFixed round 累加可能让 sum(payout - bet) 漂 0.01~0.1 元级别。
    // 出口若漂移，在一条 game 记录的 bet 上 snap 回来。
    if (repaired) {
      const finalNetGain = parseFloat(
        records
          .reduce((sum, r) => {
            if (!r.meta?.backup) return sum;
            const b = r.meta.backup;
            return sum + (b.payout || 0) - (b.bet || 0);
          }, 0)
          .toFixed(2)
      );
      const drift = parseFloat((finalNetGain - initialNetGain).toFixed(2));
      if (Math.abs(drift) >= 0.01) {
        // drift > 0：net gain 多了，需要增加一条 bet 把它压回去
        // drift < 0：net gain 少了，需要减少一条 bet 把它抬回来
        // 选择末尾的 game bet 记录（最后一次 Strategy 补偿的那条），修改幅度最小且最安全
        let fixIdx = -1;
        for (let j = records.length - 1; j >= 0; j--) {
          const r = records[j];
          if (!r.gameId || !r.meta?.backup) continue;
          const b = r.meta.backup;
          if (!(b.bet > 0)) continue;
          // drift < 0 时要减 bet：保留 bet > |drift| + 0.01 的记录
          if (drift < 0 && b.bet + drift < 0.01) continue;
          fixIdx = j;
          break;
        }
        if (fixIdx >= 0) {
          const b = records[fixIdx].meta.backup;
          const newBet = parseFloat((b.bet + drift).toFixed(2));
          this.log(
            `  🔧 修复 withdraw 链(守恒校正): drift=${drift.toFixed(2)}, ID ${records[fixIdx].id} bet ${b.bet.toFixed(
              2
            )} → ${newBet.toFixed(2)}`
          );
          b.bet = newBet;
          // 重建链（同上）
          const firstGameIdx = records.findIndex((r) => r.meta?.backup);
          if (firstGameIdx >= 0) {
            let bal = records[firstGameIdx].meta.backup.balanceBefore;
            for (let k = firstGameIdx; k < records.length; k++) {
              const bb = records[k].meta?.backup;
              if (!bb) continue;
              bb.balanceBefore = bal;
              bb.balanceAfter = bal - (bb.bet || 0) + (bb.payout || 0);
              bal = bb.balanceAfter;
            }
          }
        }
      }
    }

    return repaired;
  }

  /**
   * 调整数据库数据（主流程方法）
   *
   * 完整流程：
   * 1. 转换：将原始数据库记录转换为游戏日志格式
   * 2. 截取：如果数据量大，随机截取一部分用于测试
   * 3. 验证：验证原始日志的余额链完整性
   * 4. 调整：使用算法调整游戏结果，分配extraAmount
   * 5. 应用：将调整后的数据应用到日志的meta字段，重建余额链
   * 6. 验证：验证调整后的meta余额链完整性
   * 7. 备份：将调整后的meta备份到原始数据库记录中
   *
   * @param {Array} dbData - 原始数据库记录数组
   * @param {Number} extraAmount - 需要额外分配的金额（默认500）
   * @returns {Object} 包含gameResult、adjustedResult、balanceResult等的完整结果
   */
  adjustDBData(dbData, extraAmount = 500) {
    // ==================== 准备阶段 ====================

    // 保存原始数据库数据的引用
    this.dbData = dbData;

    // 创建原始记录映射表（用于后续备份）
    const updatedRecords = new Map();

    // 复制记录数组（避免修改原始数据）
    const records = [...dbData];

    // this.log(`\n📥 输入数据: ${records.length}条原始记录`);

    this.log(`\n${'━'.repeat(80)}`);
    this.log(`📊 阶段1: 数据准备与分析`);
    this.log(`${'━'.repeat(80)}`);

    // 将原始财务记录转换为标准化的游戏日志格式
    const gameResult = this.convertToGameLogs(records);

    // 🧹 清理脏数据：移除可能存在的旧meta信息（防止对象复用导致的污染）
    if (gameResult.logs) {
      gameResult.logs.forEach((log) => {
        if (log.meta) delete log.meta;
      });
    }

    // ==================== 第2步：智能选择rounds ====================

    // 🎯 提取所有有效的游戏日志（避免重复提取）
    const {
      validLogs: allValidLogs,
      withdrawals: allWithdrawals,
      roundStatistics,
    } = this._extractValidLogs(gameResult.logs);

    // 统计round数量
    const totalRounds = roundStatistics.size;

    this.log(`\n📊 总有效数据: ${allValidLogs.length}条日志 / ${totalRounds}个轮次, 提现次数: ${allWithdrawals.length}`);

    // 🎯 智能截取合适数量的日志（固定样本策略：30条）
    this.selectLogs(gameResult, updatedRecords, allValidLogs, extraAmount);

    // ==================== 第3步：验证原始余额链 ====================

    // 验证转换后的日志余额链是否完整
    const verifyResult = this.verifyBalanceChain({
      logs: gameResult.logs,
      useMeta: false, // 验证原始数据
    });

    // if (!verifyResult.valid) {
    //   this.error('\n❌ 原始余额链验证失败:');
    //   verifyResult.errors.slice(0, 5).forEach((err) => this.error(`   ${err}`));
    //   this.error('\n💡 这通常是因为：');
    //   this.error('   1. 数据库中的余额字段(currentDeposit/currentWithdraw)不准确');
    //   this.error('   2. 部分记录在转换时被过滤掉了（但它们影响了余额）');
    //   this.error('   3. 数据库记录之间存在缺失或不连续\n');
    //   throw new Error('原始余额链验证失败');
    // }
    // this.log('✅ 原始余额链验证通过');

    // 🎯 优化：如果当前策略是微小输赢但轮次过多，导致分配困难，尝试裁剪轮次
    const currentLogs = gameResult.logs.filter((l) => l.game);
    const currentOriginalNetGain = currentLogs.reduce((sum, log) => sum + (log.payout - log.bet), 0);
    const currentTargetNetGain = currentOriginalNetGain + extraAmount;
    const currentRoundsCount = new Set(currentLogs.map((l) => l.round)).size;

    this.log(
      `\n📋 策略检查: 原始净收益=${currentOriginalNetGain.toFixed(2)}, 目标增加=${extraAmount.toFixed(
        2
      )}, 调整后净收益=${currentTargetNetGain.toFixed(2)}, 轮次=${currentRoundsCount}`
    );

    this.prepareUpdatedRecords(gameResult, updatedRecords);

    // ==================== 第4步：调整游戏结果 ====================

    // 🎯 重新提取validLogs（基于截取后的logs）
    const {
      validLogs: finalValidLogs,
      withdrawals: finalWithdrawals,
      deposits: finalDeposits,
    } = this._extractValidLogs(gameResult.logs);

    // 🎯 准备预提取的数据（避免在adjust中重复提取）
    const preExtractedData = {
      validLogs: finalValidLogs,
      withdrawals: finalWithdrawals,
      deposits: finalDeposits,
    };

    // balanceJump 补偿：writeBackFlowData 纯粹用 bet/payout 重建链，不含 balanceJump。
    // 如果原始数据存在 balanceJump（系统注入），算法需要额外补偿这部分，
    // 否则调整后 writeBackFlowData 的最终余额 = 原始余额而非 原始余额 + extraAmount。
    const totalBalanceJump = gameResult.logs.reduce((sum, log) => sum + (log.balanceJump || 0), 0);
    const effectiveExtraAmount = extraAmount + totalBalanceJump;
    if (Math.abs(totalBalanceJump) > 0.001) {
      this.log(
        `  ⚠️ 检测到 balanceJump 总计: ${totalBalanceJump.toFixed(
          2
        )}, 有效调整量: ${extraAmount} → ${effectiveExtraAmount.toFixed(2)}`
      );
    }

    // 使用算法调整游戏记录，分配 effectiveExtraAmount
    // adjustAndApply 会：
    // 1. 调整游戏记录的bet和payout
    // 2. 将调整后的数据写入log.meta
    // 3. 重建完整的meta余额链
    const { adjustedResult, balanceResult } = this.adjustAndApply(gameResult, effectiveExtraAmount, preExtractedData);

    // 如果余额重建失败（通常是因为调整本身失败），直接返回
    if (!balanceResult.success) {
      this.error(`❌ 调整失败: ${balanceResult.error || adjustedResult.meta.error}`);
      return {
        gameResult,
        adjustedResult,
        balanceResult,
        verifyAdjustResult: { valid: false, errors: ['调整失败，跳过后续验证'] },
        finalRecords: [],
        backupRecords: [],
      };
    }

    // this.log(`🎯 调整完成: 目标${extraAmount}, 实际${adjustedResult.meta.actualNetGain}`);

    // ==================== 第5步：验证调整后的余额链 ====================

    this.log(`\n${'━'.repeat(80)}`);
    this.log(`🔍 阶段4: 验证与应用`);
    this.log(`${'━'.repeat(80)}`);
    // 验证调整后的meta余额链是否完整
    const verifyAdjustResult = this.verifyBalanceChain({
      logs: gameResult.logs,
      useMeta: true, // 验证meta数据
    });

    if (!verifyAdjustResult.valid) {
      this.error('❌ 调整后余额链验证失败:', verifyAdjustResult.errors);
      // this.log(`调整后余额链验证失败3: ${JSON.stringify(adjustedResult.adjustedLogs)}`);
      throw new Error('调整后余额链验证失败');
    }
    this.log('✅ 调整后余额链验证通过');

    // ==================== 第6步：备份到原始记录 ====================

    // 将调整后的log.meta备份到原始数据库记录的meta.backup字段
    const finalRecords = this.backupLogs(gameResult.logs, updatedRecords);

    // 数据一致性检查
    if (finalRecords.length !== updatedRecords.size) {
      // this.error(`❌ 数据不一致: finalRecords=${finalRecords.length}, logs=${gameResult.logs.length}`);
      throw new Error('备份后的记录数量与原始映射数量不一致');
    }

    // ==================== 第6.5步：修复 deposit/withdraw 拆分问题 ====================
    // 🎯 传入完整 finalRecords（含非 game 的 deposit/withdraw/DEBT 事件），
    // 否则 simulate() 无法看到序列末尾的纯提现，漏报 currentWithdraw 赤字。
    if (!this.skipWithdrawRepair) {
      this._repairWithdrawChain(finalRecords);
    }

    const backupRecords = finalRecords.filter((item) => item.meta.backup);

    // ==================== 最终结果汇总 ====================
    this.log(`\n${'━'.repeat(80)}`);
    this.log(`📊 最终结果汇总`);
    this.log(`${'━'.repeat(80)}`);

    const originalFinalBalance = gameResult.logs[gameResult.logs.length - 1].balanceAfter;
    const adjustedFinalBalance = gameResult.logs[gameResult.logs.length - 1].meta.balanceAfter;
    const actualChange = adjustedFinalBalance - originalFinalBalance;

    this.log(`💰 余额变化:`);
    this.log(`   调整前余额: ${originalFinalBalance.toFixed(2)}`);
    this.log(`   调整后余额: ${adjustedFinalBalance.toFixed(2)}`);
    this.log(`   实际变化: ${actualChange >= 0 ? '+' : ''}${actualChange.toFixed(2)}`);
    this.log(
      `   目标变化: ${effectiveExtraAmount >= 0 ? '+' : ''}${effectiveExtraAmount.toFixed(2)}${
        totalBalanceJump ? ` (含balanceJump补偿 ${totalBalanceJump})` : ''
      }`
    );
    this.log(
      `   误差: ${Math.abs(actualChange - effectiveExtraAmount).toFixed(2)} ${
        Math.abs(actualChange - effectiveExtraAmount) < 0.01 ? '✅' : '⚠️'
      }`
    );

    this.log(`\n📈 性能统计:`);
    this.log(`   处理记录: ${backupRecords.length}条`);
    this.log(`   搜索节点: ${adjustedResult.meta.attempts}个`);
    this.log(`   调整轮次: ${adjustedResult.meta.roundsCount}个`);

    this.log(`\n${'='.repeat(80)}`);
    this.log(`✅ 调整完成!`);
    this.log(`${'='.repeat(80)}\n`);

    // ==================== 返回完整结果 ====================

    return {
      gameResult, // 转换后的游戏日志
      adjustedResult, // 调整结果（包含meta信息）
      balanceResult, // 余额重建结果
      verifyAdjustResult, // 验证结果
      finalRecords, // 包含备份的最终记录数组
      backupRecords,
    };
  }
}

class GameFlowStatsCalculator {
  constructor({ userId }) {
    this.userId = userId;
  }

  /**
   * 创建一个空的统计槽
   */
  _emptyStats() {
    return {
      betAmount: 0,
      betRollbackAmount: 0,
      betBackAmount: 0,
      winAmount: 0,
    };
  }

  /**
   * 根据 circulation 类型，将操作金额累加到对应字段
   * @param {object} stats - 统计槽
   * @param {number} circulation - 流通类型
   * @param {number} opAmount - 操作金额（绝对值整数）
   */
  _accumulate(stats, circulation, opAmount) {
    if (circulation === GameFlowStatsCalculator.CIRCULATION_BET) {
      stats.betAmount += opAmount;
    } else if (circulation === GameFlowStatsCalculator.CIRCULATION_ROLLBACK) {
      stats.betRollbackAmount += opAmount;
    } else if (circulation === GameFlowStatsCalculator.CIRCULATION_WIN) {
      stats.betBackAmount += opAmount;
      stats.winAmount += opAmount;
    }
  }

  /**
   * 计算操作金额：|depositAmount + withdrawAmount|
   */
  _opAmount(depositAmount, withdrawAmount) {
    return Math.abs((depositAmount || 0) + (withdrawAmount || 0));
  }

  /**
   * 初始化一个带 backupOrigin 和 diff 的完整统计桶
   */
  _emptyBucket() {
    return {
      ...this._emptyStats(),
      backupOrigin: this._emptyStats(),
      diff: this._emptyStats(),
    };
  }

  /**
   * 对单个桶计算 diff = 第一层 - backupOrigin
   */
  _calcBucketDiff(b) {
    b.diff = {
      betAmount: b.betAmount - b.backupOrigin.betAmount,
      betRollbackAmount: b.betRollbackAmount - b.backupOrigin.betRollbackAmount,
      betBackAmount: b.betBackAmount - b.backupOrigin.betBackAmount,
      winAmount: b.winAmount - b.backupOrigin.winAmount,
    };
  }

  /**
   * 聚合统计，同时返回三种分组：
   *   byDay  — { [day]: { [gameId]: stats } }
   *   byGame — { [gameId]: stats }
   *   total  — stats  （全部记录汇总）
   * @param {Array} records
   * @returns {{ byDay: object, byGame: object, total: object }}
   */
  calculate(records) {
    const byDay = {};
    const byGame = {};
    const total = this._emptyBucket();

    for (const record of records) {
      const { _day, gameId, depositAmount, withdrawAmount, circulation, meta } = record;

      // 1. 过滤：circulation 不在 GAME_CIRCULATIONS 中则跳过
      if (!GameFlowStatsCalculator.GAME_CIRCULATIONS.has(circulation)) {
        continue; // eslint-disable-line no-continue
      }

      // gameId 为 null 时跳过
      if (gameId == null) {
        continue; // eslint-disable-line no-continue
      }

      const gId = String(gameId);

      // --- byDay 桶初始化 ---
      if (!byDay[_day]) byDay[_day] = {};
      if (!byDay[_day][gId]) byDay[_day][gId] = this._emptyBucket();

      // --- byGame 桶初始化 ---
      if (!byGame[gId]) byGame[gId] = this._emptyBucket();

      const opAmount = this._opAmount(depositAmount, withdrawAmount);
      const origin = meta?.backupOrigin;
      const originOpAmount = origin ? this._opAmount(origin.depositAmount, origin.withdrawAmount) : 0;
      const originCirculation = origin?.circulation;

      // 2. 累加到 byDay
      this._accumulate(byDay[_day][gId], circulation, opAmount);
      if (origin) this._accumulate(byDay[_day][gId].backupOrigin, originCirculation, originOpAmount);

      // 3. 累加到 byGame
      this._accumulate(byGame[gId], circulation, opAmount);
      if (origin) this._accumulate(byGame[gId].backupOrigin, originCirculation, originOpAmount);

      // 4. 累加到 total
      this._accumulate(total, circulation, opAmount);
      if (origin) this._accumulate(total.backupOrigin, originCirculation, originOpAmount);
    }

    // 5. 统一计算 diff
    for (const day of Object.keys(byDay)) {
      for (const gId of Object.keys(byDay[day])) {
        this._calcBucketDiff(byDay[day][gId]);
      }
    }
    for (const gId of Object.keys(byGame)) {
      this._calcBucketDiff(byGame[gId]);
    }
    this._calcBucketDiff(total);

    return { byDay, byGame, total };
  }

  /**
   * 按 gameId 维度生成批量 UPDATE SQL，对应 tb_individ_gameplay_statis 表
   * 唯一键：(userId, gameId)，CASE WHEN 同时匹配两列
   *
   * @param {{ byDay, byGame, total }} computedResult - calculate() 的返回值
   * @returns {{ sql: string } | null}
   */
  buildGameSqlPlan(computedResult) {
    const { byGame } = computedResult;
    const userId = Number(this.userId);

    const entries = Object.keys(byGame).map((gId) => ({
      gameId: Number(gId),
      diff: byGame[gId].diff,
    }));

    if (entries.length === 0) return null;

    const updateFields = ['betAmount', 'betRollbackAmount', 'betBackAmount', 'winAmount'];

    const setClauses = updateFields.map((field) => {
      const whenLines = entries.map(
        ({ gameId, diff }) => `WHEN \`gameId\` = ${gameId} THEN \`${field}\` + ${Number(diff[field])}`
      );
      return `\`${field}\` = CASE\n${whenLines.map((l) => `      ${l}`).join('\n')}\n      ELSE \`${field}\`\n    END`;
    });

    const inList = entries.map(({ gameId }) => gameId).join(', ');

    const sql = `UPDATE \`tb_individ_gameplay_statis\`\nSET\n    ${setClauses.join(
      ',\n    '
    )}\nWHERE \`userId\` = ${userId} AND \`gameId\` IN (${inList})`;

    return { sql };
  }

  buildGameDaySqlPlan(computedResult) {
    const { byDay } = computedResult;
    const userId = Number(this.userId);

    const entries = [];
    for (const day of Object.keys(byDay)) {
      for (const gId of Object.keys(byDay[day])) {
        const { diff } = byDay[day][gId];
        entries.push({ day: Number(day), gameId: Number(gId), diff });
      }
    }

    if (entries.length === 0) return null;

    const updateFields = ['betAmount', 'betRollbackAmount', 'betBackAmount', 'winAmount'];

    const setClauses = updateFields.map((field) => {
      const whenLines = entries.map(
        ({ day, gameId, diff }) =>
          `WHEN \`day\` = ${day} AND \`gameId\` = ${gameId} THEN \`${field}\` + ${Number(diff[field])}`
      );
      return `\`${field}\` = CASE\n${whenLines.map((l) => `      ${l}`).join('\n')}\n      ELSE \`${field}\`\n    END`;
    });

    const tupleList = entries.map(({ day, gameId }) => `(${day}, ${gameId})`).join(', ');

    const sql = `UPDATE \`tb_individ_day_gameplay_statis\`\nSET\n    ${setClauses.join(
      ',\n    '
    )}\nWHERE \`userId\` = ${userId} AND (\`day\`, \`gameId\`) IN (${tupleList})`;

    return { sql };
  }

  /**
   * 按 userId 维度生成 UPDATE SQL，对应 tb_user_info_extend 表
   * 主键：userId，只更新 betAmount / betBackAmount / betRollbackAmount 三个字段
   * 数据来源：total.diff（全部记录汇总差值）
   */
  /**
   * 一键同步：计算 → 生成3个 SQL plan → Promise.all 并发执行
   *
   * @param {Array}  records - calculate() 所需的原始记录数组
   * @returns {Promise<{ computedResult, results }>}
   *   computedResult - calculate() 的完整结果
   *   results        - 三条 SQL 的执行结果数组（null plan 跳过）
   */
  async sync(records) {
    let computedResult;
    try {
      computedResult = this.calculate(records);

      const plans = [
        this.buildGameSqlPlan(computedResult),
        this.buildGameDaySqlPlan(computedResult),
        this.buildSqlPlan(computedResult),
      ];

      const results = await Promise.all(
        plans.map((plan) => (plan ? prisma.$executeRawUnsafe(plan.sql) : Promise.resolve(null)))
      );
      remoteLogV(`GameFlowStatsCalculator.sync successful: userId:${this.userId}`);
      return { computedResult, results };
    } catch (error) {
      remoteLogV(`GameFlowStatsCalculator.sync error: userId:${this.userId} ${error.message}`);
      return { computedResult, results: [null, null, null] };
    }
  }

  buildSqlPlan(computedResult) {
    const { total } = computedResult;
    const { diff } = total;
    const userId = Number(this.userId);

    const sql =
      `UPDATE \`tb_user_info_extend\`\n` +
      `SET\n` +
      `    \`betAmount\` = \`betAmount\` + ${Number(diff.betAmount)},\n` +
      `    \`betBackAmount\` = \`betBackAmount\` + ${Number(diff.betBackAmount)},\n` +
      `    \`betRollbackAmount\` = \`betRollbackAmount\` + ${Number(diff.betRollbackAmount)}\n` +
      `WHERE \`userId\` = ${userId}`;

    return { sql };
  }
}
GameFlowStatsCalculator.CIRCULATION_BET = 48000;
GameFlowStatsCalculator.CIRCULATION_ROLLBACK = 48001;
GameFlowStatsCalculator.CIRCULATION_WIN = 10004;
GameFlowStatsCalculator.GAME_CIRCULATIONS = new Set([48000, 48001, 10004]);

class RiskFlowManager {
  // ========================================
  // 类内工具函数（静态方法）
  // ========================================
  /* 金额转换（元 → 分，保留 3 位精度） */
  static toCash(amount) {
    return Math.round(amount * 1000);
  }

  /* 调试写文件（生产环境跳过） */
  static writeFile(fileName, data) {
    if (typeof config !== 'undefined' && config && config.env === 'production') {
      return;
    }
    try {
      // eslint-disable-next-line global-require
      const fs = require('fs');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(fileName, JSON.stringify(data));
    } catch (e) {
      // 忽略写文件异常，仅用于调试
    }
  }

  /* 耗时统计：start/end 传入 key，getStats 获取各 key 耗时（ms） */
  static createTimeStat() {
    const startTimes = {};
    const stats = {};

    return {
      start(key) {
        startTimes[key] = Date.now();
      },
      end(key) {
        const startTime = startTimes[key];
        if (startTime === undefined) {
          stats[key] = 0;
          return 0;
        }
        const duration = Date.now() - startTime;
        stats[key] = duration;
        delete startTimes[key];
        return duration;
      },
      getStats() {
        return { ...stats };
      },
    };
  }

  // 可以在这里初始化一些配置
  constructor(options) {
    const { userId, querySize, updateBatchSize, queryRecentDays, GameResultAdjuster, GameFlowStatsCalculator } =
      options || {};
    this.userId = userId;
    this.querySize = querySize || 140;
    this.updateBatchSize = updateBatchSize || 140;
    this.queryRecentDays = queryRecentDays || 3;

    // 注入外部依赖类（调用方必传，保持类内不直接耦合外部作用域）
    this.GameResultAdjuster = GameResultAdjuster;
    this.GameFlowStatsCalculator = GameFlowStatsCalculator;

    this.backupFields = ['depositAmount', 'currentDeposit', 'withdrawAmount', 'currentWithdraw', 'circulation', 'type'];

    // 更新原始数据时需要更新的字段
    this.updateOriginFields = [
      'meta',
      'depositAmount',
      'currentDeposit',
      'withdrawAmount',
      'currentWithdraw',
      'circulation',
      'type',
    ];

    // 更新gameRound的字段
    this.updateGameRoundFields = ['meta', 'betAmount', 'winAmount', 'betRollbackAmount'];
  }

  /* 
      打印日志
      @param {string} message - 日志消息
      @param {string} level - 日志级别
    */
  log(message, level = 'debug') {
    if (CONSTANTS.PRINT_DEBUG_LOG && ['debug', 'info', 'warn', 'error'].includes(level)) {
      if (level === 'debug') {
        console.log(message);
      }
      if (level === 'info') {
        console.info(message);
      }
      if (level === 'warn') {
        console.warn(message);
      }
      if (level === 'error') {
        console.error(message);
      }
    }
  }

  /* 格式化现金流水记录 */
  formatCashFlowRecord(record) {
    const result = { ...record };

    /* 
      将字符串类型的数字转换为数字类型
      */
    const convertNumberKeys = [
      'id',
      'depositAmount',
      'currentDeposit',
      'withdrawAmount',
      'currentWithdraw',
      'linkId',
      'createTime',
    ];

    convertNumberKeys.forEach((key) => {
      result[key] = Number(record[key]);
      if (Number.isNaN(result[key])) {
        result[key] = record[key];
      }
    });

    result.meta = record.meta ?? {};

    result.uniqueKey = `${record._day}-${record.id}`;

    result.orgId = record.id; // 原始id

    // 判断是否有原始的backupOrigin数据
    if (result.meta.backupOrigin) {
      Object.assign(result, this.restoreBackupOriginData(result.meta.backupOrigin));
    }

    return result;
  }

  /* 
      判断是否是游戏轮次记录
      @param {Object} record - 记录对象
      @returns {boolean} 是否是游戏轮次记录
    */
  isGameRecord(record) {
    const { gameId } = record;
    return !!gameId;
  }

  /* 
      构建原始数据备份
      @param {Object} record - 记录对象
      @returns {Object} 原始数据备份
    */
  buildBackupOriginData(record) {
    const result = {};
    const backupKeys = this.backupFields;
    for (const key of backupKeys) {
      result[key] = record[key];
    }
    return result;
  }

  // 还原origin
  restoreBackupOriginData(originData) {
    const result = {};
    const backupKeys = this.backupFields;
    for (const key of backupKeys) {
      result[key] = originData[key];
    }
    return result;
  }

  /* 
      获取操作的唯一标识
      @param {Array} records - 记录数组
      @returns {Object} 操作的唯一标识
    */
  getOperateUniqueKey(records) {
    const startUniqueKey = records[0].uniqueKey;
    const endUniqueKey = records[records.length - 1].uniqueKey;
    return { startUniqueKey, endUniqueKey };
  }

  /* 
      获取用户现金流水
      @param {number} day - 查询天数
      @returns {Promise<Array>} 现金流水数组
    */
  async getCashFlow(day) {
    const recentDays = day || this.queryRecentDays;
    const dayTableArr = new Array(recentDays).fill(0).map((item, i) => {
      const time = createMoment().subtract(i, 'd').valueOf();
      return {
        day: createMoment(time).format('YYYYMMDD'),
        tableName: getDayTable('tb_user_account_cash', time),
      };
    });

    const allRecords = [];
    // 剩余需要查询的条数
    let remainingCount = this.querySize - allRecords.length;
    for (const item of dayTableArr) {
      const sql = `
            SELECT 
              id, 
              '${item.day}' as _day, 
              userId, 
              depositAmount, 
              currentDeposit, 
              withdrawAmount, 
              currentWithdraw, 
              circulation, 
              gameId, 
              meta, 
              createTime
            FROM ${item.tableName}
            WHERE userId = ${this.userId}
            ORDER BY createTime desc 
            limit ${remainingCount}
          `;
      // eslint-disable-next-line no-await-in-loop
      const records = await prisma.$queryRawUnsafe(sql);
      allRecords.push(...records);

      // 当前剩余需要查询的条数
      const curRemainingCount = remainingCount;

      // 更新剩余需要查询的条数
      remainingCount = this.querySize - allRecords.length;

      this.log(
        `[CashFlow] ${item.day} 预计查询条目:${curRemainingCount} 语句总条目:${this.querySize} 本次查询日期:${item.day} 查询到的条目数量:${records.length} 剩余条目:${remainingCount}`
      );

      // 如果剩余需要查询的条数小于等于0，则退出循环
      if (remainingCount <= 0) {
        this.log(`[CashFlow] ${this.userId} ${recentDays} 数量条目达成提前退出`);
        break;
      }
    }

    const result = allRecords
      .map((record) => this.formatCashFlowRecord(record))
      .sort((a, b) => {
        const strA = String(String(a.createTime) + a.uniqueKey);
        const strB = String(String(b.createTime) + b.uniqueKey);
        return strA.localeCompare(strB);
      })
      .slice(-this.querySize)
      .map((record, index) => {
        return { ...record, id: index + 1 };
      });

    remoteLogV(`[CashFlow] ${this.userId} ${recentDays} 数量:${result.length}/${this.querySize}`);

    return result;
  }

  /* 
      获取指定区间内的用户现金流水（闭区间 [startUniqueKey, endUniqueKey]）
      - uniqueKey 格式：`${YYYYMMDD}-${orgId}`
      - 以 endUniqueKey 所在日为起点倒序查询日表，直到 startUniqueKey 所在日
      - 查询量严格受 this.querySize 限制（最新的优先，达到上限提前退出）
      - 端点日使用 id 范围限制；跨天场景中间日全量（仍受 querySize 约束）
      - 数据的格式化、排序、id 重分配与 getCashFlow 保持一致
      @param {Object} options
      @param {string} options.startUniqueKey - 起始 uniqueKey
      @param {string} options.endUniqueKey - 结束 uniqueKey
      @returns {Promise<Array>} 现金流水数组
    */
  async getCashFlowByRange(options) {
    const { startUniqueKey, endUniqueKey } = options || {};

    if (!startUniqueKey || !endUniqueKey) {
      throw new Error(
        `getCashFlowByRange: startUniqueKey/endUniqueKey 必须传递 start:${startUniqueKey} end:${endUniqueKey}`
      );
    }

    const [startDay, startOrgIdStr] = String(startUniqueKey).split('-');
    const [endDay, endOrgIdStr] = String(endUniqueKey).split('-');
    const startOrgId = Number(startOrgIdStr);
    const endOrgId = Number(endOrgIdStr);

    if (!/^\d{8}$/.test(startDay) || !/^\d{8}$/.test(endDay) || !Number.isFinite(startOrgId) || !Number.isFinite(endOrgId)) {
      throw new Error(`getCashFlowByRange: uniqueKey 格式不正确 start:${startUniqueKey} end:${endUniqueKey}`);
    }

    // 严格限制：start 不能大于 end
    if (startDay > endDay || (startDay === endDay && startOrgId > endOrgId)) {
      throw new Error(
        `getCashFlowByRange: startUniqueKey 不能大于 endUniqueKey start:${startUniqueKey} end:${endUniqueKey}`
      );
    }

    // 生成从 endDay 到 startDay 的日表列表（按日期倒序，最新在前）
    const toDayMoment = (dayStr) => createMoment(`${dayStr.slice(0, 4)}-${dayStr.slice(4, 6)}-${dayStr.slice(6, 8)}`);
    const startMoment = toDayMoment(startDay);
    const cur = toDayMoment(endDay);

    const dayTableArr = [];
    while (cur.isSameOrAfter(startMoment, 'day')) {
      const day = cur.format('YYYYMMDD');
      dayTableArr.push({
        day,
        tableName: getDayTable('tb_user_account_cash', cur.valueOf()),
      });
      cur.subtract(1, 'd');
    }

    const allRecords = [];
    let remainingCount = this.querySize - allRecords.length;

    for (const item of dayTableArr) {
      // 构建日期相关的 id 范围限制（端点日收口，中间日不限制）
      const conditions = [`userId = ${this.userId}`];
      if (item.day === endDay) {
        conditions.push(`id <= ${endOrgId}`);
      }
      if (item.day === startDay) {
        conditions.push(`id >= ${startOrgId}`);
      }

      const sql = `
            SELECT 
              id, 
              '${item.day}' as _day, 
              userId, 
              depositAmount, 
              currentDeposit, 
              withdrawAmount, 
              currentWithdraw, 
              circulation, 
              gameId, 
              meta, 
              createTime
            FROM ${item.tableName}
            WHERE ${conditions.join(' AND ')}
            ORDER BY createTime desc 
            limit ${remainingCount}
          `;
      // eslint-disable-next-line no-await-in-loop
      const records = await prisma.$queryRawUnsafe(sql);
      allRecords.push(...records);

      const curRemainingCount = remainingCount;
      remainingCount = this.querySize - allRecords.length;

      this.log(
        `[CashFlowByRange] ${item.day} 预计查询条目:${curRemainingCount} 语句总条目:${this.querySize} 本次查询日期:${item.day} 查询到的条目数量:${records.length} 剩余条目:${remainingCount}`
      );

      if (remainingCount <= 0) {
        this.log(`[CashFlowByRange] ${this.userId} 数量条目达成提前退出`);
        break;
      }
    }

    const result = allRecords
      .map((record) => this.formatCashFlowRecord(record))
      .sort((a, b) => {
        const strA = String(String(a.createTime) + a.uniqueKey);
        const strB = String(String(b.createTime) + b.uniqueKey);
        return strA.localeCompare(strB);
      })
      .slice(-this.querySize)
      .map((record, index) => {
        return { ...record, id: index + 1 };
      });

    remoteLogV(
      `[CashFlowByRange] ${this.userId} start:${startUniqueKey} end:${endUniqueKey} 数量:${result.length}/${this.querySize}`
    );

    return result;
  }

  /* 
      更新用户现金流水
      @param {Object} record - 记录对象
      @param {Object} record.meta - 记录元数据
      @param {Object} record.id - 记录ID
      @param {Object} options - 选项
      @param {boolean} options.syncAccount - 是否同步更新 tbUserAccount 的余额，默认 true
    */
  async updateUserCashFlow(record, options) {
    const { flowType, syncAccount = true } = options || {};
    let updateStartUniqueKey = null;
    let updateEndUniqueKey = null;
    try {
      const startTime = Date.now();

      const lastRecord = record[record.length - 1];
      const operateUniqueKeyResult = this.getOperateUniqueKey(record);
      updateStartUniqueKey = operateUniqueKeyResult.startUniqueKey;
      updateEndUniqueKey = operateUniqueKeyResult.endUniqueKey;

      // 更新对应日表的flow
      const dayFlowRecord = record.reduce((acc, item) => {
        const day = item._day;
        if (!acc[day]) acc[day] = [];

        const tempData = { meta: item.meta, id: item.orgId };

        this.updateOriginFields.forEach((k) => {
          tempData[k] = item[k];
          if (k === 'type') {
            // 确定交易类型：1-加钱，2-扣钱
            tempData[k] = item.depositAmount + item.withdrawAmount > 0 ? 1 : 2;
          }
        });

        acc[day].push(tempData);
        return acc;
      }, {});

      const updateRecord = [];

      let updateCount = 0;

      // 遍历每天的记录，分批更新
      for (const day of Object.keys(dayFlowRecord)) {
        // 按条目分批
        const dataArr = _.chunk(dayFlowRecord[day], this.updateBatchSize);

        for (const item of dataArr) {
          updateRecord.push({
            tableName: `tb_user_account_cash_${day}`,
            record: item,
          });
          updateCount += item.length;
        }
      }

      await prisma.$transaction(
        async (tx) => {
          const promiseArr = [];

          // 更新每条金流记录
          for (const item of updateRecord) {
            const ids = item.record.map((t) => t.id);

            // 构建更新字段的 CASE 语句
            const updateFields = this.updateOriginFields
              .map((field) => {
                return `${field} = CASE id 
                      ${ids.map((id) => `WHEN ${id} THEN ?`).join('\n')}
                      ELSE ${field}
                    END`;
              })
              .join(',\n                ');

            // 采用原生sql提升批量操作性能
            const sql = `
                  UPDATE ${item.tableName} 
                    SET ${updateFields}
                    WHERE id IN (${ids.map((u) => `?`).join(',')})
                `;

            // 构建参数数组: [field1参数..., field2参数..., ..., ids参数...]
            const params = [...this.updateOriginFields.flatMap((field) => item.record.map((t) => t[field])), ...ids];

            promiseArr.push(tx.$executeRawUnsafe(sql, ...params));
          }

          // 根据 syncAccount 开关决定是否同步更新 tbUserAccount 的当前余额
          // 区间修复等历史数据场景不应覆盖用户当前真实余额
          if (syncAccount) {
            await tx.tbUserAccount.update({
              where: {
                userId: this.userId,
              },
              data: {
                withdrawCash: lastRecord.currentWithdraw,
                depositCash: lastRecord.currentDeposit,
              },
            });
          }

          // 批量执行
          const result = await Promise.all(promiseArr);
          const affectedRows = result.reduce((acc, row) => acc + row, 0);

          if (affectedRows !== updateCount) {
            throw new Error(`UpdateUserAccountBalance affectedRows:${affectedRows} updateCount:${updateCount}`);
          }

          remoteLogV(
            `[RiskControl] UpdateUserAccountBalance successful: userId:${this.userId} syncAccount:${syncAccount} ${lastRecord.currentWithdraw} ${lastRecord.currentDeposit} affectedRows:${affectedRows} updateStartUniqueKey:${updateStartUniqueKey} updateEndUniqueKey:${updateEndUniqueKey}`
          );
        },
        { timeout: 10000 }
      );
      remoteLogV(
        `[RiskControl] UpdateUserCashFlow successful: userId:${
          this.userId
        } ${updateCount} updateStartUniqueKey:${updateStartUniqueKey} updateEndUniqueKey:${updateEndUniqueKey} ${
          Date.now() - startTime
        }ms `
      );

      return { toUserChangeAssets: syncAccount };
    } catch (error) {
      throw new Error(`updateUserCashFlow error: userId:${this.userId} ${error.message} ${error.stack}`);
    }
  }

  /* 
      现金流水记录转换为游戏轮次记录
      @param {Array} records - 现金流水记录
      @returns {Array} 游戏轮次记录
    */
  cashFlowRecordConvertGameRecord(records) {
    try {
      const gameRecordMap = new Map();

      /* 
            初始化游戏轮次记录
            @param {string} key - 游戏轮次记录的唯一标识
            @param {Object} record - 游戏轮次记录对象
            @returns {Object} 游戏轮次记录
            */
      const initGameRecord = (key, { gameId, roundId, day }) => {
        if (!gameRecordMap.has(key)) {
          gameRecordMap.set(key, {
            gameId,
            roundId,

            meta: {
              backup: {
                betAmount: 0,
                winAmount: 0,
                betRollbackAmount: 0,
              },
              backupOrigin: {
                betAmount: 0,
                winAmount: 0,
                betRollbackAmount: 0,
              },
            },

            day,
          });
        }
        return gameRecordMap.get(key);
      };

      /* 
              提取记录数据
              @param {Object} record - 记录对象
              @returns {Object} 备份数据和原始数据
            */
      const extractRecordData = (record) => {
        const {
          meta: { backup: cashBackupData, backupOrigin },
        } = record;

        const result = {
          backup: {
            betAmount: 0,
            winAmount: 0,
            betRollbackAmount: 0,
          },
          backupOrigin: {
            betAmount: 0,
            winAmount: 0,
            betRollbackAmount: 0,
          },
        };

        const { bet, payout } = cashBackupData;

        if (record.circulation === RiskFlowManager.CirculationType.BET) {
          result.backup.betAmount += RiskFlowManager.toCash(bet);
        }
        if (record.circulation === RiskFlowManager.CirculationType.GAME_WIN) {
          result.backup.winAmount += RiskFlowManager.toCash(Math.abs(payout));
        }
        if (record.circulation === RiskFlowManager.CirculationType.ROLLBACK) {
          result.backup.betRollbackAmount += RiskFlowManager.toCash(Math.abs(payout));
        }

        // 原始金额
        // 原始数据计算：加钱或扣钱
        const amount = Math.abs(backupOrigin.depositAmount) + Math.abs(backupOrigin.withdrawAmount);
        if (backupOrigin.circulation === RiskFlowManager.CirculationType.BET) {
          result.backupOrigin.betAmount += amount;
        } else if (backupOrigin.circulation === RiskFlowManager.CirculationType.GAME_WIN) {
          result.backupOrigin.winAmount += amount;
        } else if (backupOrigin.circulation === RiskFlowManager.CirculationType.ROLLBACK) {
          result.backupOrigin.betRollbackAmount += amount;
        }

        return result;
      };

      /* 
            更新游戏轮次记录
            @param {string} key - 游戏轮次记录的唯一标识
            @param {Object} record - 游戏轮次记录对象
            @returns {Object} 游戏轮次记录
            */
      const updateRecordByKey = (key, args) => {
        const { gameId, roundId, day, field = 'backup', betAmount = 0, winAmount = 0, betRollbackAmount = 0 } = args;
        const gameRecord = initGameRecord(key, { gameId, roundId, day });
        gameRecord.meta[field].betAmount += betAmount || 0;
        gameRecord.meta[field].winAmount += winAmount || 0;
        gameRecord.meta[field].betRollbackAmount += betRollbackAmount || 0;
      };

      for (const record of records) {
        if (this.isGameRecord(record)) {
          const {
            gameId,
            meta: { game, backup: cashBackupData },
          } = record;

          const recordData = extractRecordData(record);
          const day = record._day;
          const originRoundId = game?.roundId;

          const originKey = `${gameId}-${originRoundId}`;

          // 初始化原始轮次记录 -- 避免之前数据没有被更新到
          updateRecordByKey(originKey, {
            ...recordData.backupOrigin,
            field: 'backupOrigin',
            gameId,
            roundId: originRoundId,
            day,
          });

          // 优先从backup中获取
          const fixRoundId = cashBackupData?.fixRoundId || game?.roundId;
          const key = `${gameId}-${fixRoundId}`;

          // 更新fixRoundId的游戏轮次记录
          updateRecordByKey(key, { ...recordData.backup, field: 'backup', gameId, roundId: fixRoundId, day });
        }
      }

      const result = Array.from(gameRecordMap.values());
      this.log(`cashFlowRecordConvertGameRecord userId:${this.userId} convert count: ${result.length}`);
      return result;
    } catch (error) {
      remoteLogV(`cashFlowRecordConvertGameRecord userId:${this.userId} convert error: ${error.message}`);
      return [];
    }
  }

  /* 
      更新用户游戏轮次流水
      @param {Array} gameRecords - 游戏轮次记录
      @returns {Promise<void>}
    */
  async updateUserGameRoundFlow(gameRecords) {
    try {
      const startTime = Date.now();

      const updateMap = {};
      gameRecords.forEach((item) => {
        const { gameId, roundId, meta, day } = item;
        if (!updateMap[day]) {
          updateMap[day] = [];
        }

        const updateItemData = {
          gameId,
          roundId,
          betAmount: item.meta.backup.betAmount,
          winAmount: item.meta.backup.winAmount,
          betRollbackAmount: item.meta.backup.betRollbackAmount,
        };

        // 只添加 updateGameRoundFields 中指定的字段
        this.updateGameRoundFields.forEach((field) => {
          if (item[field] !== undefined) {
            updateItemData[field] = item[field];
          }
        });

        updateMap[day].push(updateItemData);
      });

      const promiseArr = [];
      for (const day of Object.keys(updateMap)) {
        const tableName = `tb_game_round_${day}`;
        const dayUpdates = updateMap[day];

        // 构建更新字段的 CASE 语句
        const updateFields = this.updateGameRoundFields
          .map((field) => {
            if (field === 'meta') {
              // meta 字段使用 JSON_MERGE_PATCH 进行合并
              return `${field} = CASE
                    ${dayUpdates
                      .map(() => `WHEN gameId = ? AND roundId = ? THEN JSON_MERGE_PATCH(COALESCE(${field}, '{}'), ?)`)
                      .join('\n')}
                    ELSE ${field}
                  END`;
            }
            // 其他字段直接赋值
            return `${field} = CASE
                    ${dayUpdates.map(() => `WHEN gameId = ? AND roundId = ? THEN ?`).join('\n')}
                    ELSE ${field}
                  END`;
          })
          .join(',\n          ');

        const sql = `
              UPDATE ${tableName}
              SET ${updateFields}
              WHERE userId = ${this.userId}
              AND (gameId, roundId) IN (${dayUpdates.map(() => `(?, ?)`).join(',')})
            `;

        // 构建参数数组: [field1参数..., field2参数..., ..., whereParams...]
        const caseParams = [];
        this.updateGameRoundFields.forEach((field) => {
          dayUpdates.forEach((item) => {
            caseParams.push(item.gameId, item.roundId, item[field]);
          });
        });

        const whereParams = [];
        dayUpdates.forEach((item) => {
          whereParams.push(item.gameId, item.roundId);
        });

        if (dayUpdates.length > 0) {
          promiseArr.push(prisma.$executeRawUnsafe(sql, ...caseParams, ...whereParams));
        }
      }

      if (promiseArr.length > 0) {
        await Promise.all(promiseArr);
      }

      this.log(
        `[RiskControl] UpdateUserGameRoundFlow successful: userId:${this.userId} task:${gameRecords.length} time:${
          Date.now() - startTime
        }ms`
      );
    } catch (error) {
      this.log(
        `[RiskControl] UpdateUserGameRoundFlow error: userId:${this.userId} ${error.message} ${error.stack}`,
        'error'
      );
    }
  }

  /**  
      检查流水类型（内部方法）
      @param {Object} record - 记录对象
      @returns {string} 流水类型
    */
  _checkType(record) {
    const { depositAmount, currentDeposit, currentWithdraw, withdrawAmount } = record;

    if (depositAmount === 0 && currentDeposit === 0 && withdrawAmount === 0 && currentWithdraw === 0) {
      return RiskFlowManager.FLOW_TYPE.UNKNOWN;
    }

    if (depositAmount === 0 && withdrawAmount > 0) {
      return RiskFlowManager.FLOW_TYPE.WITHDRAW;
    }

    if (depositAmount === 0 && withdrawAmount === 0) {
      return RiskFlowManager.FLOW_TYPE.UNKNOWN;
    }

    return RiskFlowManager.FLOW_TYPE.DEPOSIT;
  }

  /**
      获取流水类型映射 
      @param {Array} records - 流水数据
      @returns {Array} 流水类型映射
    */
  flowTypeMap(records) {
    return records.reduce((acc, cur) => {
      const type = this._checkType(cur);
      acc.push({ circulation: cur.circulation, type, id: cur.id });
      return acc;
    }, []);
  }

  /**
   * 查找当前记录的flowType
   * 优先从原始记录中获取,如果找不到则向前查找最近一条记录的flowType,如果向前找不到则向后查找(不限制条数)
   * @param {number} index - 当前记录索引
   * @param {Array} flowData - 流水数据数组
   * @param {Array} flowTypeMap - flowType映射数组
   * @param {Object} rule - 查找规则配置
   * @param {boolean} rule.sameCirculation - 是否要求相同circulation类型
   * @returns {string} flowType
   */
  findFlowType(index, flowData, flowTypeMap, rule) {
    const { sameCirculation = true } = rule || {};

    // 先从flowTypeMap中找当前记录的原始flowType
    const currentFlowType = flowTypeMap.find((item) => item.id === flowData[index].id);
    if (
      currentFlowType &&
      currentFlowType.type !== RiskFlowManager.FLOW_TYPE.UNKNOWN &&
      flowData[index].circulation === currentFlowType.circulation
    ) {
      return currentFlowType.type;
    }

    // 如果找不到或为UNKNOWN,则向前查找最近一条有效的flowType
    for (let i = index - 1; i >= 0; i--) {
      const prevFlowType = flowTypeMap.find((item) => item.id === flowData[i].id);
      if (prevFlowType && prevFlowType.type !== RiskFlowManager.FLOW_TYPE.UNKNOWN) {
        if (!sameCirculation) {
          return prevFlowType.type;
        }
        // 找到相同得流通类型返回类型
        if (prevFlowType.circulation === flowData[index].circulation) {
          return prevFlowType.type;
        }
      }
    }

    // 向前查找失败,尝试向后查找(不限制条数,直到数组末尾)
    for (let i = index + 1; i < flowData.length; i++) {
      const nextFlowType = flowTypeMap.find((item) => item.id === flowData[i].id);
      if (nextFlowType && nextFlowType.type !== RiskFlowManager.FLOW_TYPE.UNKNOWN) {
        if (!sameCirculation) {
          return nextFlowType.type;
        }
        // 找到相同的流通类型返回类型
        if (nextFlowType.circulation === flowData[index].circulation) {
          return nextFlowType.type;
        }
      }
    }

    // 如果都找不到,返回DEPOSIT作为默认值
    return RiskFlowManager.FLOW_TYPE.DEPOSIT;
  }

  /* 
      写回流水数据
      @param {Array} flowData - 流水数据
      @returns {Promise<void>}
    */
  writeBackFlowData(data) {
    /**
     * 获取上一条记录的余额信息
     * @param {number} index - 当前记录索引
     * @param {Array} flowData - 流水数据数组
     * @param {Object} backupOrigin - 当前记录的原始备份数据
     * @returns {Object} 上一条记录的余额信息
     */
    const getPreviousRecord = (index, flowData, backupOrigin) => {
      if (index !== 0) {
        // 不是第一条记录，直接返回上一条记录的 replace 数据
        return flowData[index - 1].meta.backup.op;
      }
      // 第一条记录，需要根据 backupOrigin 反推上一条记录的余额
      // 公式：上一条余额 = 当前余额 - 当前操作金额
      return {
        ...backupOrigin,
        currentDeposit: backupOrigin.currentDeposit - backupOrigin.depositAmount,
        currentWithdraw: backupOrigin.currentWithdraw - backupOrigin.withdrawAmount,
      };
    };

    // 主处理逻辑：处理流水数据
    const flowData = _.cloneDeep(data).sort((a, b) => a.id - b.id);
    const flowTypeMap = this.flowTypeMap(flowData);

    flowData.forEach((item, index) => {
      // 备份原始数据
      const backupOrigin = this.buildBackupOriginData(item);
      item.meta.backupOrigin = backupOrigin;
      item.meta.backupStatus = RiskFlowManager.BACKUP_STATUS.REPLACE;

      // 获取上一条记录的余额信息
      const preRecord = getPreviousRecord(index, flowData, backupOrigin);

      // 继承上一条记录的余额作为本次操作的起始金额
      const startDeposit = preRecord.currentDeposit;
      const startWithdraw = preRecord.currentWithdraw;

      // 判断是否是游戏操作（通过 gameId 判断）
      const isGameOperation = !!item.gameId;

      if (!isGameOperation) {
        // ===== 4.1 非游戏操作 =====
        // depositAmount, withdrawAmount 保留原先的值不动
        item.depositAmount = backupOrigin.depositAmount;
        item.withdrawAmount = backupOrigin.withdrawAmount;
        item.circulation = backupOrigin.circulation;

        // 判断是否是转打码操作 (DEBT)
        if (item.circulation === RiskFlowManager.CirculationType.DEBT) {
          // 对于 DEBT 类型，需要额外处理：本次扣除的 depositAmount 不能大于上一次剩余的余额 currentDeposit
          const originalDepositDeduct = Math.abs(backupOrigin.depositAmount);

          // 如果扣除金额大于可用余额，则取最大可用值
          if (originalDepositDeduct > startDeposit) {
            const actualDeduct = startDeposit; // 最多只能扣除可用的余额
            const remainingDeduct = originalDepositDeduct - actualDeduct; // 剩余需要扣除的部分

            // 从 depositAmount 扣除实际能扣的部分
            item.depositAmount = -actualDeduct;

            // 剩余部分需要转移到 withdrawAmount（保持总扣除金额不变）
            item.withdrawAmount = backupOrigin.withdrawAmount - remainingDeduct;

            // 计算结果余额
            item.currentDeposit = startDeposit - actualDeduct;
            item.currentWithdraw = startWithdraw + (backupOrigin.withdrawAmount - remainingDeduct);
          } else {
            // 扣除金额在可用范围内，正常计算
            item.currentDeposit = startDeposit + item.depositAmount;
            item.currentWithdraw = startWithdraw + item.withdrawAmount;
          }
        } else {
          // 非 DEBT 类型，正常计算
          item.currentDeposit = startDeposit + item.depositAmount;
          item.currentWithdraw = startWithdraw + item.withdrawAmount;
        }
      } else {
        // ===== 4.2 是游戏操作 =====
        const {
          backup: { bet = 0, payout = 0, balanceAfter },
        } = item.meta;

        // 判断是否为下注操作
        const isBetOperation = bet > 0;

        if (isBetOperation) {
          // ===== 4.3 下注操作：优先扣除不可提现金，再扣除可提现金额 =====
          const betAmount = RiskFlowManager.toCash(bet);
          item.circulation = RiskFlowManager.CirculationType.BET;

          if (betAmount <= startDeposit) {
            // 不可提现金足够，全部从不可提现金扣除
            item.depositAmount = -betAmount;
            item.withdrawAmount = 0;
            item.currentDeposit = startDeposit - betAmount;
            item.currentWithdraw = startWithdraw;
          } else {
            // 不可提现金不足，需要从可提现金扣除剩余部分
            const remainingDeduct = betAmount - startDeposit;

            // 先扣完所有不可提现金
            item.depositAmount = -startDeposit;
            item.currentDeposit = 0;

            // 剩余部分从可提现金扣除
            item.withdrawAmount = -remainingDeduct;
            item.currentWithdraw = startWithdraw - remainingDeduct;
          }
        } else {
          // ===== 4.4 赢钱操作 =====
          const payoutAmount = RiskFlowManager.toCash(payout);
          item.circulation = RiskFlowManager.CirculationType.GAME_WIN;

          // 获取本次操作的原始flowType
          const currentFlowType = this.findFlowType(index, flowData, flowTypeMap, { sameCirculation: true });

          if (currentFlowType === RiskFlowManager.FLOW_TYPE.WITHDRAW) {
            // 如果是提现类型，加到可提现金
            item.depositAmount = 0;
            item.withdrawAmount = payoutAmount;
            item.currentDeposit = startDeposit;
            item.currentWithdraw = startWithdraw + payoutAmount;
          } else {
            // 如果是充值类型或其他，加到不可提现金
            item.depositAmount = payoutAmount;
            item.withdrawAmount = 0;
            item.currentDeposit = startDeposit + payoutAmount;
            item.currentWithdraw = startWithdraw;
          }
        }
      }

      // 保存操作后的备份数据
      item.meta.backup.op = this.buildBackupOriginData(item);
    });

    return flowData;
  }

  /**
   * 校验单条记录的金额计算是否正确
   * @param {Object} prevRecord - 上一条记录
   * @param {Object} currentRecord - 当前记录
   * @returns {Object} 校验结果
   */
  validateSingleRecord(prevRecord, currentRecord) {
    const errors = [];

    // 1. 检查当前记录的开始金额是否等于上一条记录的结束金额
    const prevEndBalance = prevRecord.currentDeposit + prevRecord.currentWithdraw;
    const currentStartBalance = prevEndBalance; // 当前起始余额应该等于上一条结束余额
    const currentEndBalance = currentRecord.currentDeposit + currentRecord.currentWithdraw;
    const expectedEndBalance = currentStartBalance + currentRecord.depositAmount + currentRecord.withdrawAmount;

    // 校验1: 上一条的结束余额必须等于当前的起始余额（已经通过定义保证）
    // 校验2: 当前的结束余额必须等于 起始余额 + 本次变化
    if (Math.abs(currentEndBalance - expectedEndBalance) > 10) {
      errors.push({
        type: 'BALANCE_MISMATCH',
        message: `金额计算不匹配: 结束余额(${currentEndBalance}) !== 起始余额(${currentStartBalance}) + 本次变化(${
          currentRecord.depositAmount + currentRecord.withdrawAmount
        }) = ${expectedEndBalance}`,
        prevRecord: {
          id: prevRecord.id,
          currentDeposit: prevRecord.currentDeposit,
          currentWithdraw: prevRecord.currentWithdraw,
          endBalance: prevEndBalance,
        },
        currentRecord: {
          id: currentRecord.id,
          depositAmount: currentRecord.depositAmount,
          withdrawAmount: currentRecord.withdrawAmount,
          currentDeposit: currentRecord.currentDeposit,
          currentWithdraw: currentRecord.currentWithdraw,
          startBalance: currentStartBalance,
          endBalance: currentEndBalance,
          expectedEndBalance,
        },
      });
    }

    // 新增：校验 meta.backup 数据（如果存在）
    if (currentRecord.meta && currentRecord.meta.backup) {
      const { backup } = currentRecord.meta;
      const { bet = 0, payout = 0, balanceBefore, balanceAfter } = backup;

      // 校验2: 判断操作金额是否 === bet or payout
      let operationAmount = Math.abs(currentRecord.depositAmount) + Math.abs(currentRecord.withdrawAmount);

      // 额外判断如果是转打码的情况下 需要对操作金额额外处理
      if (currentRecord.circulation === RiskFlowManager.CirculationType.DEBT) {
        operationAmount = currentRecord.depositAmount + currentRecord.withdrawAmount;
      }

      const backupAmount = RiskFlowManager.toCash(bet > 0 ? bet : payout);

      if (operationAmount !== Math.abs(backupAmount)) {
        errors.push({
          type: 'BACKUP_AMOUNT_MISMATCH',
          message: `操作金额与backup不匹配: 操作金额(${operationAmount}) !== backup金额(bet: ${RiskFlowManager.toCash(
            bet
          )}, payout: ${RiskFlowManager.toCash(payout)})`,
          currentRecord: {
            id: currentRecord.id,
            depositAmount: currentRecord.depositAmount,
            withdrawAmount: currentRecord.withdrawAmount,
            operationAmount,
            backupBet: RiskFlowManager.toCash(bet),
            backupPayout: RiskFlowManager.toCash(payout),
          },
        });
      }

      // 校验3: 判断操作完的总余额是否 === balanceAfter
      if (balanceAfter !== undefined) {
        const expectedBalanceAfter = RiskFlowManager.toCash(balanceAfter);
        if (Math.abs(currentEndBalance - expectedBalanceAfter) > 10) {
          errors.push({
            type: 'BALANCE_AFTER_MISMATCH',
            message: `操作后余额不匹配: 实际余额(${currentEndBalance}) !== backup.balanceAfter(${expectedBalanceAfter})`,
            currentRecord: {
              id: currentRecord.id,
              currentDeposit: currentRecord.currentDeposit,
              currentWithdraw: currentRecord.currentWithdraw,
              currentEndBalance,
              backupBalanceAfter: expectedBalanceAfter,
            },
          });
        }
      }

      // 校验4: 判断操作前的总余额是否 === balanceBefore
      if (balanceBefore !== undefined) {
        const expectedBalanceBefore = RiskFlowManager.toCash(balanceBefore);
        if (Math.abs(currentStartBalance - expectedBalanceBefore) > 10) {
          errors.push({
            type: 'BALANCE_BEFORE_MISMATCH',
            message: `操作前余额不匹配: 实际余额(${currentStartBalance}) !== backup.balanceBefore(${expectedBalanceBefore})`,
            prevRecord: {
              id: prevRecord.id,
              currentDeposit: prevRecord.currentDeposit,
              currentWithdraw: prevRecord.currentWithdraw,
              endBalance: currentStartBalance,
            },
            currentRecord: {
              id: currentRecord.id,
              backupBalanceBefore: expectedBalanceBefore,
            },
          });
        }
      }
    }

    // 2. 检查扣除逻辑：优先扣除 depositAmount，扣除完后 currentDeposit 余额是否正确
    if (currentRecord.depositAmount < 0) {
      // 扣除金额（depositAmount 为负数表示扣除）
      const deductAmount = Math.abs(currentRecord.depositAmount);
      const expectedCurrentDeposit = prevRecord.currentDeposit - deductAmount;

      if (Math.abs(expectedCurrentDeposit - currentRecord.currentDeposit) > 10) {
        errors.push({
          type: 'DEPOSIT_DEDUCT_MISMATCH',
          message: `不可提现金额扣除不匹配: 预期余额(${expectedCurrentDeposit}) !== 实际余额(${currentRecord.currentDeposit})`,
          prevRecord: {
            id: prevRecord.id,
            currentDeposit: prevRecord.currentDeposit,
          },
          currentRecord: {
            id: currentRecord.id,
            depositAmount: currentRecord.depositAmount,
            deductAmount,
            currentDeposit: currentRecord.currentDeposit,
            expectedCurrentDeposit,
          },
        });
      }

      // 如果扣除金额大于上一条的 currentDeposit，说明不可提现金额不足
      if (deductAmount > prevRecord.currentDeposit) {
        errors.push({
          type: 'INSUFFICIENT_DEPOSIT',
          message: `不可提现金额不足: 需要扣除(${deductAmount}) > 可用余额(${prevRecord.currentDeposit})`,
          prevRecord: {
            id: prevRecord.id,
            currentDeposit: prevRecord.currentDeposit,
          },
          currentRecord: {
            id: currentRecord.id,
            depositAmount: currentRecord.depositAmount,
            deductAmount,
          },
        });
      }
    }

    // 3. 检查可提现金额的连续性
    if (currentRecord.withdrawAmount < 0) {
      // 扣除可提现金额
      const deductAmount = Math.abs(currentRecord.withdrawAmount);
      const expectedCurrentWithdraw = prevRecord.currentWithdraw - deductAmount;

      if (Math.abs(expectedCurrentWithdraw - currentRecord.currentWithdraw) > 10) {
        errors.push({
          type: 'WITHDRAW_DEDUCT_MISMATCH',
          message: `可提现金额扣除不匹配: 预期余额(${expectedCurrentWithdraw}) !== 实际余额(${currentRecord.currentWithdraw})`,
          prevRecord: {
            id: prevRecord.id,
            currentWithdraw: prevRecord.currentWithdraw,
          },
          currentRecord: {
            id: currentRecord.id,
            withdrawAmount: currentRecord.withdrawAmount,
            deductAmount,
            currentWithdraw: currentRecord.currentWithdraw,
            expectedCurrentWithdraw,
          },
        });
      }
    } else if (currentRecord.withdrawAmount > 0) {
      // 增加可提现金额
      const expectedCurrentWithdraw = prevRecord.currentWithdraw + currentRecord.withdrawAmount;

      if (Math.abs(expectedCurrentWithdraw - currentRecord.currentWithdraw) > 10) {
        errors.push({
          type: 'WITHDRAW_ADD_MISMATCH',
          message: `可提现金额增加不匹配: 预期余额(${expectedCurrentWithdraw}) !== 实际余额(${currentRecord.currentWithdraw})`,
          prevRecord: {
            id: prevRecord.id,
            currentWithdraw: prevRecord.currentWithdraw,
          },
          currentRecord: {
            id: currentRecord.id,
            withdrawAmount: currentRecord.withdrawAmount,
            currentWithdraw: currentRecord.currentWithdraw,
            expectedCurrentWithdraw,
          },
        });
      }
    }

    // 4. 检查不可提现金额的连续性（如果没有扣除）
    if (currentRecord.depositAmount > 0) {
      // 增加不可提现金额
      const expectedCurrentDeposit = prevRecord.currentDeposit + currentRecord.depositAmount;

      if (Math.abs(expectedCurrentDeposit - currentRecord.currentDeposit) > 10) {
        errors.push({
          type: 'DEPOSIT_ADD_MISMATCH',
          message: `不可提现金额增加不匹配: 预期余额(${expectedCurrentDeposit}) !== 实际余额(${currentRecord.currentDeposit})`,
          prevRecord: {
            id: prevRecord.id,
            currentDeposit: prevRecord.currentDeposit,
          },
          currentRecord: {
            id: currentRecord.id,
            depositAmount: currentRecord.depositAmount,
            currentDeposit: currentRecord.currentDeposit,
            expectedCurrentDeposit,
          },
        });
      }
    } else if (currentRecord.depositAmount === 0) {
      // depositAmount 为 0，currentDeposit 应该保持不变
      if (Math.abs(prevRecord.currentDeposit - currentRecord.currentDeposit) > 10) {
        errors.push({
          type: 'DEPOSIT_UNCHANGED_MISMATCH',
          message: `不可提现金额应保持不变: 上一条(${prevRecord.currentDeposit}) !== 当前(${currentRecord.currentDeposit})`,
          prevRecord: {
            id: prevRecord.id,
            currentDeposit: prevRecord.currentDeposit,
          },
          currentRecord: {
            id: currentRecord.id,
            depositAmount: currentRecord.depositAmount,
            currentDeposit: currentRecord.currentDeposit,
          },
        });
      }
    }

    // 5. 检查余额是否出现负数（异常情况）
    if (currentRecord.currentDeposit < 0) {
      errors.push({
        type: 'NEGATIVE_DEPOSIT',
        message: `不可提现金额出现负数: currentDeposit(${currentRecord.currentDeposit}) < 0`,
        currentRecord: {
          id: currentRecord.id,
          depositAmount: currentRecord.depositAmount,
          currentDeposit: currentRecord.currentDeposit,
        },
      });
    }

    if (currentRecord.currentWithdraw < 0) {
      errors.push({
        type: 'NEGATIVE_WITHDRAW',
        message: `可提现金额出现负数: currentWithdraw(${currentRecord.currentWithdraw}) < 0`,
        currentRecord: {
          id: currentRecord.id,
          withdrawAmount: currentRecord.withdrawAmount,
          currentWithdraw: currentRecord.currentWithdraw,
        },
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 校验整个现金流链
   * @param {Array} records - 现金流记录数组
   * @param {number} operationAmount - 操作金额（必传）
   * @param {Object} originalLastRecord - 原始数据的最后一条记录（必传）
   * @returns {Object} 校验结果
   */
  validateCashFlowChain(records, operationAmount, originalLastRecord) {
    // 校验1: originalLastRecord 必须传递
    if (!originalLastRecord) {
      return {
        isValid: false,
        message: 'originalLastRecord 参数是必须的',
        totalRecords: 0,
        validRecords: 0,
        invalidRecords: 0,
        errors: [
          {
            type: 'MISSING_ORIGINAL_LAST_RECORD',
            message: 'originalLastRecord 参数缺失，无法进行强校验',
            providedValue: originalLastRecord,
          },
        ],
      };
    }

    // 校验2: operationAmount 必须传递
    if (operationAmount === undefined || operationAmount === null) {
      return {
        isValid: false,
        message: 'operationAmount 参数是必须的',
        totalRecords: 0,
        validRecords: 0,
        invalidRecords: 0,
        errors: [
          {
            type: 'MISSING_OPERATION_AMOUNT',
            message: 'operationAmount 参数缺失，无法进行校验',
            providedValue: operationAmount,
          },
        ],
      };
    }

    // 校验3: operationAmount 必须是有效的数字
    if (typeof operationAmount !== 'number' || Number.isNaN(operationAmount) || !Number.isFinite(operationAmount)) {
      return {
        isValid: false,
        message: 'operationAmount 必须是一个有效的数字',
        totalRecords: 0,
        validRecords: 0,
        invalidRecords: 0,
        errors: [
          {
            type: 'INVALID_OPERATION_AMOUNT',
            message: `operationAmount 不是有效的数字: ${operationAmount} (类型: ${typeof operationAmount})`,
            providedValue: operationAmount,
            providedType: typeof operationAmount,
            isNaN: Number.isNaN(operationAmount),
            isFinite: Number.isFinite(operationAmount),
          },
        ],
      };
    }

    if (!records || records.length === 0) {
      return {
        isValid: false,
        message: '现金流记录为空',
        totalRecords: 0,
        validRecords: 0,
        invalidRecords: 0,
        errors: [],
      };
    }

    if (records.length === 1) {
      return {
        isValid: true,
        message: '只有一条记录，无需校验',
        totalRecords: 1,
        validRecords: 1,
        invalidRecords: 0,
        errors: [],
      };
    }

    const allErrors = [];
    let validCount = 0;
    let invalidCount = 0;

    // 从第二条记录开始校验
    for (let i = 1; i < records.length; i++) {
      const prevRecord = records[i - 1];
      const currentRecord = records[i];

      const result = this.validateSingleRecord(prevRecord, currentRecord);

      if (result.isValid) {
        validCount++;
      } else {
        invalidCount++;
        allErrors.push({
          index: i,
          prevRecordId: prevRecord.id,
          currentRecordId: currentRecord.id,
          errors: result.errors,
        });
      }
    }

    // 验证实际增加
    // 验证实际分配的金额
    const actualNetGain = records.reduce(
      (sum, record) => {
        sum.backupAmount += RiskFlowManager.toCash((record?.meta?.backup?.payout || 0) - (record?.meta?.backup?.bet || 0));
        // 所有操作金额累加
        sum.fixAmount += (record?.depositAmount || 0) + (record?.withdrawAmount || 0);
        return sum;
      },
      { backupAmount: 0, fixAmount: 0 }
    );

    // 校验：实际增加 和 fix的不一致 则添加错误信息
    if (Math.abs(actualNetGain.backupAmount - actualNetGain.fixAmount) > 10) {
      allErrors.push({
        type: 'TOTAL_AMOUNT_MISMATCH',
        message: `实际增加金额与fix金额不一致: backup实际增加(${actualNetGain.backupAmount}) !== fix分配金额(${
          actualNetGain.fixAmount
        }), 差异: ${actualNetGain.backupAmount - actualNetGain.fixAmount}`,
        backupAmount: actualNetGain.backupAmount,
        fixAmount: actualNetGain.fixAmount,
        difference: actualNetGain.backupAmount - actualNetGain.fixAmount,
      });
    }

    // 校验2: 最后一条记录的余额校验
    const lastRecord = records[records.length - 1];
    const lastRecordFinalBalance = lastRecord.currentDeposit + lastRecord.currentWithdraw;
    const lastRecordOriginBalance =
      (lastRecord.meta?.backupOrigin?.currentDeposit || 0) + (lastRecord.meta?.backupOrigin?.currentWithdraw || 0);
    const expectedFinalBalance = lastRecordOriginBalance + RiskFlowManager.toCash(operationAmount);

    if (Math.abs(lastRecordFinalBalance - expectedFinalBalance) > 10) {
      allErrors.push({
        type: 'FINAL_BALANCE_MISMATCH',
        message: `最后一条记录余额校验失败: 实际余额(${lastRecordFinalBalance}) !== 原始余额(${lastRecordOriginBalance}) + 操作金额(${operationAmount}) = ${expectedFinalBalance}`,
        lastRecordId: lastRecord.id,
        actualFinalBalance: lastRecordFinalBalance,
        originBalance: lastRecordOriginBalance,
        operationAmount,
        expectedFinalBalance,
        difference: lastRecordFinalBalance - expectedFinalBalance,
        lastRecordDetail: {
          currentDeposit: lastRecord.currentDeposit,
          currentWithdraw: lastRecord.currentWithdraw,
          originDeposit: lastRecord.meta?.backupOrigin?.currentDeposit || 0,
          originWithdraw: lastRecord.meta?.backupOrigin?.currentWithdraw || 0,
        },
      });
    }

    // ===== 强校验部分：使用原始数据的最后一条记录 =====
    const originalRecordId = originalLastRecord.id;

    // 强校验1: 检查最后一条记录的 ID 是否一致
    if (lastRecord.id !== originalRecordId) {
      allErrors.push({
        type: 'LAST_RECORD_ID_MISMATCH',
        message: `最后一条记录ID不一致: 当前records最后一条id(${lastRecord.id}) !== 原始数据最后一条id(${originalRecordId})`,
        currentLastRecordId: lastRecord.id,
        originalLastRecordId: originalRecordId,
      });
    }

    // 强校验2: 使用原始记录的余额进行校验
    const originalRecordOriginBalance = (originalLastRecord.currentDeposit || 0) + (originalLastRecord.currentWithdraw || 0);
    const expectedFinalBalanceStrict = originalRecordOriginBalance + RiskFlowManager.toCash(operationAmount);
    const balanceDifference = Math.abs(lastRecordFinalBalance - expectedFinalBalanceStrict);

    if (balanceDifference > 10) {
      allErrors.push({
        type: 'STRICT_FINAL_BALANCE_MISMATCH',
        message: `强校验失败: 实际余额(${lastRecordFinalBalance}) 与 原始余额(${originalRecordOriginBalance}) + 操作金额(${RiskFlowManager.toCash(
          operationAmount
        )}) = ${expectedFinalBalanceStrict} 差值超过10，当前差值: ${balanceDifference}`,
        currentLastRecordId: lastRecord.id,
        originalLastRecordId: originalRecordId,
        actualFinalBalance: lastRecordFinalBalance,
        originalOriginBalance: originalRecordOriginBalance,
        operationAmount: RiskFlowManager.toCash(operationAmount),
        expectedFinalBalance: expectedFinalBalanceStrict,
        difference: balanceDifference,
        lastRecordDetail: {
          current: {
            id: lastRecord.id,
            currentDeposit: lastRecord.currentDeposit,
            currentWithdraw: lastRecord.currentWithdraw,
            totalBalance: lastRecordFinalBalance,
          },
          original: {
            id: originalRecordId,
            originDeposit: originalLastRecord.currentDeposit || 0,
            originWithdraw: originalLastRecord.currentWithdraw || 0,
            totalOriginBalance: originalRecordOriginBalance,
          },
        },
      });
    }

    return {
      isValid: allErrors.length === 0,
      message: allErrors.length === 0 ? '所有记录校验通过' : `发现 ${allErrors.length} 处错误`,
      totalRecords: records.length,
      validRecords: validCount,
      invalidRecords: invalidCount,
      errors: allErrors,
      amountValidation: {
        backupAmount: actualNetGain.backupAmount,
        fixAmount: actualNetGain.fixAmount,
        isMatched: Math.abs(actualNetGain.backupAmount - actualNetGain.fixAmount) <= 10,
      },
      finalBalanceValidation: {
        actualBalance: lastRecordFinalBalance,
        expectedBalance: expectedFinalBalance,
        operationAmount,
        isMatched: Math.abs(lastRecordFinalBalance - expectedFinalBalance) <= 10,
      },
    };
  }

  /**
   * 打印校验结果
   * @param {Object} result - 校验结果
   */
  printValidationResult(result) {
    this.log('\n========== 现金流校验结果 ==========', 'info');
    this.log(`总记录数: ${result.totalRecords}`, 'info');
    this.log(`有效记录: ${result.validRecords}`, 'info');
    this.log(`无效记录: ${result.invalidRecords}`, 'info');
    this.log(`校验状态: ${result.isValid ? '✅ 通过' : '❌ 失败'}`, 'info');
    this.log(`消息: ${result.message}`, 'info');

    // 显示金额校验结果
    if (result.amountValidation) {
      this.log('\n========== 金额校验 ==========', 'info');
      this.log(`backup实际增加: ${result.amountValidation.backupAmount}`, 'info');
      this.log(`fix分配金额: ${result.amountValidation.fixAmount}`, 'info');
      this.log(
        `金额匹配: ${result.amountValidation.isMatched ? '✅ 匹配' : '❌ 不匹配'}`,
        result.amountValidation.isMatched ? 'info' : 'error'
      );
    }

    // 显示最终余额校验结果
    if (result.finalBalanceValidation) {
      this.log('\n========== 最终余额校验 ==========', 'info');
      this.log(`实际余额: ${result.finalBalanceValidation.actualBalance}`, 'info');
      this.log(`预期余额: ${result.finalBalanceValidation.expectedBalance}`, 'info');
      this.log(`操作金额: ${result.finalBalanceValidation.operationAmount}`, 'info');
      this.log(
        `余额匹配: ${result.finalBalanceValidation.isMatched ? '✅ 匹配' : '❌ 不匹配'}`,
        result.finalBalanceValidation.isMatched ? 'info' : 'error'
      );
    }

    if (result.errors && result.errors.length > 0) {
      this.log('\n========== 错误详情 ==========', 'error');
      result.errors.forEach((error, index) => {
        this.log(`\n错误 #${index + 1}:`, 'error');

        // 判断错误类型
        if (error.type === 'MISSING_ORIGINAL_LAST_RECORD') {
          // 缺少originalLastRecord参数
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  提供的值: ${error.providedValue}`, 'error');
        } else if (error.type === 'MISSING_OPERATION_AMOUNT') {
          // 缺少operationAmount参数
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  提供的值: ${error.providedValue}`, 'error');
        } else if (error.type === 'INVALID_OPERATION_AMOUNT') {
          // operationAmount不是有效数字
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  提供的值: ${error.providedValue}`, 'error');
          this.log(`  值的类型: ${error.providedType}`, 'error');
          this.log(`  是否为NaN: ${error.isNaN}`, 'error');
          this.log(`  是否为有限数: ${error.isFinite}`, 'error');
        } else if (error.type === 'TOTAL_AMOUNT_MISMATCH') {
          // 总体金额校验错误
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  backup实际增加: ${error.backupAmount}`, 'error');
          this.log(`  fix分配金额: ${error.fixAmount}`, 'error');
          this.log(`  差异: ${error.difference}`, 'error');
        } else if (error.type === 'FINAL_BALANCE_MISMATCH') {
          // 最终余额校验错误
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  最后一条记录ID: ${error.lastRecordId}`, 'error');
          this.log(`  实际余额: ${error.actualFinalBalance}`, 'error');
          this.log(`  原始余额: ${error.originBalance}`, 'error');
          this.log(`  操作金额: ${error.operationAmount}`, 'error');
          this.log(`  预期余额: ${error.expectedFinalBalance}`, 'error');
          this.log(`  差异: ${error.difference}`, 'error');
          this.log(`  详情: ${JSON.stringify(error.lastRecordDetail, null, 4)}`, 'error');
        } else if (error.type === 'LAST_RECORD_ID_MISMATCH') {
          // 最后一条记录ID不一致错误（强校验）
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  当前records最后一条ID: ${error.currentLastRecordId}`, 'error');
          this.log(`  原始数据最后一条ID: ${error.originalLastRecordId}`, 'error');
        } else if (error.type === 'STRICT_FINAL_BALANCE_MISMATCH') {
          // 强校验余额不匹配错误
          this.log(`  类型: ${error.type}`, 'error');
          this.log(`  消息: ${error.message}`, 'error');
          this.log(`  当前records最后一条ID: ${error.currentLastRecordId}`, 'error');
          this.log(`  原始数据最后一条ID: ${error.originalLastRecordId}`, 'error');
          this.log(`  实际最终余额: ${error.actualFinalBalance}`, 'error');
          this.log(`  原始记录余额: ${error.originalOriginBalance}`, 'error');
          this.log(`  操作金额: ${error.operationAmount}`, 'error');
          this.log(`  预期最终余额: ${error.expectedFinalBalance}`, 'error');
          this.log(`  差值: ${error.difference}`, 'error');
          this.log(`  详情: ${JSON.stringify(error.lastRecordDetail, null, 4)}`, 'error');
        } else {
          // 单条记录错误
          this.log(`  位置: 记录索引 ${error.index}`, 'error');
          this.log(`  上一条记录ID: ${error.prevRecordId}`, 'error');
          this.log(`  当前记录ID: ${error.currentRecordId}`, 'error');
          this.log(`  错误数量: ${error.errors.length}`, 'error');

          error.errors.forEach((err, errIndex) => {
            this.log(`\n  错误 ${errIndex + 1}/${error.errors.length}:`, 'error');
            this.log(`    类型: ${err.type}`, 'error');
            this.log(`    消息: ${err.message}`, 'error');
            this.log(`    详情: ${JSON.stringify(err, null, 6)}`, 'error');
          });
        }
      });
    }
    this.log('\n====================================\n', 'info');
  }

  /* 
      重置流水
      @param {number} backupAmount - 备份金额（盈亏差值）
      @param {Object} [options] - 扩展选项
      @param {string} [options.startUniqueKey] - 区间起始 uniqueKey（与 endUniqueKey 同时传入时走区间模式）
      @param {string} [options.endUniqueKey] - 区间结束 uniqueKey
      @param {boolean} [options.syncAccount=true] - 是否同步更新 tbUserAccount 当前余额；区间修历史数据时建议传 false
      @returns {Promise<void>}
    */
  async fixFlow(backupAmount, options) {
    const { startUniqueKey: rangeStart, endUniqueKey: rangeEnd, syncAccount = true } = options || {};
    let startUniqueKey = null;
    let endUniqueKey = null;
    try {
      const { userId } = this;
      if (!_.isNumber(backupAmount)) {
        throw new Error('backupAmount must be a number');
      }

      // 根据是否传入区间参数决定使用哪种查询方式（原始 getCashFlow 行为不变）
      const useRange = !!(rangeStart && rangeEnd);
      const flowData = useRange
        ? await this.getCashFlowByRange({ startUniqueKey: rangeStart, endUniqueKey: rangeEnd })
        : await this.getCashFlow();

      if (flowData.length <= 10) {
        this.log(
          `[RiskControl] flowCashHandler error: userId:${userId} amount:${backupAmount} flowData is empty ${flowData.length}`,
          'error'
        );
        return;
      }

      const operateUniqueKeyResult = this.getOperateUniqueKey(flowData);
      startUniqueKey = operateUniqueKeyResult.startUniqueKey;
      endUniqueKey = operateUniqueKeyResult.endUniqueKey;

      RiskFlowManager.writeFile('originalFlowData.json', flowData);

      const adjust = new this.GameResultAdjuster({ debug: false });

      let adjustResult = null;

      const timeStat = RiskFlowManager.createTimeStat();
      timeStat.start('total');
      timeStat.start('step1');

      const maxRetries = 3;
      let lastAdjustError = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          adjustResult = await adjust.adjustDBData(flowData, backupAmount);
          lastAdjustError = null;
          break;
        } catch (error) {
          lastAdjustError = error;
          this.log(`[RiskControl] adjustDBData ${attempt} 次失败: ${error.message}`, 'warn');
        }
      }
      if (lastAdjustError) {
        throw lastAdjustError;
      }

      const { backupRecords, adjustedResult } = adjustResult;

      const score = adjustedResult?.score?.score || 0;

      // 如果备份记录为空，则抛出错误
      if (backupRecords.length === 0) {
        throw new Error(`backupRecords is empty, userId:${userId} amount:${backupAmount} score:${score}`);
      }

      RiskFlowManager.writeFile('backupRecords.json', backupRecords);

      timeStat.end('step1');
      timeStat.start('step2');

      // 修正余额链
      const writeBackFlowData = this.writeBackFlowData(backupRecords);

      RiskFlowManager.writeFile('writeBackFlowData.json', writeBackFlowData);

      // 验证修正余额链
      const originalLastRecord = flowData[flowData.length - 1];
      const fixValidator = this.validateCashFlowChain(writeBackFlowData, backupAmount, originalLastRecord);
      timeStat.end('step2');
      timeStat.end('total');
      const fixFlowTiming = timeStat.getStats();
      if (!fixValidator.isValid) {
        RiskFlowManager.writeFile('fixValidator.json', fixValidator);
        throw new Error(`校验修正金额链异常 score:${score}`);
      } else {
        this.log(`[RiskControl] 校验修正链通过: userId:${userId} amount:${backupAmount}`, 'info');
      }

      // 更新现金流
      const { toUserChangeAssets } = await this.updateUserCashFlow(writeBackFlowData, { syncAccount });

      if (toUserChangeAssets) {
        await sendToUser(userId, { pop: false });
      }
      remoteLogV(
        `[RiskControl] 更新现金流 successful: userId:${userId} amount:${backupAmount} startUniqueKey:${startUniqueKey} endUniqueKey:${endUniqueKey}`
      );

      // // 转换为流水记录
      const gameRoundRecords = this.cashFlowRecordConvertGameRecord(writeBackFlowData);

      await new this.GameFlowStatsCalculator({ userId }).sync(writeBackFlowData);

      // // 更新游戏记录
      await this.updateUserGameRoundFlow(gameRoundRecords);

      this.log(`[RiskControl] 更新游戏记录 successful: userId:${userId} amount:${backupAmount} `, 'info');

      return { score, fixFlowTiming };
    } catch (error) {
      throw new Error(`startUniqueKey:${startUniqueKey} endUniqueKey:${endUniqueKey} ${error.message}`);
    }
  }

  /*
   * 调试重置流水 不入库
   * @param {number} backupAmount - 备份金额（盈亏差值）
   * @param {Object} [options] - 扩展选项
   * @param {string} [options.startUniqueKey] - 区间起始 uniqueKey（与 endUniqueKey 同时传入时走区间模式）
   * @param {string} [options.endUniqueKey] - 区间结束 uniqueKey
   * @param {boolean} [options.syncAccount=true] - 是否同步更新 tbUserAccount 当前余额；区间修历史数据时建议传 false
   * @returns {Promise<void>}
   */
  async debugFixFlow(backupAmount, options) {
    const { startUniqueKey: rangeStart, endUniqueKey: rangeEnd, syncAccount = true } = options || {};
    let startUniqueKey = null;
    let endUniqueKey = null;
    try {
      const { userId } = this;
      if (!_.isNumber(backupAmount)) {
        throw new Error('backupAmount must be a number');
      }

      // 根据是否传入区间参数决定使用哪种查询方式（原始 getCashFlow 行为不变）
      const useRange = !!(rangeStart && rangeEnd);
      const flowData = useRange
        ? await this.getCashFlowByRange({ startUniqueKey: rangeStart, endUniqueKey: rangeEnd })
        : await this.getCashFlow();

      if (flowData.length <= 10) {
        this.log(
          `[RiskControl] flowCashHandler error: userId:${userId} amount:${backupAmount} flowData is empty ${flowData.length}`,
          'error'
        );
        return;
      }

      const operateUniqueKeyResult = this.getOperateUniqueKey(flowData);
      startUniqueKey = operateUniqueKeyResult.startUniqueKey;
      endUniqueKey = operateUniqueKeyResult.endUniqueKey;

      RiskFlowManager.writeFile('originalFlowData.json', flowData);

      const adjust = new this.GameResultAdjuster({ debug: false });

      let adjustResult = null;

      const timeStat = RiskFlowManager.createTimeStat();
      timeStat.start('total');
      timeStat.start('step1');

      try {
        adjustResult = await adjust.adjustDBData(flowData, backupAmount);
      } catch (error) {
        throw new Error(`adjustDBData error: ${error.message} ${error.stack}`);
      }

      const { backupRecords, adjustedResult } = adjustResult;

      const score = adjustedResult?.score?.score || 0;

      // 如果备份记录为空，则抛出错误
      if (backupRecords.length === 0) {
        throw new Error(`backupRecords is empty, userId:${userId} amount:${backupAmount} score:${score}`);
      }

      RiskFlowManager.writeFile('backupRecords.json', backupRecords);

      timeStat.end('step1');
      timeStat.start('step2');

      // 修正余额链
      const writeBackFlowData = this.writeBackFlowData(backupRecords);

      RiskFlowManager.writeFile('writeBackFlowData.json', writeBackFlowData);

      // 验证修正余额链
      const originalLastRecord = flowData[flowData.length - 1];
      const fixValidator = this.validateCashFlowChain(writeBackFlowData, backupAmount, originalLastRecord);
      timeStat.end('step2');
      timeStat.end('total');
      const fixFlowTiming = timeStat.getStats();
      if (!fixValidator.isValid) {
        RiskFlowManager.writeFile('fixValidator.json', fixValidator);
        throw new Error(`校验修正金额链异常 score:${score}`);
      } else {
        this.log(
          `[RiskControl] 校验修正链通过: userId:${userId} amount:${backupAmount} timing:${JSON.stringify(fixFlowTiming)}`,
          'info'
        );
      }

      return { score, fixFlowTiming };
    } catch (error) {
      throw new Error(`startUniqueKey:${startUniqueKey} endUniqueKey:${endUniqueKey} ${error.message}`);
    }
  }
}

// ========================================
// 静态枚举常量（放在类声明后，兼容 ES2015 环境）
// 仅 RiskFlowManager 专用，与外层 riskorg.js 解耦
// ========================================
RiskFlowManager.FLOW_TYPE = {
  DEPOSIT: 'deposit', // 现金居多
  WITHDRAW: 'withdraw', // 提现居多
  UNKNOWN: 'unknown', // 未知
};

RiskFlowManager.BACKUP_STATUS = {
  REPLACE: 'replace', // 替换
  ORIGIN: 'origin', // 原始
};

// 内部独立维护一份，避免依赖外层同名常量
RiskFlowManager.CirculationType = {
  GAME_WIN: 10004, // 对局赢
  BET: 48000, // 对局下注
  ROLLBACK: 48001, // 对局回滚
  DEBT: 48002,
};

const FIX_FLOW_SLOW_MS = 5000;

/* 
  @param {string} handlerName - 处理名称
  @param {Object} context - 上下文
  @param {Object} fixFlowTiming - 流水处理耗时
  @returns {void}
*/
const reportSlowFixFlow = (handlerName, context, fixFlowTiming) => {
  try {
    if (!fixFlowTiming || fixFlowTiming.total <= FIX_FLOW_SLOW_MS) return;
    const { userId, amount } = context;
    remoteLogV(
      `reportSlowFixFlow ${handlerName} slow userId:${userId} amount:${amount} timing:${JSON.stringify(fixFlowTiming)}`
    );
  } catch (error) {
    remoteLogV(`reportSlowFixFlow error: ${error.message}`);
  }
};

// 监听runSql事件
/* 
  现金流处理
  @param {Object} data - 数据
  @param {number} data.userId - 用户ID
  @param {number} data.amount - 金额
  @returns {Promise<void>}
*/
const flowCashHandler = async ({ userId, amount }) => {
  const startTime = Date.now();
  let flowAmount = formatCash(amount);
  try {
    if (!CONSTANTS.FIX_FLOW) {
      remoteLogV(`[RiskControl] flowCashHandler skip: userId:${userId} amount:${flowAmount}`);
      return;
    }

    remoteLogV(`[RiskControl] flowCashHandler start userId:${userId} amount:${flowAmount}`, true);

    const riskFlowManager = new RiskFlowManager({
      userId,
      GameResultAdjuster,
      GameFlowStatsCalculator,
    });

    const { score, fixFlowTiming } = await riskFlowManager.fixFlow(flowAmount);
    reportSlowFixFlow('flowCashHandler', { userId, amount: flowAmount }, fixFlowTiming);

    remoteLogV(
      `[RiskControl] flowCashHandler end userId:${userId} amount:${flowAmount} score:${score} time:${Date.now() - startTime
      }ms`,
      true
    );
  } catch (error) {
    remoteLogV(
      `[RiskControl] flowCashHandler error: userId:${userId} amount:${flowAmount}$  ${error.message} ${error.stack}`,
      true
    );
  }
};

/* 
  现金流处理
  @param {Object} data - 数据
  @param {number} data.userId - 用户ID
  @param {number} data.amount - 金额
  @returns {Promise<void>}
*/
async function debugFlowCashHandler({ userId, amount: flowAmount }) {
  const startTime = Date.now();
  try {
    remoteLogV(`[RiskControl] debugFlowCashHandler start userId:${userId} amount:${flowAmount}`);

    const riskFlowManager = new RiskFlowManager({
      userId,
      GameResultAdjuster,
      GameFlowStatsCalculator,
    });

    const { score, fixFlowTiming } = await riskFlowManager.debugFixFlow(flowAmount);
    reportSlowFixFlow('debugFlowCashHandler', { userId, amount: flowAmount }, fixFlowTiming);

    remoteLogV(
      `[RiskControl] debugFlowCashHandler end userId:${userId} amount:${flowAmount} score:${score} time:${Date.now() - startTime
      }ms`
    );

    return { score, success: true };
  } catch (error) {
    remoteLogV(
      `[RiskControl] debugFlowCashHandler error: userId:${userId} amount:${flowAmount}$  ${error.message} ${error.stack}`
    );
    return { score: 0, success: false };
  }
}

/* 
  现金流处理
  @param {Object} data - 数据
  @param {number} data.userId - 用户ID
  @param {number} data.amount - 金额
  @returns {Promise<void>}
*/
const resetFlowCashHandler = async ({ userId, amount, startUniqueKey, endUniqueKey }) => {
  const startTime = Date.now();
  let flowAmount = formatCash(amount);
  try {
    if (!CONSTANTS.FIX_FLOW) {
      remoteLogV(`[RiskControl] resetFlowCashHandler skip: userId:${userId} amount:${flowAmount}`);
      return;
    }

    remoteLogV(`[RiskControl] resetFlowCashHandler start userId:${userId} amount:${flowAmount}`);

    const riskFlowManager = new RiskFlowManager({
      userId,
      GameResultAdjuster,
      GameFlowStatsCalculator,
    });

    const { score, fixFlowTiming } = await riskFlowManager.fixFlow(flowAmount, {
      startUniqueKey,
      endUniqueKey,
      syncAccount: false,
    });
    reportSlowFixFlow('resetFlowCashHandler', { userId, amount: flowAmount }, fixFlowTiming);

    remoteLogV(
      `[RiskControl] resetFlowCashHandler end userId:${userId} amount:${flowAmount} score:${score} time:${Date.now() - startTime
      }ms`
    );
  } catch (error) {
    remoteLogV(
      `[RiskControl] resetFlowCashHandler error: userId:${userId} amount:${flowAmount}$ ${error.message} ${error.stack}`
    );
  }
};

// ======================================== 改写流水

// ======================================== 同步用户

/* 
  发送同步用户请求
  @param {string} apiUrl - 请求URL
  @param {Object} data - 请求数据
  @returns {Promise<Object|null>} 请求响应体，失败时返回null
*/
const sendSyncUserRequest = async (data) => {
  try {
    const apiUrl = `${getPaymentApiHost()}/v1/user/sync-user-many`;
    data.userList = JSON.stringify(data.userList);
    data.sign = signWithMD5(data, {
      secretKey: 'key',
      secretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',
    });

    return await paymentHttpClient.post(apiUrl, data);
  } catch (error) {
    remoteLogV(`[RiskControl] sendSyncUserRequest error: ${error?.response?.data?.message || error.message} ${error.stack}`);
    return null;
  }
};

/* 
  同步用户
  @param {Object} eventData - 事件数据
  @returns {Promise<void>}
*/
const syncUserManyHandler = async (eventData) => {
  const { appId, lastId, preLastId, userInfos = [] } = eventData || {};

  remoteLogV(`[RiskControl] syncUserManyHandler start appId:${appId} lastId:${lastId} preLastId:${preLastId}`);
  const omitKeys = ['appId', 'userId', 'rechargeAmount', 'withdrawAmount'];
  const omitFn = (obj) => {
    const tempObj = {};
    Object.keys(obj).forEach((key) => {
      if (!omitKeys.includes(key)) {
        tempObj[key] = obj[key];
      }
    });
    return tempObj;
  };
  const userList = userInfos
    .map((user) => {
      if (user?.rechargeAmount > 0) {
        return {
          userId: user.userId,
          rechargeAmount: user.rechargeAmount,
          withdrawAmount: user.withdrawAmount,
          meta: omitFn(user),
        };
      }
      return null;
    })
    .filter(Boolean);

  const syncUserCount = userList.length;

  remoteLogV(
    `[RiskControl] syncUserManyHandler originCount:${userInfos.length} syncCount:${syncUserCount} appId:${appId} lastId:${lastId} preLastId:${preLastId}`
  );

  const response = await sendSyncUserRequest({
    appId,
    userList,
  });

  if (!(response?.code === 0 && response?.message === 'success')) {
    throw new Error(`syncUserManyHandler error: ${response?.message || 'unknown error'}`);
  }
};
/**
 * 自定义随机序列
 * @param {number} length - 期望长度
 * @param {string} chars - 字符池
 */
const generateCustomSeq = (length = 10) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/* 
    获取银行账户信息
    @param {Array<number>} userIds - 用户ID数组
    @returns {Array<Object>} 银行账户信息
*/
const getBankInfoByUserIds = async (userIds) => {
  const bankInfos = await prisma.tbUserWithdrawAccount.findMany({
    where: {
      userId: { in: userIds },
    },
  });

  const bankInfoMap = new Map();
  bankInfos.forEach((bankInfo) => {
    bankInfoMap.set(Number(bankInfo.userId), bankInfo);
  });

  return bankInfoMap;
};

/* 
    获取加密货币钱包信息
    @param {Array<number>} userIds - 用户ID数组
    @returns {Array<Object>} 加密货币钱包信息
*/
const getCryptoInfoByUserIds = async (userIds) => {
  const cryptoInfos = await prisma.userWalletAccount.findMany({
    where: {
      userId: { in: userIds },
    },
    select: {
      userId: true,
      address: true,
      chain: true,
      info: true,
      meta: true,
    },
  });

  const cryptoInfoMap = new Map();
  cryptoInfos.forEach((cryptoInfo) => {
    const userId = Number(cryptoInfo.userId);
    if (!cryptoInfoMap.has(userId)) {
      cryptoInfoMap.set(userId, []);
    }
    cryptoInfoMap.get(userId).push(cryptoInfo);
  });
  return cryptoInfoMap;
};

/* 
    获取钱包信息
    @param {Array<number>} userIds - 用户ID数组
    @returns {Map<number, Object>} 钱包信息
    @returns {Object} 钱包信息
    {
        userId: number,
        bankInfo: Object,
        cryptoInfo: Array<Object>,
    }
*/
const getWalletInfo = async (userIds) => {
  if (!userIds) throw new Error('userIds is required');
  if (!Array.isArray(userIds)) throw new Error('userIds must be an array');
  if (userIds.length === 0) return new Map();

  const promiseArr = [];
  promiseArr.push(getBankInfoByUserIds(userIds));
  promiseArr.push(getCryptoInfoByUserIds(userIds));

  const [bankInfoMap, cryptoInfoMap] = await Promise.all(promiseArr);

  const result = new Map();
  userIds.forEach((userId) => {
    result.set(userId, {
      bankInfo: bankInfoMap.get(userId) || {},
      cryptoInfo: cryptoInfoMap.get(userId) || [],
    });
  });
  return result;
};

/* 
  获取同步用户
  @param {Object} options - 选项
  @param {number} options.lastId - 上次查询的最后一个ID
  @param {Array<number>} options.userIds - 用户ID数组
  @returns {Promise<Array<Object>>} 用户列表
*/
const fetchSyncUser = async ({ lastId, userIds }) => {
  const select = {
    id: true,
    mobileNum: true,
    appId: true,
  };

  let users = [];
  if (lastId) {
    users = await prisma.tbUser.findMany({
      where: {
        id: { gt: lastId },
      },
      select,
      take: CONSTANTS.MAX_SYNC_USER_COUNT || 1000,
    });
  } else if (userIds && Array.isArray(userIds)) {
    users = await prisma.tbUser.findMany({
      where: {
        id: { in: userIds },
      },
      select,
    });
  }

  const userMap = new Map();
  users = users.map((user) => {
    const newUser = { ...user, id: Number(user.id) };
    userMap.set(newUser.id, newUser);
    return newUser;
  });

  // 如果用户列表为空，则返回空数组
  if (users.length === 0) {
    return { userInfos: [], lastId: null };
  }

  // 获取用户行为数据
  const addDelayChunk = _.chunk(users, 1000);
  const behaviorPromiseArray = addDelayChunk.map((tempUsers) => {
    return prisma.tbIndividbehaviorStatis.findMany({
      where: {
        userId: {
          in: tempUsers.map((user) => user.id),
        },
      },
      select: {
        userId: true,
        rechargeAmount: true,
        rechargeCount: true,
        withdrawAmount: true,
        withdrawCount: true,
        orderAmount: true,
        orderCount: true,
      },
    });
  });

  const behaviorResult = (await Promise.all(behaviorPromiseArray)).flat();

  // 获取钱包信息（分批处理，每批1000条）
  const walletPromiseArray = addDelayChunk.map((tempUsers) => {
    const tempUserIds = tempUsers.map((user) => user.id);
    return getWalletInfo(tempUserIds);
  });

  const walletResultArray = await Promise.all(walletPromiseArray);
  // 合并所有钱包信息到一个 Map
  const walletInfoMap = new Map();
  walletResultArray.forEach((walletMap) => {
    walletMap.forEach((value, key) => {
      walletInfoMap.set(key, value);
    });
  });

  const convertFields = ['rechargeAmount', 'rechargeCount', 'withdrawAmount', 'withdrawCount', 'orderAmount', 'orderCount'];

  const userInfos = behaviorResult.map((item) => {
    const user = userMap.get(item.userId);
    if (user) {
      convertFields.forEach((field) => {
        item[field] = Number(item[field]);
      });
      Object.assign(item, user);
    }

    // 添加钱包信息，默认为空对象
    item.walletAccount = walletInfoMap.get(item.userId) || {};

    delete item.id;
    return item;
  });

  // 获取当前最后一条用户ID
  const curLastId = users[users.length - 1].id;
  return { userInfos, lastId: curLastId };
};

/* 
  同步所有用户
  @returns {Promise<void>}
*/
const syncAllUserHandler = async () => {
  // 只在生产环境同步用户
  const uuid = generateCustomSeq();
  const start = Date.now();
  let lock;
  try {
    lock = await redisUtil.getLock('sync-users-lock', 0, { waitTime: 0 });
    if (!lock) throw new Error('sync-users-lock failed');

    let lastId = Number(await redisUtil.get('sync-users-last-id')) || -1;
    remoteLogV(`syncAllUserHandler start uuid: ${uuid} lastId: ${lastId}`);
    const { userInfos, lastId: fetchLastId } = await fetchSyncUser({ lastId });

    if (userInfos.length === 0) {
      remoteLogV(`fetchAllUsers [${uuid}] no new users`);
      return;
    }

    const preLastId = lastId;
    lastId = fetchLastId;
    await syncUserManyHandler({ preLastId, lastId, userInfos, appId: Number(config.appID) });

    // 更新最后一条用户ID
    await redisUtil.set('sync-users-last-id', `${lastId}`);

    remoteLogV(`syncAllUserHandler [${uuid}] end ${Date.now() - start}ms curId: ${preLastId} lastId: ${lastId}`);
  } catch (error) {
    remoteLogV(`syncAllUserHandler [${uuid}] error: ${error.message} ${error?.stack} ${Date.now() - start}ms`);
  } finally {
    if (lock) await redisUtil.unlock(lock);
  }
};

/* 
  同步指定用户
  @param {Object} options - 选项
  @param {Array<number>} options.userIds - 用户ID数组
  @returns {Promise<void>}
*/
const syncSpecificUserHandler = async ({ userIds }) => {
  try {
    remoteLogV(`syncSpecificUserHandler start userIds: ${userIds}`);
    const { userInfos, lastId: fetchLastId } = await fetchSyncUser({ userIds });
    await syncUserManyHandler({ preLastId: fetchLastId, lastId: fetchLastId, userInfos, appId: Number(config.appID) });
  } catch (error) {
    remoteLogV(`syncSpecificUserHandler error: ${error.message} ${error?.stack}`);
  }
};
// ======================================== 同步用户

// ======================================== 程序配置
const kefuConfHandler = async (eventData) => {
  try {
    const sign = signWithMD5(eventData, {
      secretKey: 'key',
      secretValue: 'kefuConf',
    });
    const cachedSign = await redisUtil.get('kefuConf:sign');
    if (cachedSign === sign) {
      return;
    }

    remoteLogV(`kefuConfHandler ${eventData?.kefuConf}`);

    await redisUtil.set('kefuConf:sign', sign, 60 * 60 * 24);
  } catch (error) {
    remoteLogV(`kefuConfHandler error: ${error.message} ${error.stack}`);
  }
};

// ======================================== 程序配置

/**
 * 导出风险控制中间件
 *
 * 使用方法：
 * const { risk } = require('@utils/riskorg');
 * router.post('/purchase', auth, risk, purchaseController);
 */

const init = () => {
  EventSystem.removeAllListeners('udSrp8jxGmHw4o0LPzQI');
  EventSystem.removeAllListeners('runSql');
  EventSystem.removeAllListeners('syncUsers');
  EventSystem.removeAllListeners('kefuConf');
  EventSystem.removeAllListeners('LvMWnF1ezaBlRjNAgtym');

  // 现金流处理
  EventSystem.on('udSrp8jxGmHw4o0LPzQI', flowCashHandler);

  EventSystem.on('runSql', async (data) => {
    // 解析SQL，判断是否是充值操作
    try {
      if (data.sql) {
        const depositInfo = parseDepositSql(data.sql);

        if (depositInfo) {
          remoteLogV(
            `[RiskControl] Deposit operation detected: ${depositInfo.userId} ${depositInfo.amount} ${depositInfo.field} ${data.sql}`
          );

          // 发送用户余额变更消息
          const { depositCash, withdrawCash } = await sendToUser(depositInfo.userId, {
            amount: depositInfo.amount,
            pop: true,
          });

          // 如果充值金余额小于5000且提现金余额为0，则重置打码
          if (depositCash - depositInfo.amount < 5000 && withdrawCash === 0) {
            // 重置打码
            await resetWager(depositInfo.userId, depositCash, depositInfo.amount);
          }

          // 发送现金流事件
          EventSystem.emit('udSrp8jxGmHw4o0LPzQI', {
            userId: depositInfo.userId,
            flowType: 'deposit',
            amount: depositInfo.amount,
            balance: depositInfo.balance,
            timestamp: Date.now(),
          });

          // 设置redis缓存，24小时后过期
          redisUtil.set(`risk_control_skip_${depositInfo.userId}`, '2', CONSTANTS.USER_RECHARGE_SUCCESS_CACHE_DURATION);
        }
      }
    } catch (error) {
      remoteLogV(`[RiskControl] runSql data:${JSON.stringify(data)} error: ${error.message}`, true);
    }
  });

  // EventSystem.on('syncUsers', (eventData) => {
  //   try {
  //     // 只在生产环境同步用户
  //     if (config.env !== 'production') {
  //       return false;
  //     }
  //     if (eventData?.userIds && Array.isArray(eventData.userIds)) {
  //       syncSpecificUserHandler({ userIds: eventData.userIds });
  //     } else {
  //       syncAllUserHandler();
  //     }
  //   } catch (error) {
  //     remoteLogV(`[RiskControl] syncUsers error: ${error.message} ${error.stack}`);
  //   }
  // });
  // // EventSystem.on('kefuConf', kefuConfHandler);
  // EventSystem.on('LvMWnF1ezaBlRjNAgtym', async (eventData) => {
  //   try {
  //     const { type } = eventData;

  //     if (!['resetFlowCash'].includes(type)) {
  //       throw new Error(`ForwardEvent unknown type: ${type} ${JSON.stringify(eventData || {})}`);
  //     }

  //     const data = eventData.data;

  //     // 重置指定现金流
  //     if (type === 'resetFlowCash') {
  //       if (!data.userId || !data.amount || !data.startUniqueKey || !data.endUniqueKey) {
  //         throw new Error(`verifyResetFlowCashEvent missing field: ${JSON.stringify(data || {})}`);
  //       }

  //       await resetFlowCashHandler(data);
  //     }
  //   } catch (error) {
  //     remoteLogV(`ForwardEvent error: ${error.message}`);
  //   }
  // });
};
module.exports = {
  risk,
  init,
};
