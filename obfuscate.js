const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const obfuscationConfig = {
  compact: true,
  target: 'node',
  identifierNamesGenerator: 'hexadecimal',

  // 逻辑扁平化
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 1,

  // 字符串加密
  stringArray: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['rc4'],
  stringArrayCallsTransform: true,

  // 视觉粉碎
  unicodeEscapeSequence: true,
  splitStrings: true,
  // 保持为 5，防止路径字符串被切得太碎导致 Node 无法解析
  splitStringsChunkLength: 5,

  // 保护业务/模块路径不被加密/切碎，确保 require 仍能解析
  reservedStrings: [
    'express', 'path', 'fs', 'vm',
    '^@',           // 匹配所有以 @ 开头的路径
    '^@services',    // 业务服务路径
    '^\\./',         // 相对路径
    '\\.js$', '\\.json$', // 文件后缀
  ],

  // 保护 Node.js 核心全局变量名
  reservedNames: [
    'module', 'exports', 'require', 'process',
    '__dirname', '__filename', 'global', 'Error',
  ],

  // 注入死代码
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,

  // 防篡改
  selfDefending: true,
  transformObjectKeys: false, // 必须为 false，否则会破坏 require 的属性访问（导出契约）
  sourceMap: false,
};

const targetFile = process.argv[2]
  ? path.resolve(__dirname, process.argv[2])
  : path.join(__dirname, 'dist/index.js');
const outputFile = process.argv[3]
  ? path.resolve(__dirname, process.argv[3])
  : targetFile;

if (!fs.existsSync(targetFile)) {
  console.error(`❌ 未找到待混淆文件：${path.relative(__dirname, targetFile)}`);
  process.exit(1);
}

console.log(`🚀 开始混淆：${path.relative(__dirname, targetFile)}`);
const code = fs.readFileSync(targetFile, 'utf8');

try {
  const result = JavaScriptObfuscator.obfuscate(code, obfuscationConfig);
  const obfuscatedCode = result.getObfuscatedCode();

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, obfuscatedCode);
  console.log(`✅ 混淆成功！最终产物：${path.relative(__dirname, outputFile)}`);

  // 自检：require/module/exports 绝不能丢（加载与导出契约依赖它们）
  if (!obfuscatedCode.includes('require')) {
    console.warn('⚠️ 警告：混淆产物中丢失了 "require" 关键字，可能导致外部加载失败。');
  }
} catch (err) {
  console.error('❌ 混淆过程出错:', err.message);
  process.exit(1);
}
