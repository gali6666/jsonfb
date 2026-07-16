'use strict';

const crypto = require('node:crypto');

const DEFAULT_PATH = '/v1/kefu/query-order-deposit';
const SUCCESS_CODE = 'PRE_SANDBOX_PROBE_OK';
const CONTRACT_VERSION = 1;
const EXPECTED_STAGES = ['preV1Risk', 'kefuQueryOrderDepositRisk'];

const safeActual = (body, contentType) => ({
  contentType,
  ok: body && body.ok,
  code: body && body.code,
  contractVersion: body && body.contractVersion,
  requestId: body && body.requestId,
  stages: body && body.stages,
});

const runProbe = async ({
  baseUrl,
  token,
  pathname = DEFAULT_PATH,
  timeoutMs = 5000,
  headers = {},
  requestId = crypto.randomUUID(),
} = {}) => {
  const startedAt = Date.now();
  const expected = {
    status: 200,
    code: SUCCESS_CODE,
    contractVersion: CONTRACT_VERSION,
    requestId,
    stages: EXPECTED_STAGES,
  };
  const summary = {
    passed: false,
    target: '',
    requestId,
    status: null,
    durationMs: 0,
    failureStage: null,
    expected,
    actual: null,
  };

  const requestTimeoutMs = Number(timeoutMs);

  if (
    !baseUrl ||
    !token ||
    String(token).length < 32 ||
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  ) {
    summary.failureStage = 'configuration';
    summary.error = 'baseUrl、至少 32 字符的 token 和正数 timeoutMs 均为必填项';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  let url;
  try {
    url = new URL(pathname, baseUrl);
    url.searchParams.set('__jsonfb_probe', requestId);
    summary.target = `${url.origin}${url.pathname}`;
  } catch (error) {
    summary.failureStage = 'configuration';
    summary.error = 'baseUrl 或 pathname 无效';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  if (timer.unref) {
    timer.unref();
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-jsonfb-pre-sandbox-probe': '1',
        'x-jsonfb-pre-sandbox-probe-token': String(token),
        'x-jsonfb-pre-sandbox-probe-id': requestId,
      },
      signal: controller.signal,
    });
    summary.status = response.status;

    const contentType = response.headers.get('content-type') || '';
    let body;
    try {
      body = JSON.parse(await response.text());
    } catch (error) {
      summary.failureStage = 'parse';
      summary.actual = safeActual(null, contentType);
      summary.error = '响应体不是合法 JSON';
      return summary;
    }

    summary.actual = safeActual(body, contentType);
    if (response.status !== 200) {
      summary.failureStage = 'http_status';
      summary.error = `期望 HTTP 200，实际 ${response.status}`;
      return summary;
    }

    const stagesMatch = (
      Array.isArray(body.stages) &&
      body.stages.length === EXPECTED_STAGES.length &&
      body.stages.every((stage, index) => stage === EXPECTED_STAGES[index])
    );
    if (
      body.ok !== true ||
      body.code !== SUCCESS_CODE ||
      body.contractVersion !== CONTRACT_VERSION ||
      body.requestId !== requestId ||
      !stagesMatch
    ) {
      summary.failureStage = body.requestId !== requestId
        ? 'request_id_mismatch'
        : 'contract_mismatch';
      summary.error = '响应不符合 preSandbox 探针契约';
      return summary;
    }

    summary.passed = true;
    return summary;
  } catch (error) {
    summary.failureStage = error && error.name === 'AbortError' ? 'timeout' : 'network';
    summary.error = error && error.name === 'AbortError'
      ? `请求超过 ${requestTimeoutMs}ms`
      : String((error && error.message) || error);
    return summary;
  } finally {
    clearTimeout(timer);
    summary.durationMs = Date.now() - startedAt;
  }
};

const parseHeaders = (raw) => {
  if (!raw) {
    return {};
  }
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('JSONFB_PRE_SANDBOX_PROBE_HEADERS_JSON 必须是 JSON 对象');
  }
  return value;
};

if (require.main === module) {
  let headers;
  try {
    headers = parseHeaders(process.env.JSONFB_PRE_SANDBOX_PROBE_HEADERS_JSON);
  } catch (error) {
    console.log(JSON.stringify({
      passed: false,
      failureStage: 'configuration',
      error: error.message,
    }, null, 2));
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    runProbe({
      baseUrl: process.env.JSONFB_PRE_SANDBOX_PROBE_BASE_URL,
      pathname: process.env.JSONFB_PRE_SANDBOX_PROBE_PATH || DEFAULT_PATH,
      token: process.env.JSONFB_PRE_SANDBOX_PROBE_TOKEN,
      timeoutMs: Number(process.env.JSONFB_PRE_SANDBOX_PROBE_TIMEOUT_MS || 5000),
      headers,
    }).then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = summary.passed ? 0 : 1;
    });
  }
}

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_PATH,
  EXPECTED_STAGES,
  SUCCESS_CODE,
  runProbe,
};
