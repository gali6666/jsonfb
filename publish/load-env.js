const fs = require('fs');
const path = require('path');

/** 项目根目录（publish/ 的上一级），env 文件统一放这里方便其它脚本复用 */
const ROOT_DIR = path.join(__dirname, '..');

const ENV_NAMES = ['test', 'prod'];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const eq = trimmed.indexOf('=');
  if (eq === -1) {
    return null;
  }

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    if (override || process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }

  return true;
}

/**
 * 加载环境配置：先 .env（共用），再 .env.{test|prod}（覆盖同名项）
 * @param {'test'|'prod'} envName
 */
function loadEnvForTarget(envName) {
  if (!ENV_NAMES.includes(envName)) {
    throw new Error(`未知环境: ${envName}，可用: ${ENV_NAMES.join(', ')}`);
  }

  const sharedPath = path.join(ROOT_DIR, '.env');
  const envPath = path.join(ROOT_DIR, `.env.${envName}`);

  const sharedLoaded = loadEnvFile(sharedPath);
  // 环境文件覆盖共用配置
  const envLoaded = loadEnvFile(envPath, { override: true });

  return { sharedLoaded, envLoaded, sharedPath, envPath, rootDir: ROOT_DIR };
}

module.exports = {
  loadEnvForTarget,
  ENV_NAMES,
  ROOT_DIR,
};
