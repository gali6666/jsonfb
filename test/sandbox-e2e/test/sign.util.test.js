'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// 经 yalc 链接的被测包（深路径访问全部签名工具）
const signUtil = require('jsonfb/lib/sandbox/sign.util');
// 远端 mock 服务的独立签名实现，用于交叉验证算法一致
const mockSign = require('../../remote-mock-server/sign');

const SECRET = {
  secretKey: 'key',
  secretValue: 'f3967bc7-176b-195f-b273-afb33f4b76a3',
};

describe('sign.util (via yalc-linked package)', () => {
  test('md5 已知向量与大小写', () => {
    assert.strictEqual(signUtil.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.strictEqual(signUtil.md5('abc', 1), '900150983CD24FB0D6963F7D28E17F72');
    assert.strictEqual(signUtil.md5('abc', 2), '900150983cd24fb0d6963f7d28e17f72');
  });

  test('simpleSortParams 排序/忽略 sign/跳过空值/数组序列化', () => {
    assert.strictEqual(signUtil.simpleSortParams({ b: 2, a: 1, sign: 'x' }), 'a=1&b=2');
    assert.strictEqual(
      signUtil.simpleSortParams({ a: '', b: null, c: undefined, d: 1 }),
      'd=1'
    );
    assert.strictEqual(signUtil.simpleSortParams({ a: [1, 2] }), 'a=[1,2]');
  });

  test('recursiveSortParams 递归嵌套对象', () => {
    assert.strictEqual(
      signUtil.recursiveSortParams({ b: { y: 2, x: 1 }, a: 1 }),
      'a=1&b=x=1&y=2'
    );
  });

  test('signWithMD5 简单模式与服务端实现交叉一致', () => {
    const data = { message: '[Front-1.0.0] hello' };
    const pkg = signUtil.signWithMD5(data, SECRET);
    const srv = mockSign.computeSign(data, { ...SECRET, recursive: false });
    assert.strictEqual(pkg, srv);
    assert.match(pkg, /^[a-f0-9]{32}$/);
  });

  test('signWithMD5 递归模式与服务端实现交叉一致', () => {
    const data = { hash: '1' };
    const pkg = signUtil.signWithMD5(data, { ...SECRET, recursiveSortParams: true });
    const srv = mockSign.computeSign(data, { ...SECRET, recursive: true });
    assert.strictEqual(pkg, srv);

    const nested = { hash: 'abc', meta: { z: 9, a: 1 } };
    const pkg2 = signUtil.signWithMD5(nested, { ...SECRET, recursiveSortParams: true });
    const srv2 = mockSign.computeSign(nested, { ...SECRET, recursive: true });
    assert.strictEqual(pkg2, srv2);
  });

  test('signWithHmacSha256 字符串/对象、确定性与密钥敏感', () => {
    const a = signUtil.signWithHmacSha256('abc', 'secret');
    const b = signUtil.signWithHmacSha256('abc', 'secret');
    const c = signUtil.signWithHmacSha256('abc', 'other');
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);

    // 对象入参走 recursiveSortParams 后再 HMAC，键序不影响结果
    const o1 = signUtil.signWithHmacSha256({ a: 1, b: 2 }, 'k');
    const o2 = signUtil.signWithHmacSha256({ b: 2, a: 1 }, 'k');
    assert.strictEqual(o1, o2);
  });

  test('bigint 值按十进制字符串参与签名', () => {
    assert.strictEqual(signUtil.simpleSortParams({ n: 10n }), 'n=10');
  });

  test('recursiveSortParams 严格 ASCII 排序分支（大写在小写之前 + 长度兜底）', () => {
    // useAsciiSort=true：按 charCode 比较，'B'(66) < 'a'(97)
    assert.strictEqual(
      signUtil.recursiveSortParams({ B: 1, a: 2 }, ['sign'], true),
      'B=1&a=2'
    );
    // 前缀相同的情况下，较短的 key 在前（compareKeys 的 length 兜底分支）
    assert.strictEqual(
      signUtil.recursiveSortParams({ abc: 2, ab: 1 }, ['sign'], true),
      'ab=1&abc=2'
    );
  });

  test('Decimal-like 值按 toString 参与签名（两种识别路径）', () => {
    // 路径①：结构特征 d/e/s + toNumber
    const decimalLike = {
      d: [1, 5],
      e: 0,
      s: 1,
      toNumber: () => 1.5,
      toString: () => '1.5',
    };
    assert.strictEqual(signUtil.simpleSortParams({ amount: decimalLike }), 'amount=1.5');

    // 路径②：constructor.name === 'Decimal'
    class Decimal {
      toString() {
        return '9';
      }
    }
    assert.strictEqual(signUtil.simpleSortParams({ x: new Decimal() }), 'x=9');
  });

  test('signWithMD5 支持大小写输出（UppercaseOrLowercase）', () => {
    const upper = signUtil.signWithMD5({ a: '1' }, { ...SECRET, UppercaseOrLowercase: 1 });
    const lower = signUtil.signWithMD5({ a: '1' }, { ...SECRET, UppercaseOrLowercase: 2 });
    assert.match(upper, /^[A-F0-9]{32}$/);
    assert.match(lower, /^[a-f0-9]{32}$/);
    assert.strictEqual(upper, lower.toUpperCase());
  });

  test('simpleSortParams 对嵌套对象非递归（[object Object]）', () => {
    assert.strictEqual(signUtil.simpleSortParams({ o: { a: 1 } }), 'o=[object Object]');
  });
});
