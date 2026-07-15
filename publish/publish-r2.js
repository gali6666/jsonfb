#!/usr/bin/env node

/**
 * 将指定目录文件上传到 Cloudflare R2（S3 兼容）
 *
 * 环境变量（项目根目录）：
 *   .env          共用凭证 / R2_ENDPOINT
 *   .env.test     测试 R2_BUCKET / R2_PUBLIC_URL（覆盖 .env）
 *   .env.prod     生产同上
 *
 * 用法：
 *   PUBLISH_ENV=test node publish/publish-r2.js
 *   PUBLISH_ENV=prod node publish/publish-r2.js
 *   node publish/publish-r2.js --env test [--dir dist]
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { loadEnvForTarget, ENV_NAMES, ROOT_DIR } = require('./load-env');

const R2_KEY_PREFIX = 'risk/';
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

function parseArgs(argv) {
  const options = {
    env: process.env.PUBLISH_ENV || null,
    dir: path.join(ROOT_DIR, 'dist'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--env' || arg === '-e') && argv[i + 1]) {
      options.env = argv[i + 1];
      i += 1;
    } else if ((arg === '--dir' || arg === '-d') && argv[i + 1]) {
      options.dir = path.resolve(ROOT_DIR, argv[i + 1]);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`用法: node publish/publish-r2.js --env <test|prod> [--dir <path>]

环境变量文件（项目根目录）:
  .env          共用：AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT
  .env.test     测试：R2_BUCKET / R2_PUBLIC_URL（覆盖 .env 同名项）
  .env.prod     生产：同上

行为:
  - 上传目录内全部文件（默认 dist/）
  - 忽略 LICENSE / package.json / README.md
  - 对象 key 前缀固定为 risk/
  - .js 文件上传前用 vm.Script 做语法校验，失败则中止
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
  };
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

function toObjectKey(relativePath) {
  const prefix = R2_KEY_PREFIX.replace(/\/+$/, '');
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

async function uploadFile(client, config, file) {
  const key = toObjectKey(file.relative);
  const body = await fsp.readFile(file.fullPath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: guessContentType(file.fullPath),
  }));

  const publicUrl = config.publicUrl ? `${config.publicUrl}/${key}` : '';
  return { key, publicUrl, bytes: body.length };
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
  const sourceDir = options.dir;

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(`源目录不存在或不是目录: ${sourceDir}`);
    console.error('请先执行 npm run build');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('R2 发布');
  console.log('='.repeat(60));
  console.log(`环境:     ${config.env}`);
  console.log(`Bucket:   ${config.bucket}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`源目录:   ${sourceDir}`);
  console.log(`前缀:     ${R2_KEY_PREFIX}`);
  console.log('');

  const files = await collectFiles(sourceDir);
  if (files.length === 0) {
    console.error('没有可上传的文件（可能全部被忽略，或目录为空）');
    process.exit(1);
  }

  console.log(`待上传 ${files.length} 个文件:`);
  for (const file of files) {
    console.log(`  - ${file.relative}`);
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
    const result = await uploadFile(client, config, file);
    uploaded.push(result);
    const where = result.publicUrl || `s3://${config.bucket}/${result.key}`;
    console.log(`  ✓ ${result.key} (${result.bytes} bytes) → ${where}`);
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
  IGNORE_FILES,
  R2_KEY_PREFIX,
};
