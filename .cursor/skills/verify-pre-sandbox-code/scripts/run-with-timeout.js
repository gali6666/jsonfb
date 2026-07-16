'use strict';

const { spawn } = require('node:child_process');

const timeoutMs = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !command) {
  process.exit(2);
}

// 子进程成为独立进程组；超时时连同 node:test fork 出的消费端一起终止。
const child = spawn(command, args, {
  detached: true,
  stdio: 'inherit',
});

let timedOut = false;
let forceTimer;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    // 子进程已经退出时无需处理。
  }

  // 宽限期结束后始终清理整个进程组，防止测试进程先退出而消费端成为孤儿进程。
  forceTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      // 子进程组已经退出时无需处理。
    }
    process.exit(124);
  }, 2000);
}, timeoutMs);

child.on('error', () => {
  clearTimeout(timer);
  clearTimeout(forceTimer);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    // 等待上面的宽限期结束，由 forceTimer 确认整个进程组都已清理。
    return;
  }
  process.exit(signal ? 1 : (code || 0));
});
