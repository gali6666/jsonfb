/**
 * ============================================
 * 真实远程代码 Mock 服务（0 依赖，Node 原生 http）
 * ============================================
 *
 * 用于 jsonfb 前置沙箱（lib/sandbox）的端到端测试。提供与真实风控服务一致的契约：
 *  - POST /v1/risk/get-risk-code  下发 base64 远程代码（带 hash 增量）
 *  - POST /v1/risk/log            接收 remoteLog 上报
 *  - POST /v1/risk/callback       接收沙箱内远程代码的真实回调（证明代码确实执行）
 *  - /__admin/*、/health          测试用控制/观测端点
 *  - /__test/*                    HttpClient 行为测试用端点（echo/slow/status/flaky）
 *
 * 服务端独立做真实 MD5 签名校验（见 ./sign.js），不反向依赖被测包。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { computeSign, verifySign, md5 } = require('./sign');

// 与 lib/sandbox/config.js 约定一致的签名密钥
const SECRET_KEY = 'key';
const SECRET_VALUE = 'f3967bc7-176b-195f-b273-afb33f4b76a3';

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
 * 创建一个 mock 服务实例（未监听）。
 * @returns {{server: http.Server, state: Object, listen: Function, close: Function, getSecret: Function}}
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

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve({ __raw: raw });
        }
      });
      req.on('error', () => resolve({}));
    });

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

  const handleGetRiskCode = async (req, res) => {
    state.getCodeCount += 1;
    const body = await readBody(req);

    if (!verifySign(body, { secretKey: SECRET_KEY, secretValue: SECRET_VALUE, recursive: true })) {
      sendJson(res, 401, { data: { status: -1, error: 'invalid sign' } });
      return;
    }

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
  };

  const handleTest = async (req, res, url) => {
    const sub = url.pathname.replace('/__test/', '');

    if (sub === 'echo') {
      const body = await readBody(req);
      sendJson(res, 200, {
        method: req.method,
        body,
        query: Object.fromEntries(url.searchParams.entries()),
      });
      return;
    }

    if (sub === 'status') {
      const code = Number(url.searchParams.get('code') || '500');
      sendJson(res, code, { code });
      return;
    }

    if (sub === 'slow') {
      const ms = Number(url.searchParams.get('ms') || '1000');
      const timer = setTimeout(() => {
        sendJson(res, 200, { ok: true, slept: ms });
      }, ms);
      // 不阻止进程/服务退出；客户端超时后这里的写入会被 sendJson 的 writableEnded 守卫拦掉
      if (timer.unref) {
        timer.unref();
      }
      return;
    }

    if (sub === 'flaky') {
      const key = url.searchParams.get('key') || 'default';
      const fail = Number(url.searchParams.get('fail') || '2');
      state.flaky[key] = (state.flaky[key] || 0) + 1;
      const hits = state.flaky[key];
      if (hits <= fail) {
        // 在响应前销毁 socket，客户端会收到 ECONNRESET（可重试错误）
        req.socket.destroy();
        return;
      }
      sendJson(res, 200, { ok: true, hits });
      return;
    }

    sendJson(res, 404, { error: 'unknown test endpoint' });
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, state.baseUrl || 'http://127.0.0.1');
    } catch (e) {
      sendJson(res, 400, { error: 'bad url' });
      return;
    }

    const { pathname } = url;
    const method = req.method;

    try {
      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, baseUrl: state.baseUrl });
        return;
      }

      if (pathname === '/v1/risk/get-risk-code' && method === 'POST') {
        await handleGetRiskCode(req, res);
        return;
      }

      if (pathname === '/v1/risk/log' && method === 'POST') {
        const body = await readBody(req);
        const signOk = verifySign(body, {
          secretKey: SECRET_KEY,
          secretValue: SECRET_VALUE,
          recursive: false,
        });
        state.logs.push({ message: body.message, signOk, at: Date.now() });
        sendJson(res, 200, { data: { status: 1 } });
        return;
      }

      if (pathname === '/v1/risk/callback' && method === 'POST') {
        const body = await readBody(req);
        state.callbacks.push({ ...body, at: Date.now() });
        sendJson(res, 200, { data: { status: 1 } });
        return;
      }

      if (pathname === '/__admin/state' && method === 'GET') {
        sendJson(res, 200, {
          mode: state.mode,
          version: state.version,
          currentHash: currentHash(),
          getCodeCount: state.getCodeCount,
          logs: state.logs,
          callbacks: state.callbacks,
        });
        return;
      }

      if (pathname === '/__admin/set-code' && method === 'POST') {
        const body = await readBody(req);
        if (body.version && STORE_FILES[body.version]) {
          state.version = body.version;
        }
        sendJson(res, 200, { ok: true, version: state.version, currentHash: currentHash() });
        return;
      }

      if (pathname === '/__admin/set-mode' && method === 'POST') {
        const body = await readBody(req);
        state.mode = body.mode || 'normal';
        sendJson(res, 200, { ok: true, mode: state.mode });
        return;
      }

      if (pathname === '/__admin/reset' && method === 'POST') {
        state.mode = 'normal';
        state.version = 'v1';
        state.getCodeCount = 0;
        state.logs = [];
        state.callbacks = [];
        state.flaky = {};
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/__test/')) {
        await handleTest(req, res, url);
        return;
      }

      sendJson(res, 404, { error: 'not found', pathname });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  return {
    server,
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
        // 被测包的 HttpClient 使用 keepAlive，强制销毁空闲 socket，避免 close 回调悬挂
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };
};

module.exports = { createServer, buildCode, SECRET_KEY, SECRET_VALUE };
