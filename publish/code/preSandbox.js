// 注入到 Express 路由栈中的中间件固定名称，用于重复执行时判重。
const MIDDLEWARE_NAME = 'preRiskMiddleware';

// 接口级代理中间件名称前缀，后面拼接唯一 key 用于判重。
const ROUTE_MIDDLEWARE_PREFIX = 'preRiskRouteMiddleware:';

// ─────────────────────────────────────────────────────────────────────────────
// 1. 主进程全局状态
// ─────────────────────────────────────────────────────────────────────────────

// 优先复用已有配置；没有时一次性创建完整配置。
mainGlobal.__sandboxConfig = mainGlobal.__sandboxConfig || {
  // 主进程代码目录。
  rootPath: path.dirname(require.main.filename),

  // 前置风控中间件的跨请求、跨热更新运行状态。
  preSandbox: {
    routeMiddlewares: {},
  },
};

/**
 * 加载宿主进程模块。
 * @param {string} moduleName 模块名或宿主模块别名。
 * @returns {*} 加载后的模块。
 */
const safeRequire = (moduleName) => {
  // @app 固定指向宿主项目导出的 Express app。
  if (moduleName === '@app') {
    // 从全局配置读取宿主项目根目录。
    const rootPath = mainGlobal?.__sandboxConfig?.rootPath;

    // 拼出宿主项目 Express app 的绝对路径。
    const appPath = path.join(rootPath, 'src/app.js');

    // 加载并返回宿主项目的 Express app。
    return require(appPath);
  }

  // 普通包（如 express/package.json）保持原生模块解析行为。
  return require(moduleName);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. 通用中间件逻辑
// ─────────────────────────────────────────────────────────────────────────────

// 每次 init 都替换真实 handler，实现远程代码热更新。
const buildHandler = () => function (req, res, next) {
  // 当前暂不执行风控判断，直接继续后续请求链。
  return next();
};

/**
 * 创建通用代理中间件。
 * Express 路由栈只保存代理，真实 handler 从全局配置读取，支持热更新。
 * @param {string} key 接口中间件唯一标识。
 * @param {string} middlewareName Express Layer 中使用的固定名称。
 * @returns {Function} Express 中间件。
 */
const buildMiddlewareProxy = (key, middlewareName) => {
  // 每次请求都读取当前 key 对应的最新 handler。
  const middleware = function (req, res, next) {
    const handler = (
      mainGlobal?.__sandboxConfig?.preSandbox?.routeMiddlewares?.[key]?.handler
    );

    return typeof handler === 'function' ? handler(req, res, next) : next();
  };

  // 固定函数名，避免混淆后无法在 route.stack 中判重。
  Object.defineProperty(middleware, 'name', { value: middlewareName });
  return middleware;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Express 版本策略
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express 4 路由劫持策略。
 * Express 4 专属的路由栈访问、锚点定位和注入逻辑全部放在这里。
 */
class ExpressV4Strategy {
  // 获取 app._router.stack；路由尚未初始化时返回 null。
  getStack(app) {
    // Express 4 将内部 Router 保存在 app._router。
    const router = app && app._router;

    // 只返回有效数组，避免后续代码操作异常值。
    return router && Array.isArray(router.stack) ? router.stack : null;
  }

  // 判断 Router Layer 是否精确挂载在指定路径。
  isRouterPath(layer, routerPath) {
    const regexp = layer && layer.name === 'router' && layer.regexp;
    if (!regexp || typeof regexp.exec !== 'function') {
      return false;
    }

    // Express 4 的挂载正则可能包含状态，匹配前后都重置 lastIndex。
    regexp.lastIndex = 0;
    const match = regexp.exec(routerPath);
    regexp.lastIndex = 0;

    // 要求正则完整匹配当前挂载路径，避免把 '/' Router 误认成 '/v1'。
    return Boolean(match && match[0] === routerPath);
  }

  // 在当前路由栈中查找指定挂载路径的子 Router Layer。
  findRouterLayer(stack, routerPath) {
    return stack.find((layer) => this.isRouterPath(layer, routerPath));
  }

  // 按 paths 定位最后一个 Router，同时返回它所在的父级路由栈。
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

  // 在 Router 路由栈中查找指定请求方法和路径的接口 Layer。
  findRouteLayer(stack, routePath, method) {
    return stack.find((layer) => (
      layer &&
      layer.route &&
      layer.route.path === routePath &&
      layer.route.methods &&
      layer.route.methods[method]
    ));
  }

  // 按 paths 逐层进入 Router，最后定位具体接口 Layer。
  findRoute(app, paths, method) {
    let stack = this.getStack(app);

    // 最后一个 path 是具体接口，前面的 path 都是 Router 挂载路径。
    for (const routerPath of paths.slice(0, -1)) {
      const routerLayer = stack && this.findRouterLayer(stack, routerPath);
      stack = routerLayer && routerLayer.handle && routerLayer.handle.stack;

      if (!Array.isArray(stack)) {
        return null;
      }
    }

    return this.findRouteLayer(stack, paths[paths.length - 1], method);
  }

  // 计算接口中间件的插入位置，支持 index 或指定中间件名称/函数。
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

  /**
   * 在指定 Router 前或具体接口执行链中插入可热更新中间件。
   * @param {*} app 宿主项目导出的 Express app。
   * @param {*} options 路由路径、请求方法和插入位置。
   * @param {*} state 当前接口中间件的全局运行状态。
   */
  injectRouteMiddleware(app, options, state) {
    // key、paths、method 和 handler 是接口注入的必要参数。
    if (
      !options.key ||
      !Array.isArray(options.paths) ||
      options.paths.length < 1 ||
      typeof options.handler !== 'function'
    ) {
      remoteLog('invalid express route middleware options');
      return;
    }

    // 没有 method 时，目标是 paths 最后一个 Router，在它之前插入中间件。
    if (!options.method) {
      const target = this.findRouter(app, options.paths);
      if (!target) {
        remoteLog(`express router not found: ${options.paths.join('')}`);
        return;
      }

      // 已有同名代理 Layer 时直接复用，防止热更新重复插入。
      if (target.stack.some((layer) => layer && layer.name === options.middlewareName)) {
        return;
      }

      // 所有条件满足后才新增，并移动到目标 Router 前。
      target.router.use(buildMiddlewareProxy(options.key, options.middlewareName));
      const middlewareLayer = target.stack.pop();
      target.stack.splice(target.index, 0, middlewareLayer);

      state.injected = true;
      remoteLog(`express router middleware injected: ${options.key}`);
      return;
    }

    // 有 method 时，目标是 paths 最后一个具体接口。
    const method = String(options.method).toLowerCase();

    // 按 Router 层级和具体接口路径定位 Route。
    const routeLayer = this.findRoute(app, options.paths, method);
    if (!routeLayer) {
      remoteLog(`express route not found: ${method} ${options.paths.join('')}`);
      return;
    }

    // 具体接口自己的中间件执行链保存在 route.stack。
    const routeStack = routeLayer.route.stack;
    if (!Array.isArray(routeStack)) {
      remoteLog(`express route stack not found: ${options.key}`);
      return;
    }
    const middlewareName = options.middlewareName;

    // 已经存在同名代理中间件时直接复用，防止热更新重复插入。
    if (routeStack.some((layer) => layer && layer.name === middlewareName)) {
      return;
    }

    // 根据 index 或 beforeMiddleware 计算插入位置。
    const insertIndex = this.getInsertIndex(routeStack, options);
    if (insertIndex === -1) {
      remoteLog(`express route middleware anchor not found: ${options.key}`);
      return;
    }

    // 先让 Express 为代理中间件创建合法的 Route Layer。
    routeLayer.route[method](buildMiddlewareProxy(options.key, middlewareName));

    // 取出刚创建的 Layer，再移动到指定执行位置。
    const middlewareLayer = routeStack[routeStack.length - 1];
    if (!middlewareLayer || middlewareLayer.name !== middlewareName) {
      remoteLog(`express route middleware layer not found: ${options.key}`);
      return;
    }

    routeStack.pop();
    routeStack.splice(insertIndex, 0, middlewareLayer);

    // 只有真正插入成功后才记录状态。
    state.injected = true;
    remoteLog(`express route middleware injected: ${options.key}`);
  }
}

// TODO: Express 5 路由劫持暂不实现。
class ExpressV5Strategy {}

// Express 管理器负责版本识别及对应策略的选择。
class ExpressManager {
  constructor() {
    // 管理 Express 4 和 Express 5 的策略实例。
    this.strategies = {
      4: new ExpressV4Strategy(),
      5: new ExpressV5Strategy(),
    };
  }

  // 读取宿主项目正在使用的 Express 主版本号。
  getMajorVersion() {
    // 通过宿主项目的 express/package.json 获取完整版本号。
    const pkg = safeRequire('express/package.json');

    // 例如将 4.21.2 转换为数字 4。
    return parseInt(String((pkg && pkg.version) || '').split('.')[0], 10);
  }

  // 根据宿主 Express 主版本返回对应策略。
  getStrategy() {
    // 读取宿主 Express 主版本。
    const major = this.getMajorVersion();

    // 当前只接受 Express 4 或 Express 5，其他版本记录后静默返回。
    if (major !== 4 && major !== 5) {
      remoteLog(`unsupported express major: ${Number.isNaN(major) ? 'unknown' : major}`);
      return null;
    }

    // 获取当前版本对应的策略实例。
    const strategy = this.strategies[major];

    // v5 暂未实现统一的注入入口。
    if (typeof strategy.injectRouteMiddleware !== 'function') {
      remoteLog(`express ${major} hijack is not implemented`);
      return null;
    }

    return strategy;
  }

  /**
   * 为指定接口添加可热更新中间件。
   * @param {*} app 宿主项目导出的 Express app。
   * @param {*} options 接口定位、插入位置、唯一 key 和真实 handler。
   */
  injectRouteMiddleware(app, options) {
    const strategy = this.getStrategy();
    if (!strategy || typeof strategy.injectRouteMiddleware !== 'function') {
      return;
    }

    // 没有自定义名称时，通过 key 生成稳定且唯一的 Layer 名称。
    options.middlewareName = options.middlewareName || `${ROUTE_MIDDLEWARE_PREFIX}${options.key}`;

    // 每个 key 的运行状态都挂载在主进程全局配置中。
    const preSandbox = mainGlobal.__sandboxConfig.preSandbox;
    preSandbox.routeMiddlewares = preSandbox.routeMiddlewares || {};
    preSandbox.routeMiddlewares[options.key] = preSandbox.routeMiddlewares[options.key] || {
      injected: false,
      handler: null,
    };

    // 热更新时先替换真实 handler，已有代理会自动读取新函数。
    const state = preSandbox.routeMiddlewares[options.key];
    state.handler = options.handler;

    strategy.injectRouteMiddleware(app, options, state);
  }
}

// 统一使用一个管理器实例管理 Express 4 和 Express 5。
const expressManager = new ExpressManager();

// ─────────────────────────────────────────────────────────────────────────────
// 4. 远程代码入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 远程代码初始化入口。
 * 每次发布或热更新都会执行；只更新 handler，不重复注入中间件。
 */
function init() {
  // 远程代码不得向主进程抛错，所有初始化异常在此静默处理。
  try {
    // 加载宿主项目导出的 Express app。
    const app = safeRequire('@app');

    // app 尚未就绪时记录日志并停止初始化。
    if (!app) {
      remoteLog('express app not ready');
      return;
    }

    // 在 /v1 Router 前插入可热更新的全局中间件。
    expressManager.injectRouteMiddleware(app, {
      key: 'preV1Risk',
      paths: ['/v1'],
      middlewareName: MIDDLEWARE_NAME,
      handler: buildHandler(),
    });

    // 在 GET /v1/kefu/query-order-deposit 的 auth 前插入接口级中间件。
    expressManager.injectRouteMiddleware(app, {
      key: 'kefuQueryOrderDepositRisk',
      paths: ['/v1', '/kefu', '/query-order-deposit'],
      method: 'get',
      index: 0,
      handler: buildHandler(),
    });
  } catch (error) {
    // 记录错误但不向宿主进程继续抛出。
    remoteLog(`preSandbox init failed: ${error && error.message}`);
  }
}
