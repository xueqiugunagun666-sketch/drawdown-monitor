import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, MAX_NAME_LENGTH } from './sanitizeName.ts';

test('正常用户名原样保留', () => {
  assert.equal(sanitizeName('老王'), '老王');
  assert.equal(sanitizeName('  alice  '), 'alice');
});

test('压缩内部空白', () => {
  assert.equal(sanitizeName('张   三'), '张 三');
});

test('剔除控制字符，防止污染日志与 Telegram 消息排版', () => {
  assert.equal(sanitizeName('ali\u0000ce\n'), 'alice');
  assert.equal(sanitizeName('a\u001bb'), 'ab');
});

test('超长截断', () => {
  assert.equal(sanitizeName('x'.repeat(100))!.length, MAX_NAME_LENGTH);
});

test('空白名返回 null', () => {
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(''), null);
});
