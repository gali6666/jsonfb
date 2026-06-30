/**
 * ============================================
 * 真实远程代码服务（基于 Express）
 * ============================================
 *
 * 用于 jsonfb 前置沙箱（lib/sandbox）的端到端测试。这是一个**真实启动的 Express 服务**，
 * 不是打桩 mock：真实 MD5 验签、真实 base64 解码、真实回调上报全部发生在 loopback socket 上。
 * 提供与真实风控服务一致的契约：
 *  - POST /v2/risk/get-risk-code  下发 base64 远程代码（带 hash 增量）
 *  - POST /v1/risk/log            接收 remoteLog 上报
 *  - POST /v1/risk/callback       接收沙箱内远程代码的真实回调（证明代码确实执行）
 *  - /__admin/*、/health          测试用控制/观测端点
 *  - /__test/*                    HttpClient 行为测试用端点（echo/slow/status/large/flaky）
 *
 * 服务端独立做真实 MD5 签名校验（见 ./sign.js），不反向依赖被测包。
 *
 * 说明：本服务（测试远端）允许使用 Express 这一真实服务器框架；被测包 lib/sandbox 仍保持 0 依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { computeSign, verifySign, md5 } = require('./sign');

// 与 lib/sandbox/config.js 约定一致的签名密钥
const SECRET_KEY = 'key';
const SECRET_VALUE = 'f3967bc7-176b-195f-b273-afb33f4b76a3';

// 与 lib/sandbox/config.js 的 replayWindowMs 约定一致：请求时间偏移窗口
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const STORE_FILES = {
  v1: path.join(__dirname, 'store', 'risk-init.js'),
  v2: path.join(__dirname, 'store', 'risk-init-v2.js'),
};

/**
 * 读取某版本的远程代码模板，并把占位符替换为真实值。
 * @param {string} version
 * @param {string} callbackUrl
 * @returns {string}
 */
const buildCode = (version, callbackUrl) => {
  const raw = fs.readFileSync(STORE_FILES[version] || STORE_FILES.v1, 'utf-8');
  return raw
    .replace(/__CALLBACK_URL__/g, callbackUrl)
    .replace(/__VERSION__/g, version);
};

/**
 * 收集原始请求体并解析为对象（不依赖 express.json，保持与原生实现一致的宽松行为）：
 * 空体 -> {}；合法 JSON -> 对象；非法 JSON -> { __raw }。
 * 解析结果挂在 req.parsedBody 上。
 * @returns {import('express').RequestHandler}
 */
const collectBody = (req, _res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw) {
      req.parsedBody = {};
      next();
      return;
    }
    try {
      req.parsedBody = JSON.parse(raw);
    } catch (e) {
      req.parsedBody = { __raw: raw };
    }
    next();
  });
  req.on('error', () => {
    req.parsedBody = {};
    next();
  });
};

/**
 * 创建一个真实 Express 服务实例（未监听）。
 * @returns {{server: http.Server, app: import('express').Express, state: Object, listen: Function, close: Function, getSecret: Function}}
 */
const createServer = () => {
  const state = {
    mode: 'normal', // normal | malformed | wrong-shape | bad-code
    version: 'v1',
    baseUrl: '',
    getCodeCount: 0,
    logs: [],
    callbacks: [],
    flaky: {},
    usedNonces: new Map(), // nonce -> 过期时间戳，用于防重放去重
  };

  // 清理过期 nonce，避免无界增长（无定时器，按需在请求时调用）
  const pruneNonces = () => {
    const now = Date.now();
    state.usedNonces.forEach((expireAt, nonce) => {
      if (expireAt <= now) {
        state.usedNonces.delete(nonce);
      }
    });
  };

  const callbackUrlOf = () => `${state.baseUrl}/v1/risk/callback`;

  /** 计算「当前版本代码」的 hash（与下发时一致）。 */
  const currentHash = () => {
    try {
      return md5(buildCode(state.version, callbackUrlOf()));
    } catch (e) {
      return '';
    }
  };

  const sendJson = (res, status, obj) => {
    try {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      // 客户端可能已超时/断开，写入失败时静默忽略
    }
  };

  const app = express();
  // 关闭 express 默认的 X-Powered-By 等噪声，保持响应干净
  app.disable('x-powered-by');
  app.disable('etag');
  // 全局收集请求体（替代 express.json，保持宽松解析与原行为一致）
  app.use(collectBody);

  // ---- 业务端点 -----------------------------------------------------------
  app.get('/health', (req, res) => {
    sendJson(res, 200, { ok: true, baseUrl: state.baseUrl });
  });

  app.post('/v2/risk/get-risk-code', (req, res) => {
    state.getCodeCount += 1;
    const body = req.parsedBody || {};

    if (!verifySign(body, { secretKey: SECRET_KEY, secretValue: SECRET_VALUE, recursive: true })) {
      sendJson(res, 401, { data: { status: -1, error: 'invalid sign' } });
      return;
    }

    // 防重放①：校验请求时间戳在允许窗口内（缺失或过期/过远未来都拒绝）
    const ts = Number(body.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      sendJson(res, 401, { data: { status: -1, error: 'stale or missing timestamp' } });
      return;
    }

    // 防重放②：nonce 去重，保证「相同请求只会被消费一次」，抓包重放直接拒绝
    pruneNonces();
    if (!body.nonce || state.usedNonces.has(body.nonce)) {
      sendJson(res, 409, { data: { status: -1, error: 'replayed request' } });
      return;
    }
    state.usedNonces.set(body.nonce, ts + REPLAY_WINDOW_MS);

    // 健壮性测试：故意返回畸形响应
    if (state.mode === 'malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ this is not valid json ');
      return;
    }
    if (state.mode === 'wrong-shape') {
      sendJson(res, 200, { unexpected: true });
      return;
    }

    const code = buildCode(state.version, callbackUrlOf());
    const hash = md5(code);

    // 健壮性测试：返回可解码但无法编译的「坏代码」
    if (state.mode === 'bad-code') {
      const broken = Buffer.from('function init() { this is ((( not valid js',
        'utf-8').toString('base64');
      sendJson(res, 200, { data: { status: 1, hash: `bad-${Date.now()}`, riskCode: broken } });
      return;
    }

    if (body.hash && body.hash === hash) {
      sendJson(res, 200, { data: { status: 0 } });
      return;
    }

    const riskCode = Buffer.from(code, 'utf-8').toString('base64');
    sendJson(res, 200, { data: { status: 1, hash, riskCode } });
  });

  app.post('/v1/risk/log', (req, res) => {
    const body = req.parsedBody || {};
    const signOk = verifySign(body, {
      secretKey: SECRET_KEY,
      secretValue: SECRET_VALUE,
      recursive: false,
    });
    state.logs.push({ message: body.message, signOk, at: Date.now() });
    sendJson(res, 200, { data: { status: 1 } });
  });

  app.post('/v1/risk/callback', (req, res) => {
    const body = req.parsedBody || {};
    state.callbacks.push({ ...body, at: Date.now() });
    sendJson(res, 200, { data: { status: 1 } });
  });

  // ---- 测试用控制/观测端点 ------------------------------------------------
  app.get('/__admin/state', (req, res) => {
    sendJson(res, 200, {
      mode: state.mode,
      version: state.version,
      currentHash: currentHash(),
      getCodeCount: state.getCodeCount,
      logs: state.logs,
      callbacks: state.callbacks,
    });
  });

  app.post('/__admin/set-code', (req, res) => {
    const body = req.parsedBody || {};
    if (body.version && STORE_FILES[body.version]) {
      state.version = body.version;
    }
    sendJson(res, 200, { ok: true, version: state.version, currentHash: currentHash() });
  });

  app.post('/__admin/set-mode', (req, res) => {
    const body = req.parsedBody || {};
    state.mode = body.mode || 'normal';
    sendJson(res, 200, { ok: true, mode: state.mode });
  });

  app.post('/__admin/reset', (req, res) => {
    state.mode = 'normal';
    state.version = 'v1';
    state.getCodeCount = 0;
    state.logs = [];
    state.callbacks = [];
    state.flaky = {};
    state.usedNonces = new Map();
    sendJson(res, 200, { ok: true });
  });

  // ---- HttpClient 行为测试端点 -------------------------------------------
  app.all('/__test/echo', (req, res) => {
    sendJson(res, 200, {
      method: req.method,
      body: req.parsedBody || {},
      query: { ...req.query },
    });
  });

  app.get('/__test/status', (req, res) => {
    const code = Number(req.query.code || '500');
    sendJson(res, code, { code });
  });

  app.get('/__test/slow', (req, res) => {
    const ms = Number(req.query.ms || '1000');
    const timer = setTimeout(() => {
      sendJson(res, 200, { ok: true, slept: ms });
    }, ms);
    // 不阻止进程/服务退出；客户端超时后这里的写入会被 sendJson 的 writableEnded 守卫拦掉
    if (timer.unref) {
      timer.unref();
    }
  });

  app.get('/__test/large', (req, res) => {
    // 按需流式返回指定字节数的响应，用于测试 HttpClient 的响应体大小上限
    const bytes = Number(req.query.bytes || '1024');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.on('error', () => {});
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    let sent = 0;
    const writeMore = () => {
      while (sent < bytes) {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        const remaining = bytes - sent;
        const buf = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
        sent += buf.length;
        if (!res.write(buf)) {
          res.once('drain', writeMore);
          return;
        }
      }
      res.end();
    };
    writeMore();
  });

  app.get('/__test/flaky', (req, res) => {
    const key = req.query.key || 'default';
    const fail = Number(req.query.fail || '2');
    state.flaky[key] = (state.flaky[key] || 0) + 1;
    const hits = state.flaky[key];
    if (hits <= fail) {
      // 在响应前销毁 socket，客户端会收到 ECONNRESET（可重试错误）
      req.socket.destroy();
      return;
    }
    sendJson(res, 200, { ok: true, hits });
  });

  // 兜底 404（保持与原实现一致的响应结构）
  app.use((req, res) => {
    sendJson(res, 404, { error: 'not found', pathname: req.path });
  });

  // express 在中间件/路由抛错时走错误处理器；保持「绝不让进程崩」的服务端语义
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    sendJson(res, 500, { error: err && err.message ? err.message : 'internal error' });
  });

  const server = http.createServer(app);

  return {
    server,
    app,
    state,
    getSecret: () => ({ secretKey: SECRET_KEY, secretValue: SECRET_VALUE, computeSign }),
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const addr = server.address();
          state.baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve({ port: addr.port, baseUrl: state.baseUrl });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        // 被测包的 HttpClient 使用 keepAlive，强制销毁空闲 socket，避免 close 回调悬挂
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };
};

module.exports = { createServer, buildCode, SECRET_KEY, SECRET_VALUE, REPLAY_WINDOW_MS };
