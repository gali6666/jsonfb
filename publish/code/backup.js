const rootPath = mainGlobal.runRootDir;

// Host-side aliases. Alias modules are resolved from the consumer app root.
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

// Keep path joining dependency-free for remote code while tolerating extra slashes.
const joinRootPath = (basePath, targetPath, restPath) => {
  const normalizedRoot = String(basePath).replace(/[\\/]+$/, '');
  const normalizedTarget = String(targetPath).replace(/^[\\/]+|[\\/]+$/g, '');
  const normalizedRest = String(restPath || '').replace(/^[\\/]+/, '');
  return [normalizedRoot, normalizedTarget, normalizedRest].filter(Boolean).join('/');
};

// Resolve only known @ aliases; normal modules such as express keep native require behavior.
const resolveAliasModulePath = (moduleName) => {
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
  return joinRootPath(rootPath, target, rest);
};

const safeRequire = (moduleName) => {
  return require(resolveAliasModulePath(moduleName));
};

// Express 4 and 5 expose different router internals; keep version details isolated here.
const expressUtil = {
  major() {
    try {
      const pkg = safeRequire('express/package.json');
      return parseInt(String((pkg && pkg.version) || '').split('.')[0], 10);
    } catch (error) {
      remoteLog(`express package read failed: ${error && error.message}`);
      return NaN;
    }
  },

  v4: {
    getStack(app) {
      return app && app._router && Array.isArray(app._router.stack) ? app._router.stack : null;
    },
    findV1Anchor(stack) {
      return stack.findIndex((layer) => (
        layer &&
        layer.name === 'router' &&
        layer.regexp &&
        typeof layer.regexp.test === 'function' &&
        layer.regexp.test('/v1')
      ));
    },
  },

  v5: {
    getStack(app) {
      const router = app && (app.router || app._router);
      return router && Array.isArray(router.stack) ? router.stack : null;
    },
    findV1Anchor(stack) {
      return stack.findIndex((layer) => layer && layer.name === 'router');
    },
  },

  getUtil() {
    const major = this.major();
    if (major !== 4 && major !== 5) {
      remoteLog(`unsupported express major: ${Number.isNaN(major) ? 'unknown' : major}`);
      return null;
    }
    return major === 5 ? this.v5 : this.v4;
  },
};

const getGlobal = () => {
  const g = (mainGlobal.__preSandbox = mainGlobal.__preSandbox || {});
  // Runtime state must survive remote-code hot updates, so initialize missing fields only.
  if (!Object.prototype.hasOwnProperty.call(g, 'injected')) {
    g.injected = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g, 'hijacked')) {
    g.hijacked = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g, 'handler')) {
    g.handler = null;
  }
  return g;
};

// Real pre-risk logic lives behind the injected shell and can be replaced on each init.
const buildHandler = () => function preRiskHandler(req, res, next) {
  return next();
};

const injectOnce = (app, util, g) => {
  const stack = util.getStack(app);
  if (!stack) {
    remoteLog('express router stack not ready');
    return;
  }

  if (g.injected || stack.some((layer) => layer && layer.name === 'preRiskMiddleware')) {
    g.injected = true;
    return;
  }

  // The injected shell stays stable in Express; g.handler is the hot-update target.
  const preRiskMiddleware = function (req, res, next) {
    const h = mainGlobal.__preSandbox && mainGlobal.__preSandbox.handler;
    return typeof h === 'function' ? h(req, res, next) : next();
  };
  Object.defineProperty(preRiskMiddleware, 'name', { value: 'preRiskMiddleware' });

  // Add through Express first so it creates a valid layer, then move it before /v1.
  const beforeLength = stack.length;
  app.use(preRiskMiddleware);
  const layer = stack[stack.length - 1];
  if (stack.length <= beforeLength || !layer || layer.name !== 'preRiskMiddleware') {
    remoteLog('preRiskMiddleware layer not found after app.use');
    return;
  }

  stack.pop();
  const anchor = util.findV1Anchor(stack);
  if (anchor !== -1) {
    stack.splice(anchor, 0, layer);
  } else {
    stack.push(layer);
  }

  g.injected = true;
  g.hijacked = true;
  remoteLog('preRiskMiddleware injected');
};

function init() {
  try {
    const g = getGlobal();
    const util = expressUtil.getUtil();
    if (!util) {
      return;
    }

    const app = safeRequire('@app');
    if (!app) {
      remoteLog('express app not ready');
      return;
    }

    g.handler = buildHandler();
    injectOnce(app, util, g);
  } catch (error) {
    remoteLog(`preSandbox init failed: ${error && error.message}`);
  }
}
