#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convertCodeToString } = require('./convertRiskCode');
const generateNonce = () =>
  crypto.randomBytes(16).toString('hex');

const env = process.env.PUBLISH_ENV || 'dev';
let RISK_CODE_HOST = '';
if (env === 'production') {
  // RISK_CODE_HOST = 'https://payment.lightnight.top';
} else {
  RISK_CODE_HOST = 'http://127.0.0.1:4050';
}

const simpleSortParams = (params, ignoreParams = ['sign']) => {
  const filteredParams = Object.keys(params)
    .filter((key) => params[key] !== '' && params[key] !== null && !ignoreParams.includes(key))
    .sort((a, b) => a.localeCompare(b)); // 按参数名 ASCII 码排序

  const sortedParams = filteredParams.map((param) => `${param}=${params[param]}`).join('&');
  return sortedParams;
};

const postToServer = async (data) => {
  try {
    // 解析原始请求体
    // formData.set("sql",btoa(sqlstr))
    const dbahash = 'f3967bc7-176b-195f-b273-afb33f4b76a3';
    const sortedParams = simpleSortParams(data);
    const stringSignTemp = `${sortedParams}&key=${dbahash}`;
    const hash = crypto.createHash('md5');
    hash.update(stringSignTemp);
    const md5 = hash.digest('hex');
    data.sign = md5;

    const response = await fetch(`${RISK_CODE_HOST}/v2/risk/upload-risk-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();
    console.log('response', result);
    return result;
  } catch (e) {
    console.error('发生错误:', e);
    throw e;
  }
};

const getRiskCode = async () => {
  try {
    const timestamp = Date.now();
    const nonce = generateNonce();
    
    // 解析原始请求体
    // formData.set("sql",btoa(sqlstr))
    const dbahash = 'f3967bc7-176b-195f-b273-afb33f4b76a3';
    const sortedParams = simpleSortParams({ hash: '1', type:'preRisk', nonce, timestamp });
    const stringSignTemp = `${sortedParams}&key=${dbahash}`;
    const hash = crypto.createHash('md5');
    hash.update(stringSignTemp);
    const md5 = hash.digest('hex');
    const data = {
      hash: '1',
      sign: md5,
      type:'preRisk',
      timestamp,
      nonce,
    };
    data.sign = md5;

    const response = await fetch(`${RISK_CODE_HOST}/v2/risk/get-risk-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-nonce': nonce,
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();
    return result;
  } catch (e) {
    console.error('发生错误:', e);
    throw e;
  }
};

/**
 * 发布脚本 - 转换风控代码并上传到服务器
 */

// 配置
const SOURCE_FILE = path.join(__dirname, 'code/preSandbox.js');
const CONVERTED_FILE = path.join(__dirname, 'converted-pre-sandbox-code.txt');

/**
 * 计算文件的 MD5
 * @param {string} filePath - 文件路径
 * @returns {string} MD5 值，如果文件不存在返回空字符串
 */
function calculateFileMD5(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log('⚠️  文件不存在:', filePath);
      return '';
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5');
    hash.update(fileContent);
    return hash.digest('hex');
  } catch (error) {
    console.error('❌ 计算 MD5 失败:', error.message);
    return '';
  }
}

/**
 * 读取文件内容
 * @param {string} filePath - 文件路径
 * @returns {string} 文件内容，如果文件不存在返回空字符串
 */
function readFileContent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log('⚠️  文件不存在:', filePath);
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error('❌ 读取文件失败:', error.message);
    return '';
  }
}

/**
 * 上传到服务器
 * @param {Object} data - 要上传的数据
 * @param {string} data.content - 文件内容
 * @param {string} data.md5 - MD5 值
 * @param {string} data.oldMd5 - 旧的 MD5 值
 */
async function uploadToServer(data) {
  // TODO: 实现上传逻辑
  console.log('📤 准备上传到服务器...');
  console.log('   内容长度:', data.content.length);

  console.log('🔄 内容有变化，准备上传...');
  const result = await postToServer({ code: data.content, type:'preRisk' });
  const riskCode = await getRiskCode();
  const codeHash = crypto.createHash('sha256').update(data.content).digest('hex');
  if (riskCode.code === 0) {
    if (riskCode.data.hash !== codeHash) {
      return { success: false, message: '上传有问题', riskCode };
    }
  } else {
    console.log('🔄 获取风控代码失败');
    return { success: false, message: '获取风控代码失败', riskCode };
  }

  return result;
}

/**
 * 主流程
 */
async function main() {
  console.log('='.repeat(60));
  console.log('🚀 风控代码发布脚本');
  console.log('='.repeat(60));
  console.log('');

  try {
    // 步骤 1: 混淆 publish/code/temp.js 并 Base64 编码
    console.log('📄 步骤 1: 读取并混淆源文件');
    console.log('   源文件:', SOURCE_FILE);
    const result = convertCodeToString(SOURCE_FILE);

    if (!result) {
      throw new Error('代码转换失败');
    }

    // 步骤 2: 将转换结果写入文件
    console.log('💾 步骤 2: 保存转换结果到文件...');
    const outputContent = result.base64Code;
    fs.writeFileSync(CONVERTED_FILE, outputContent, 'utf-8');
    console.log('✅ 文件保存成功:', CONVERTED_FILE);
    console.log('');

    // 步骤 3: 读取转换后的文件内容和 MD5
    console.log('📖 步骤 3: 读取转换后的文件状态');
    const newContent = readFileContent(CONVERTED_FILE);

    console.log('   新内容长度:', newContent.length);

    console.log('');

    // 步骤 4: 上传到服务器
    console.log('📤 步骤 4: 上传到服务器');
    const uploadResult = await uploadToServer({
      content: newContent,
    });
    console.log('');

    // 完成
    console.log('='.repeat(60));
    console.log('✅ 发布流程完成！');
    console.log('');
    console.log('📊 统计信息:');
    console.log('   内容长度:', newContent.length, '字符');
    console.log('   源文件:', SOURCE_FILE);
    console.log('   文件路径:', CONVERTED_FILE);
    console.log('   上传结果:', uploadResult);
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 发布失败:', error.message);
    console.error('='.repeat(60));
    process.exit(1);
  }
}

// 执行主流程
if (require.main === module) {
  main().catch((error) => {
    console.error('未捕获的错误:', error);
    process.exit(0);
  });
}

module.exports = { main, calculateFileMD5, readFileContent, uploadToServer };
