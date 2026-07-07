
const rootPath = mainGlobal.runRootDir;
const path = require('path');
// @ 别名映射表（与 jsconfig.json 的 paths 保持一致）
// 例如 @services/pay/config -> <rootPath>/src/services/pay/config
const ALIAS_MAP = {
  '@libs': 'src/libs',
  '@controllers': 'src/controllers',
  '@models': 'src/models',
  '@routes': 'src/routes',
  '@middlewares': 'src/middlewares',
  '@validations': 'src/validations',
  '@services': 'src/services',
  '@config': 'src/config',
  '@utils': 'src/utils',
  '@app': 'src/app.js',
};

// 将 @ 别名解析为基于根目录的绝对路径；非别名或缺少根目录时原样返回，
// 交还给 require 自带的 module-alias 解析。
const resolveModuleName = (moduleName) => {
  if (!rootPath || typeof moduleName !== 'string' || moduleName[0] !== '@') {
    return moduleName;
  }
  const slashIndex = moduleName.indexOf('/');
  const alias = slashIndex === -1 ? moduleName : moduleName.slice(0, slashIndex);
  const target = ALIAS_MAP[alias];
  if (!target) {
    return moduleName;
  }
  const rest = slashIndex === -1 ? '' : moduleName.slice(slashIndex + 1);
  return path.join(rootPath, target, rest);
};

const safeRequire = (moduleName) => {
  // @ 别名转为绝对路径，其余（lodash / 内置模块等）原样交给主模块 require。
  return require(resolveModuleName(moduleName));
};

const expressPackge = safeRequire('express/package.json');

const expressUtil = {
  v4:{
    // 首次hajack
    firstHijack: function(){
      
    },
    // 初始化 express
    initExpress: function(){
      if(globalThis.__initExpress) {
        return;
      }
      globalThis.__initExpress = true;
    }
  },
  // 检查 express 版本（.test 是 RegExp 方法，不能写在 String 上）
  checkVersion: (type = 'v4') => {
    const version = String(expressPackge?.version || '');
    if (type === 'v4') {
      return /^4\./.test(version);
    }
    return /^5\./.test(version);
  },

  // 获取 express 工具（当前仅实现 v4）
  getUtil: () => {
    if (!expressUtil.checkVersion('v4')) {
      throw new Error(`expected express 4.x, got ${expressPackge?.version || 'unknown'}`);
    }
    return expressUtil.v4;
  },
}

function init() {
  try {
    const util = expressUtil.getUtil();

    // remoteLog(`express version ${typeof expressPackge?.version} is supported`);
    


    // 如果 express 版本大于 5.x 版本，则抛出错误
    // if(expressUtil.checkVersion('v5')) {
    //   throw new Error('express 版本不能大于 5.x 版本');
    // }

    // const expressUtil = expressUtil.getUtil();
    // expressUtil.initExpress();
  } catch (error) {
    remoteLog(`express init failed (package=${expressPackge?.version}): ${error.message}`);
  }
}
