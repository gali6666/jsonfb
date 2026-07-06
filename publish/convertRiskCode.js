#!/usr/bin/env node

const fs = require('fs');
const JavaScriptObfuscator = require('javascript-obfuscator');

/**
 * 风控代码转换工具 - 先混淆再使用 Base64 编码
 * 混淆代码可以保护源代码逻辑
 * Base64 可以完全避免转义问题
 */

function convertCodeToString(filePath) {
  console.log('正在读取文件:', filePath);

  if (!fs.existsSync(filePath)) {
    console.error('❌ 文件不存在:', filePath);
    return null;
  }

  // 读取代码
  let code = fs.readFileSync(filePath, 'utf-8');

  console.log('✅ 文件读取成功，共', code.length, '个字符');

  // 移除 module.exports 部分（用于沙箱环境）
  // 匹配: module.exports = { ... }; 或 module.exports = ...;
  const originalLength = code.length;
  code = code.replace(/\nmodule\.exports\s*=\s*\{[^}]*\};?\s*$/m, '');
  code = code.replace(/\nmodule\.exports\s*=\s*[^;]*;?\s*$/m, '');

  if (code.length < originalLength) {
    console.log('✅ 已移除 module.exports (减少', originalLength - code.length, '个字符)');
  }

  console.log('📝 处理后代码长度:', code.length, '个字符\n');

  // 步骤1: 混淆代码
  console.log('🔒 开始混淆代码...');
  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
    compact: true, // 压缩代码
    controlFlowFlattening: true, // 控制流扁平化
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true, // 注入死代码
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false, // 调试保护（可能影响生产环境）
    debugProtectionInterval: 0,
    disableConsoleOutput: false, // 不禁用console
    identifierNamesGenerator: 'hexadecimal', // 标识符名称生成器
    log: false,
    numbersToExpressions: true, // 将数字转换为表达式
    renameGlobals: false, // 不重命名全局变量
    selfDefending: true, // 自我防御
    simplify: true, // 简化代码
    splitStrings: true, // 分割字符串
    splitStringsChunkLength: 10,
    stringArray: true, // 字符串数组化
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'], // 字符串数组编码
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true, // 转换对象键
    unicodeEscapeSequence: false, // 不使用Unicode转义（保持可读性）
  });

  const obfuscatedCode = obfuscationResult.getObfuscatedCode();
  console.log('✅ 代码混淆完成');
  console.log('混淆前长度:', code.length);
  console.log('混淆后长度:', obfuscatedCode.length);
  console.log('混淆代码预览:\n');
  console.log(obfuscatedCode.substring(0, 150) + '...\n');

  // 步骤2: 使用 Base64 编码
  console.log('📝 使用 Base64 编码...');
  const base64Code = Buffer.from(obfuscatedCode, 'utf-8').toString('base64');

  console.log('✅ Base64 编码完成');
  console.log('编码后长度:', base64Code.length);
  console.log('Base64 预览:\n');
  console.log(base64Code.substring(0, 100) + '...\n');

  return {
    base64Code,
    obfuscatedCode,
    originalCode: code,
  };
}

module.exports = { convertCodeToString };
