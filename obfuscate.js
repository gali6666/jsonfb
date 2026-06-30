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

const targetFile = path.join(__dirname, 'dist/index.js');

if (!fs.existsSync(targetFile)) {
  console.error('❌ 未找到构建后的 dist/index.js，请先运行 rollup -c');
  process.exit(1);
}

console.log('🚀 开始对单文件产物进行地狱级混淆...');
const code = fs.readFileSync(targetFile, 'utf8');

try {
  const result = JavaScriptObfuscator.obfuscate(code, obfuscationConfig);
  const obfuscatedCode = result.getObfuscatedCode();

  fs.writeFileSync(targetFile, obfuscatedCode);
  console.log('✅ 单文件混淆成功！最终产物：dist/index.js');

  // 自检：require/module/exports 绝不能丢（加载与导出契约依赖它们）
  if (!obfuscatedCode.includes('require')) {
    console.warn('⚠️ 警告：混淆产物中丢失了 "require" 关键字，可能导致外部加载失败。');
  }
} catch (err) {
  console.error('❌ 混淆过程出错:', err.message);
  process.exit(1);
}
