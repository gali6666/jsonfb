// 远程下发代码（v2）。用于测试「代码更新 -> 缓存清理 -> 重新 init」。
// 与 v1 的差异：revision=2，回调携带 updated 标记，确保内容与 hash 均不同。

async function init() {
  const client = new HttpClient({ timeout: 5000, retries: 1 });
  await client.post('__CALLBACK_URL__', {
    event: 'init',
    version: '__VERSION__',
    revision: 2,
    updated: true,
    ts: Date.now(),
  });

  if (typeof remoteLog === 'function') {
    remoteLog('[risk-__VERSION__] init executed in sandbox (v2)');
  }

  return { ok: true, version: '__VERSION__', phase: 'init', revision: 2 };
}

async function main() {
  return { ok: true, version: '__VERSION__', phase: 'main', revision: 2 };
}
