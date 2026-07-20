#!/usr/bin/env node

/**
 * 将指定目录文件上传到 Cloudflare R2（S3 兼容），上传成功后 purge 公网 CDN 缓存。
 *
 * 环境变量（项目根目录）：
 *   .env          共用凭证 / R2_ENDPOINT / Cloudflare purge 凭证
 *   .env.test     测试 R2_BUCKET / R2_PUBLIC_URL（覆盖 .env）
 *   .env.prod     生产同上
 *
 * 所需密钥 / 配置（列全）：
 *   AWS_ACCESS_KEY_ID       R2 S3 API Access Key（.env）
 *   AWS_SECRET_ACCESS_KEY   R2 S3 API Secret Key（.env）
 *   R2_ENDPOINT             R2 S3 端点，形如 https://<ACCOUNT_ID>.r2.cloudflarestorage.com（.env）
 *   AWS_DEFAULT_REGION      可选，默认 auto（.env）
 *   R2_BUCKET               目标桶（.env.test / .env.prod）
 *   R2_PUBLIC_URL           公网访问域名，用于输出 URL + purge 前缀（.env.test / .env.prod）
 *   CLOUDFLARE_API_TOKEN    Cloudflare API Token（.env；建议存 base64，读取时自动还原；亦兼容明文）
 *   CLOUDFLARE_ZONE_ID      可选；默认 zigoyw.com zone（.env 可覆盖）
 *
 * 上传成功后：purge CDN → 对公网 URL 做 HEAD，核对 ETag 与上传一致，确认清缓存已生效。
 *
 * 用法：
 *   PUBLISH_ENV=test node publish/publish-r2.js
 *   PUBLISH_ENV=prod node publish/publish-r2.js
 *   node publish/publish-r2.js --env test [--dir dist | --file dist/index.js] [--prefix risk/]
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { loadEnvForTarget, ENV_NAMES, ROOT_DIR } = require('./load-env');

const DEFAULT_R2_KEY_PREFIX = 'risk/';
/** zigoyw.com（r2-client-*.zigoyw.com 所在 zone），可用 CLOUDFLARE_ZONE_ID 覆盖 */
const DEFAULT_CLOUDFLARE_ZONE_ID = 'b19b49df3ad821bae8b041bf2371d98e';
const CF_PURGE_API = 'https://api.cloudflare.com/client/v4/zones';
/** purge 后公网 HEAD 核对 ETag 的重试（边缘传播偶发延迟） */
const CDN_VERIFY_ATTEMPTS = 5;
const CDN_VERIFY_DELAY_MS = 1000;
const IGNORE_FILES = new Set(['LICENSE', 'package.json', 'README.md']);
const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function normalizePrefix(prefix) {
  const cleaned = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return cleaned ? `${cleaned}/` : '';
}

function parseArgs(argv) {
  const options = {
    env: process.env.PUBLISH_ENV || null,
    dir: path.join(ROOT_DIR, 'dist'),
    file: null,
    prefix: DEFAULT_R2_KEY_PREFIX,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--env' || arg === '-e') && argv[i + 1]) {
      options.env = argv[i + 1];
      i += 1;
    } else if ((arg === '--dir' || arg === '-d') && argv[i + 1]) {
      options.dir = path.resolve(ROOT_DIR, argv[i + 1]);
      i += 1;
    } else if ((arg === '--file' || arg === '-f') && argv[i + 1]) {
      options.file = path.resolve(ROOT_DIR, argv[i + 1]);
      i += 1;
    } else if ((arg === '--prefix' || arg === '-p') && argv[i + 1]) {
      options.prefix = normalizePrefix(argv[i + 1]);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`用法: node publish/publish-r2.js --env <test|prod> [--dir <path> | --file <path>] [--prefix <prefix>]

环境变量文件（项目根目录）:
  .env          共用：AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT
                以及 CLOUDFLARE_API_TOKEN（可选 CLOUDFLARE_ZONE_ID）
  .env.test     测试：R2_BUCKET / R2_PUBLIC_URL（覆盖 .env 同名项）
  .env.prod     生产：同上

所需密钥:
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT   上传用
  R2_BUCKET / R2_PUBLIC_URL                                  环境桶与公网域名
  CLOUDFLARE_API_TOKEN                                       上传后 purge CDN（建议 base64 写入 .env）
  CLOUDFLARE_ZONE_ID                                         可选，默认 zigoyw.com

行为:
  - 上传目录内全部文件（默认 dist/）
  - 传入 --file 时只上传指定文件
  - 忽略 LICENSE / package.json / README.md
  - 对象 key 前缀默认 risk/，可用 --prefix 覆盖（例如 xss-clean/）
  - .js 文件上传前用 vm.Script 做语法校验，失败则中止
  - 上传成功后打印 R2 返回的 ETag（公网 HEAD 可读，供远端对比）
  - 上传成功后按 R2_PUBLIC_URL + prefix 调用 Cloudflare purge_cache，使新文件立即生效
  - purge 后对公网 URL HEAD 核对 ETag，确认 CDN 已吐出新版本（失败则非零退出）
`);
}

function resolveConfig(envName) {
  const { sharedLoaded, envLoaded, sharedPath, envPath } = loadEnvForTarget(envName);

  if (!sharedLoaded) {
    console.error(`缺少共用配置: ${sharedPath}`);
    console.error('请在项目根目录创建 .env 并填写 R2 凭证与 R2_ENDPOINT');
    process.exit(1);
  }

  if (!envLoaded) {
    console.error(`缺少环境配置: ${envPath}`);
    console.error(`请在项目根目录创建 .env.${envName} 并填写 R2_BUCKET`);
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!bucket) {
    console.error(`.env.${envName} 中未设置 R2_BUCKET`);
    process.exit(1);
  }
  if (!endpoint) {
    console.error('.env 中未设置 R2_ENDPOINT');
    process.exit(1);
  }
  if (!accessKeyId || !secretAccessKey) {
    console.error('.env 中未设置 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  return {
    env: envName,
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: process.env.AWS_DEFAULT_REGION || 'auto',
    bucket,
    publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),
    cloudflareApiToken: resolveCloudflareApiToken(process.env.CLOUDFLARE_API_TOKEN),
    cloudflareZoneId: (
      process.env.CLOUDFLARE_ZONE_ID || DEFAULT_CLOUDFLARE_ZONE_ID
    ).trim(),
  };
}

/**
 * 读取 CLOUDFLARE_API_TOKEN：支持明文，或 .env 中存放的 base64（防 push 扫描）。
 * 明文（cfut_/cfat_）原样返回；否则按 base64 解码，解码后仍不像 token 则退回原值。
 */
function resolveCloudflareApiToken(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^cf[au]t_/i.test(raw)) {
    return raw;
  }
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
    if (/^cf[au]t_/i.test(decoded)) {
      return decoded;
    }
  } catch (_) {
    // ignore
  }
  return raw;
}

/**
 * Cloudflare purge prefix：hostname + path，无 scheme。
 * 例：r2-client-prod.zigoyw.com/risk/
 */
function buildPurgePrefix(publicUrl, keyPrefix) {
  const host = String(publicUrl || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!host) {
    return '';
  }
  const prefix = normalizePrefix(keyPrefix);
  return prefix ? `${host}/${prefix}` : `${host}/`;
}

/**
 * 上传成功后清除 Cloudflare 边缘缓存（参考 afan/landing/upload-pwa.js purgeCloudflare）。
 * 未配置 CLOUDFLARE_API_TOKEN 时跳过并警告，不中断发布。
 */
async function purgeCloudflare(config, keyPrefix) {
  const token = config.cloudflareApiToken;
  const zoneId = config.cloudflareZoneId;
  const purgePrefix = buildPurgePrefix(config.publicUrl, keyPrefix);

  if (!token) {
    console.warn(
      '[publish-r2] skip CF purge: CLOUDFLARE_API_TOKEN not set in .env',
    );
    return { skipped: true, reason: 'missing-token' };
  }
  if (!zoneId) {
    console.warn(
      '[publish-r2] skip CF purge: CLOUDFLARE_ZONE_ID not set',
    );
    return { skipped: true, reason: 'missing-zone' };
  }
  if (!purgePrefix) {
    console.warn(
      '[publish-r2] skip CF purge: R2_PUBLIC_URL not set (无法拼 purge 前缀)',
    );
    return { skipped: true, reason: 'missing-public-url' };
  }

  const res = await fetch(`${CF_PURGE_API}/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prefixes: [purgePrefix] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(
      `CF purge failed for ${purgePrefix}: ${res.status} ${JSON.stringify(body.errors ?? body)}`,
    );
  }

  console.log(`[publish-r2] purged CF cache prefix ${purgePrefix}`);
  return { skipped: false, purged: 1, prefix: purgePrefix };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * HEAD 公网对象，读取 ETag / CF-Cache-Status（用于验证 purge 是否生效）。
 */
async function headPublicObject(url) {
  const res = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: {
      // 避免中间代理复用本地连接缓存影响判断
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });
  return {
    status: res.status,
    etag: normalizeETag(res.headers.get('etag')),
    cfCacheStatus: res.headers.get('cf-cache-status') || '',
    age: res.headers.get('age') || '',
  };
}

/**
 * purge 后验证：公网 HEAD 的 ETag 必须与上传时 R2 返回的 ETag 一致。
 * 不一致则重试若干次（边缘传播延迟）；仍失败则抛错中止发布。
 */
async function verifyCachePurge(uploaded, options = {}) {
  const attempts = options.attempts ?? CDN_VERIFY_ATTEMPTS;
  const delayMs = options.delayMs ?? CDN_VERIFY_DELAY_MS;
  const targets = (uploaded || []).filter((item) => item.publicUrl && item.etag);

  if (targets.length === 0) {
    console.warn(
      '[publish-r2] skip CDN verify: 无 publicUrl/etag（检查 R2_PUBLIC_URL）',
    );
    return { skipped: true, reason: 'no-targets', verified: 0 };
  }

  const failures = [];

  for (const item of targets) {
    let last = null;
    let matched = false;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        last = await headPublicObject(item.publicUrl);
      } catch (err) {
        last = {
          status: 0,
          etag: '',
          cfCacheStatus: '',
          age: '',
          error: err.message || String(err),
        };
      }

      const statusOk = last.status >= 200 && last.status < 300;
      if (statusOk && last.etag && last.etag === item.etag) {
        const cacheInfo = last.cfCacheStatus || '-';
        const ageInfo = last.age !== '' ? ` age=${last.age}` : '';
        console.log(
          `  ✓ ${item.key} etag=${last.etag} cf-cache-status=${cacheInfo}${ageInfo} (attempt ${attempt}/${attempts})`,
        );
        matched = true;
        break;
      }

      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }

    if (!matched) {
      failures.push({ key: item.key, expected: item.etag, got: last });
      const detail = last && last.error
        ? `error=${last.error}`
        : `status=${last?.status ?? '-'} etag=${last?.etag || '-'} cf-cache-status=${last?.cfCacheStatus || '-'}`;
      console.error(
        `  ✗ ${item.key} expected etag=${item.etag} ${detail}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `CDN verify failed: ${failures.length}/${targets.length} 个文件公网 ETag 与上传不一致（清缓存可能未生效）`,
    );
  }

  return { skipped: false, verified: targets.length };
}

async function collectFiles(rootDir) {
  const results = [];

  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (IGNORE_FILES.has(entry.name)) {
        continue;
      }
      const relative = path.relative(rootDir, fullPath).split(path.sep).join('/');
      results.push({ fullPath, relative });
    }
  }

  await walk(rootDir);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function isValidSyntax(filePath) {
  const code = await fsp.readFile(filePath, 'utf8');
  try {
    // 只编译不运行，能编译说明语法正确
    new vm.Script(code, { filename: filePath });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 归一化 ETag，便于 R2 PutObject 与 CDN HEAD 对比。
 * 兼容 `"abc"`、`W/"abc"`（弱校验）等形式。
 */
function normalizeETag(etag) {
  let value = String(etag || '').trim();
  if (/^[Ww]\//.test(value)) {
    value = value.slice(2).trim();
  }
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function toObjectKey(relativePath, keyPrefix = DEFAULT_R2_KEY_PREFIX) {
  const prefix = normalizePrefix(keyPrefix).replace(/\/+$/, '');
  if (!prefix) {
    return String(relativePath).replace(/\/+/g, '/');
  }
  return `${prefix}/${relativePath}`.replace(/\/+/g, '/');
}

function createS3Client(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

async function uploadFile(client, config, file, keyPrefix) {
  const key = toObjectKey(file.relative, keyPrefix);
  const body = await fsp.readFile(file.fullPath);
  const putResult = await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: guessContentType(file.fullPath),
  }));

  const publicUrl = config.publicUrl ? `${config.publicUrl}/${key}` : '';
  return {
    key,
    publicUrl,
    bytes: body.length,
    etag: normalizeETag(putResult.ETag),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.env || !ENV_NAMES.includes(options.env)) {
    console.error(`请指定环境: --env <${ENV_NAMES.join('|')}> 或 PUBLISH_ENV`);
    printHelp();
    process.exit(1);
  }

  const config = resolveConfig(options.env);
  const sourcePath = options.file || options.dir;
  const keyPrefix = options.prefix;

  if (!fs.existsSync(sourcePath)) {
    console.error(`源路径不存在: ${sourcePath}`);
    process.exit(1);
  }

  const sourceStat = fs.statSync(sourcePath);
  if (options.file ? !sourceStat.isFile() : !sourceStat.isDirectory()) {
    console.error(`源路径类型不正确: ${sourcePath}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('R2 发布');
  console.log('='.repeat(60));
  console.log(`环境:     ${config.env}`);
  console.log(`Bucket:   ${config.bucket}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`源路径:   ${sourcePath}`);
  console.log(`前缀:     ${keyPrefix}`);
  console.log('');

  const files = options.file
    ? [{ fullPath: sourcePath, relative: path.basename(sourcePath) }]
    : await collectFiles(sourcePath);
  if (files.length === 0) {
    console.error('没有可上传的文件（可能全部被忽略，或目录为空）');
    process.exit(1);
  }

  console.log(`待上传 ${files.length} 个文件:`);
  for (const file of files) {
    console.log(`  - ${toObjectKey(file.relative, keyPrefix)}`);
  }
  console.log('');

  // 上传前：.js 语法校验
  console.log('校验 .js 语法...');
  let syntaxFailed = false;
  for (const file of files) {
    if (path.extname(file.fullPath).toLowerCase() !== '.js') {
      continue;
    }
    const result = await isValidSyntax(file.fullPath);
    if (!result.valid) {
      syntaxFailed = true;
      console.error(`  ✗ ${file.relative}: ${result.error}`);
    } else {
      console.log(`  ✓ ${file.relative}`);
    }
  }

  if (syntaxFailed) {
    console.error('');
    console.error('语法校验失败，已中止上传');
    process.exit(1);
  }
  console.log('');

  const client = createS3Client(config);
  const uploaded = [];

  console.log('开始上传...');
  for (const file of files) {
    const result = await uploadFile(client, config, file, keyPrefix);
    uploaded.push(result);
    const where = result.publicUrl || `s3://${config.bucket}/${result.key}`;
    console.log(`  ✓ ${result.key} (${result.bytes} bytes) etag=${result.etag} → ${where}`);
  }

  console.log('');
  console.log('清除 Cloudflare CDN 缓存...');
  const purgeResult = await purgeCloudflare(config, keyPrefix);

  console.log('');
  if (purgeResult.skipped) {
    console.warn(
      `[publish-r2] skip CDN verify: purge skipped (${purgeResult.reason})`,
    );
  } else {
    console.log('验证 CDN 清缓存已生效（公网 HEAD ETag）...');
    await verifyCachePurge(uploaded);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`完成：已上传 ${uploaded.length} 个文件到 ${config.env} (${config.bucket})`);
  console.log('='.repeat(60));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('发布失败:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  isValidSyntax,
  collectFiles,
  toObjectKey,
  normalizeETag,
  normalizePrefix,
  buildPurgePrefix,
  purgeCloudflare,
  headPublicObject,
  verifyCachePurge,
  resolveCloudflareApiToken,
  IGNORE_FILES,
  DEFAULT_R2_KEY_PREFIX,
  DEFAULT_CLOUDFLARE_ZONE_ID,
  CDN_VERIFY_ATTEMPTS,
  CDN_VERIFY_DELAY_MS,
  /** @deprecated 使用 DEFAULT_R2_KEY_PREFIX */
  R2_KEY_PREFIX: DEFAULT_R2_KEY_PREFIX,
};
