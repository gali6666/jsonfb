'use strict';

/**
 * 独立远程代码服务：真实接收 jsonfb 请求并下发 preSandbox.js。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { verifySign } = require('../remote-mock-server/sign');

const SECRET_KEY = 'key';
const SECRET_VALUE = 'f3967bc7-176b-195f-b273-afb33f4b76a3';
const sourcePath = path.resolve(__dirname, '..', '..', 'publish', 'code', 'preSandbox.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');

// 仅替换预留的空 handler，给真实 HTTP 请求增加版本轨迹；其余代码保持源文件内容。
const buildVersionedCode = (revision) => {
  const original = `const buildHandler = () => function (req, res, next) {
  // 当前暂不执行风控判断，直接继续后续请求链。
  return next();
};`;
  const replacement = `const buildHandler = (key) => function (req, res, next) {
  if (Array.isArray(req.preSandboxTrace)) {
    req.preSandboxTrace.push(key + ':${revision}');
  }
  return next();
};`;

  if (!sourceCode.includes(original)) {
    throw new Error('preSandbox.js 的 buildHandler 结构已变化，测试插桩无法应用');
  }

  return sourceCode
    .replace(original, replacement)
    .replace('handler: buildHandler(),', "handler: buildHandler('preV1Risk'),")
    .replace(
      'handler: buildHandler(),',
      "handler: buildHandler('kefuQueryOrderDepositRisk'),"
    );
};

const createRemoteServer = () => {
  const state = {
    revision: 'v1',
    fetchCount: 0,
    logs: [],
  };

  const currentCode = () => buildVersionedCode(state.revision);
  const currentHash = () => crypto.createHash('sha256').update(currentCode()).digest('hex');
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 与真实远程风控接口保持相同路径、签名和增量 hash 契约。
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

    const hash = currentHash();
    if (req.body.hash === hash) {
      res.json({ data: { status: 0 } });
      return;
    }

    res.json({
      data: {
        status: 1,
        hash,
        riskCode: Buffer.from(currentCode(), 'utf8').toString('base64'),
      },
    });
  });

  // 接收 preSandbox.js 和 jsonfb 的真实 remoteLog 上报。
  app.post('/v2/risk/log', (req, res) => {
    state.logs.push(String(req.body.message || ''));
    res.json({ data: { status: 1 } });
  });

  app.get('/__admin/state', (req, res) => {
    res.json({ ...state, hash: currentHash() });
  });

  app.post('/__admin/revision/:revision', (req, res) => {
    state.revision = req.params.revision;
    res.json({ ok: true, revision: state.revision, hash: currentHash() });
  });

  const server = http.createServer(app);
  return {
    state,
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
        if (!server.listening) {
          resolve();
          return;
        }
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(resolve);
      });
    },
  };
};

module.exports = { createRemoteServer };
