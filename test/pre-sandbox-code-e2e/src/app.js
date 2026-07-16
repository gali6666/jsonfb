'use strict';

const express = require('express');

const app = express();
const v1Router = express.Router();
const kefuRouter = express.Router();

// 记录一次请求的真实执行顺序，便于 HTTP 黑盒断言。
app.use((req, res, next) => {
  req.preSandboxTrace = [];
  next();
});

// 模拟宿主项目的 auth() 工厂，并让返回函数保留稳定名称。
const auth = () => function auth(req, res, next) {
  req.preSandboxTrace.push('auth');
  next();
};

// 模拟真实目标接口：router.get('/query-order-deposit', auth(), controller)。
kefuRouter.get('/query-order-deposit', auth(), (req, res) => {
  req.preSandboxTrace.push('controller');
  res.json({ trace: req.preSandboxTrace });
});

// 未配置的接口，用来证明接口级代理不会错误挂载到其它路由。
kefuRouter.get('/untouched', (req, res) => {
  req.preSandboxTrace.push('untouched');
  res.json({ trace: req.preSandboxTrace });
});

v1Router.use('/kefu', kefuRouter);
app.use('/v1', v1Router);

// 递归收集整棵 Express 路由树的 Layer 名称，检查任何层级都没有残留代理。
const collectLayerNames = (stack) => stack.flatMap((layer) => {
  const childStack = layer.route?.stack || layer.handle?.stack;
  return [layer.name].concat(Array.isArray(childStack) ? collectLayerNames(childStack) : []);
});

// 暴露真实 Express 4 路由栈统计，验证远程代码没有重复注入代理 Layer。
app.get('/__test/state', (req, res) => {
  const appStack = app._router.stack;
  const v1Layer = appStack.find((layer) => layer.name === 'router' && layer.regexp.test('/v1'));
  const kefuLayer = v1Layer.handle.stack.find(
    (layer) => layer.name === 'router' && layer.regexp.test('/kefu')
  );
  const routeLayer = kefuLayer.handle.stack.find(
    (layer) => layer.route && layer.route.path === '/query-order-deposit'
  );
  const routeMiddlewares = global.__sandboxConfig?.preSandbox?.routeMiddlewares || {};
  const allLayerNames = collectLayerNames(appStack);
  const allProxyNames = allLayerNames.filter(
    (name) => name === 'preRiskMiddleware' || name.startsWith('preRiskRouteMiddleware:')
  );

  res.json({
    revision: global.__preSandboxTestRevision,
    initCount: global.__preSandboxTestInitCount,
    globalProxyCount: appStack.filter((layer) => layer.name === 'preRiskMiddleware').length,
    routeProxyCount: routeLayer.route.stack.filter(
      (layer) => layer.name === 'preRiskRouteMiddleware:kefuQueryOrderDepositRisk'
    ).length,
    allRouteProxyCount: routeLayer.route.stack.filter(
      (layer) => layer.name.startsWith('preRiskRouteMiddleware:')
    ).length,
    allProxyNames,
    totalProxyCount: allProxyNames.length,
    routeStack: routeLayer.route.stack.map((layer) => layer.name),
    states: Object.fromEntries(
      Object.entries(routeMiddlewares).map(([key, value]) => [
        key,
        { injected: value.injected, handlerType: typeof value.handler },
      ])
    ),
  });
});

module.exports = app;
