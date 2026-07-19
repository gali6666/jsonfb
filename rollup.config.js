import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import json from '@rollup/plugin-json';
import path from 'path';
import fs from 'fs';

// rollup -c 始终从包根目录执行，用 cwd 作为根目录（ESM 配置下没有 __dirname）
const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');

/**
 * 把根 package.json 派生出可发布的 dist/package.json：
 * 保留运行时信息，剥离 devDependencies 与构建脚本。
 * 最终产物只有单文件 dist/index.js（沙箱已打包进去），故 files 仅含 index.js。
 */
function writeDistPackageJson() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
  );
  const distPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'index.js',
    files: ['index.js', 'README.md', 'LICENSE'],
    repository: pkg.repository,
    keywords: pkg.keywords,
    author: pkg.author,
    license: pkg.license,
    dependencies: pkg.dependencies,
    peerDependencies: pkg.peerDependencies,
  };
  fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(distPkg, null, 2) + '\n'
  );
}

/**
 * Rollup 收尾插件：单文件打包完成后，组装出可直接 `yalc publish` 的 dist：
 *  - 拷贝 README/LICENSE
 *  - 生成 dist/package.json（只发 index.js 单文件）
 */
function assembleDist() {
  return {
    name: 'assemble-dist',
    writeBundle() {
      for (const file of ['README.md', 'LICENSE']) {
        const from = path.join(rootDir, file);
        if (fs.existsSync(from)) {
          fs.copyFileSync(from, path.join(distDir, file));
        }
      }
      writeDistPackageJson();
    },
  };
}

export default {
  input: 'index.js',
  output: {
    file: 'dist/index.js',
    format: 'cjs',
    exports: 'auto',
    compact: true,
  },
  external: (id) => {
    // 入口绝不能是 external（'index.js' 是裸标识符，需显式判定为内部）
    if (path.resolve(rootDir, id) === path.join(rootDir, 'index.js')) return false;

    // 业务源码（parse / stringify / 前置沙箱全部）一律打进单文件：
    // 凡相对/绝对路径都视为内部模块，被合并进 dist/index.js
    if (id.startsWith('.') || path.isAbsolute(id)) {
      // node_modules 里的绝对路径仍按外部处理（如 bignumber.js）
      if (/node_modules/.test(id)) return true;
      return false;
    }

    // 其余（node 内置模块 vm/fs/crypto/async_hooks…、bignumber.js、@ 别名）保持外部引用
    return true;
  },
  plugins: [
    json(),
    resolve({
      preferBuiltins: true,
      extensions: ['.js', '.json'],
    }),
    commonjs({
      ignoreDynamicRequires: true,
      ignore: ['bignumber.js'],
      transformMixedEsModules: true,
    }),
    babel({
      babelHelpers: 'bundled',
      presets: ['@babel/preset-env'],
    }),
    assembleDist(),
  ],
};
