'use strict';

/**
 * 独立远程代码服务：使用生产转换器处理 preSandbox.js，再真实下发给 jsonfb。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { convertCodeToString } = require('../../publish/convertRiskCode');
const { verifySign } = require('../remote-mock-server/sign');

const SECRET_KEY = 'key';
const SECRET_VALUE = 'f3967bc7-176b-195f-b273-afb33f4b76a3';
const sourcePath = path.resolve(__dirname, '..', '..', 'publish', 'code', 'preSandbox.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');

// 为测试版本追加最小标记或额外调用；主体始终来自真实 preSandbox.js。
const buildSource = (revision) => {
  // pure 版本逐字使用生产 preSandbox.js，不追加任何测试代码。
  if (revision === 'pure') {
    return sourceCode;
  }

  let extension = `
const originalInitForRevision = init;
init = function () {
  const beforeStates = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares;
  const beforeHandlers = Object.fromEntries(
    Object.entries(beforeStates).map(([key, state]) => [key, state.handler])
  );
  originalInitForRevision();
  mainGlobal.__preSandboxTestRevision = ${JSON.stringify(revision)};
  mainGlobal.__preSandboxTestInitCount = (mainGlobal.__preSandboxTestInitCount || 0) + 1;
  const states = mainGlobal.__sandboxConfig.preSandbox.routeMiddlewares;
  mainGlobal.__preSandboxTestHandlerChanged = {};
  ['preV1Risk', 'kefuQueryOrderDepositRisk'].forEach((key) => {
    const handler = states[key].handler;
    mainGlobal.__preSandboxTestHandlerChanged[key] = beforeHandlers[key] !== handler;
    states[key].handler = function (req, res, next) {
      if (Array.isArray(req.preSandboxTrace)) {
        req.preSandboxTrace.push(key + ':' + ${JSON.stringify(revision)});
      }
      return handler(req, res, next);
    };
  });
};
`;

  // 验证无效 Router、method 和 beforeMiddleware 不会插入 Layer。
  if (revision === 'invalid-targets') {
    extension += `
const previousInitForInvalidTargets = init;
init = function () {
  previousInitForInvalidTargets();
  const app = safeRequire('@app');
  const handler = buildHandler();
  expressManager.injectRouteMiddleware(app, {
    key: 'missingRouter', paths: ['/v1', '/missing'], handler
  });
  expressManager.injectRouteMiddleware(app, {
    key: 'missingMethod', paths: ['/v1', '/kefu', '/query-order-deposit'],
    method: 'post', index: 0, handler
  });
  expressManager.injectRouteMiddleware(app, {
    key: 'missingAnchor', paths: ['/v1', '/kefu', '/query-order-deposit'],
    method: 'get', beforeMiddleware: 'notExistingMiddleware', handler
  });
};
`;
  }

  // 验证 beforeMiddleware 可以把另一个代理插入 auth 前。
  if (revision.startsWith('before-auth')) {
    extension += `
const previousInitForBeforeAuth = init;
init = function () {
  previousInitForBeforeAuth();
  const app = safeRequire('@app');
  expressManager.injectRouteMiddleware(app, {
    key: 'beforeAuthRisk', paths: ['/v1', '/kefu', '/query-order-deposit'],
    method: 'get', beforeMiddleware: 'auth',
    handler: function (req, res, next) {
      if (Array.isArray(req.preSandboxTrace)) {
        req.preSandboxTrace.push('beforeAuthRisk:' + ${JSON.stringify(revision)});
      }
      return next();
    }
  });
};
`;
  }

  // 验证 beforeMiddleware 也支持直接传入目标中间件函数引用。
  if (revision === 'before-auth-function') {
    extension += `
const previousInitForBeforeAuthFunction = init;
init = function () {
  previousInitForBeforeAuthFunction();
  const app = safeRequire('@app');
  const strategy = expressManager.getStrategy();
  const routeLayer = strategy.findRoute(
    app, ['/v1', '/kefu', '/query-order-deposit'], 'get'
  );
  const authHandler = routeLayer.route.stack.find((layer) => layer.name === 'auth').handle;
  expressManager.injectRouteMiddleware(app, {
    key: 'beforeAuthFunctionRisk',
    paths: ['/v1', '/kefu', '/query-order-deposit'],
    method: 'get',
    beforeMiddleware: authHandler,
    handler: function (req, res, next) {
      if (Array.isArray(req.preSandboxTrace)) {
        req.preSandboxTrace.push('beforeAuthFunctionRisk:before-auth-function');
      }
      return next();
    }
  });
};
`;
  }

  // 验证 index=1 会插入在 auth 之后、controller 之前。
  if (revision === 'index-one') {
    extension += `
const previousInitForIndexOne = init;
init = function () {
  previousInitForIndexOne();
  const app = safeRequire('@app');
  expressManager.injectRouteMiddleware(app, {
    key: 'indexOneRisk', paths: ['/v1', '/kefu', '/query-order-deposit'],
    method: 'get', index: 1,
    handler: function (req, res, next) {
      if (Array.isArray(req.preSandboxTrace)) {
        req.preSandboxTrace.push('indexOneRisk:index-one');
      }
      return next();
    }
  });
};
`;
  }

  return sourceCode + extension;
};

const createRemoteServer = () => {
  const state = {
    revision: 'v1',
    fetchCount: 0,
    validFetchCount: 0,
    logs: [],
  };
  const artifacts = new Map();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonfb-pre-sandbox-code-'));

  // 每个测试版本只转换一次，且使用生产 publish/convertRiskCode.js。
  const getArtifact = (revision = state.revision) => {
    if (artifacts.has(revision)) {
      return artifacts.get(revision);
    }

    const filePath = path.join(tempDir, `${revision}.js`);
    fs.writeFileSync(filePath, buildSource(revision), 'utf8');

    // 转换器本身会输出大量发布日志；测试仅保留失败，不污染 node:test 汇总。
    const originalLog = console.log;
    console.log = () => {};
    let converted;
    try {
      converted = convertCodeToString(filePath);
    } finally {
      console.log = originalLog;
    }

    if (!converted || !converted.base64Code || !converted.obfuscatedCode) {
      throw new Error(`远程代码生产转换失败: ${revision}`);
    }

    const artifact = {
      riskCode: converted.base64Code,
      hash: crypto.createHash('sha256').update(converted.base64Code).digest('hex'),
      obfuscated: (
        converted.obfuscatedCode !== converted.originalCode &&
        /_0x[0-9a-f]+/i.test(converted.obfuscatedCode)
      ),
      sourceLength: converted.originalCode.length,
      obfuscatedLength: converted.obfuscatedCode.length,
      base64Length: converted.base64Code.length,
      decodedContainsSource: Buffer.from(converted.base64Code, 'base64').toString('utf8') === converted.obfuscatedCode,
    };
    artifacts.set(revision, artifact);
    return artifact;
  };

  // 启动前完成 v1 转换，转换失败时服务不会伪装成正常启动。
  getArtifact('v1');
  getArtifact('pure');

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 与真实远程风控接口保持相同路径、签名、增量 hash 和 Base64 契约。
  app.post('/v2/risk/get-risk-code', (req, res) => {
    state.fetchCount += 1;

    const valid = verifySign(req.body, {
      secretKey: SECRET_KEY,
      secretValue: SECRET_VALUE,
      recursive: true,
    });
    if (!valid) {
      res.status(401).json({ data: { status: -1, error: 'invalid sign' } });
      return;
    }
    state.validFetchCount += 1;

    const artifact = getArtifact();
    if (req.body.hash === artifact.hash) {
      res.json({ data: { status: 0 } });
      return;
    }

    // riskCode 已由生产转换器完成「混淆 + Base64」，这里不再二次编码。
    res.json({
      data: {
        status: 1,
        hash: artifact.hash,
        riskCode: artifact.riskCode,
      },
    });
  });

  app.post('/v2/risk/log', (req, res) => {
    const signOk = verifySign(req.body, {
      secretKey: SECRET_KEY,
      secretValue: SECRET_VALUE,
      recursive: false,
    });
    state.logs.push({ message: String(req.body.message || ''), signOk });
    res.json({ data: { status: 1 } });
  });

  app.get('/__admin/state', (req, res) => {
    const artifact = getArtifact();
    res.json({
      ...state,
      hash: artifact.hash,
      artifact: {
        obfuscated: artifact.obfuscated,
        sourceLength: artifact.sourceLength,
        obfuscatedLength: artifact.obfuscatedLength,
        base64Length: artifact.base64Length,
        decodedContainsSource: artifact.decodedContainsSource,
      },
    });
  });

  app.post('/__admin/revision/:revision', (req, res) => {
    // 先完成生产转换，再切换当前版本；转换失败不会污染服务状态。
    const artifact = getArtifact(req.params.revision);
    state.revision = req.params.revision;
    res.json({ ok: true, revision: state.revision, hash: artifact.hash });
  });

  const server = http.createServer(app);
  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve({ baseUrl: `http://127.0.0.1:${address.port}`, port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        const finish = () => {
          fs.rmSync(tempDir, { recursive: true, force: true });
          resolve();
        };
        if (!server.listening) {
          finish();
          return;
        }
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(finish);
      });
    },
  };
};

module.exports = { createRemoteServer };
