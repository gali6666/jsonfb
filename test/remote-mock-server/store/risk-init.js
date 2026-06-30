// 远程下发代码（v1）。在 jsonfb 前置沙箱内执行。
// 占位符 __CALLBACK_URL__ / __VERSION__ 由 mock 服务在下发时替换为真实值。
//
// 可用的沙箱注入：HttpClient、signWithMD5、remoteLog、console、JSON、Date、
// fs、os、path、process、原生 require 等（见 lib/sandbox/index.js）。

async function init() {
  // 用沙箱注入的原生 HttpClient 做真实回调，证明本段代码确实在沙箱内执行。
  const client = new HttpClient({ timeout: 5000, retries: 1 });
  await client.post('__CALLBACK_URL__', {
    event: 'init',
    version: '__VERSION__',
    revision: 1,
    ts: Date.now(),
  });

  if (typeof remoteLog === 'function') {
    remoteLog('[risk-__VERSION__] init executed in sandbox');
  }

  return { ok: true, version: '__VERSION__', phase: 'init' };
}

async function main() {
  return { ok: true, version: '__VERSION__', phase: 'main' };
}
