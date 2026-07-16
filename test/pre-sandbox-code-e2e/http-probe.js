'use strict';

const DEFAULT_PATH = '/v1/kefu/query-order-deposit';

const runProbe = async ({
  baseUrl,
  pathname = DEFAULT_PATH,
  timeoutMs = 5000,
  headers = {},
} = {}) => {
  const startedAt = Date.now();
  const expected = { status: 200, body: { code: 0, jack: true } };
  const summary = {
    passed: false,
    target: '',
    status: null,
    durationMs: 0,
    failureStage: null,
    expected,
    actual: null,
  };
  const requestTimeoutMs = Number(timeoutMs);

  if (!baseUrl || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    summary.failureStage = 'configuration';
    summary.error = 'baseUrl 和正数 timeoutMs 均为必填项';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  let url;
  try {
    url = new URL(pathname, baseUrl);
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
      headers: { ...headers, accept: 'application/json' },
      signal: controller.signal,
    });
    summary.status = response.status;

    let body;
    try {
      body = JSON.parse(await response.text());
    } catch (error) {
      summary.failureStage = 'parse';
      summary.error = '响应体不是合法 JSON';
      return summary;
    }
    summary.actual = body;

    if (response.status !== 200) {
      summary.failureStage = 'http_status';
      summary.error = `期望 HTTP 200，实际 ${response.status}`;
      return summary;
    }

    if (body.code !== 0 || body.jack !== true) {
      summary.failureStage = 'contract_mismatch';
      summary.error = '响应不符合 preSandbox 固定响应契约';
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
      timeoutMs: Number(process.env.JSONFB_PRE_SANDBOX_PROBE_TIMEOUT_MS || 5000),
      headers,
    }).then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = summary.passed ? 0 : 1;
    });
  }
}

module.exports = { DEFAULT_PATH, runProbe };
