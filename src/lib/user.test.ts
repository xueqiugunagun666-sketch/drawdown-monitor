import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, readName, MAX_NAME_LENGTH } from './user.ts';

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

test('从 cookie 读取，支持中文与多 cookie', () => {
  const mk = (c: string) => new Request('http://x/', { headers: { cookie: c } });
  assert.equal(readName(mk(`display_name=${encodeURIComponent('老王')}`)), '老王');
  assert.equal(readName(mk('access_token=abc; display_name=alice; other=1')), 'alice');
  assert.equal(readName(mk('access_token=abc')), null);
  assert.equal(readName(mk('')), null);
});

test('含百分号的名字不会被误解码', () => {
  // 解码只做一次。若为了兼容双重编码而解两次，"100%赢" 这类名字会被解坏。
  const mk = (v: string) => new Request('http://x/', { headers: { cookie: `display_name=${v}` } });
  assert.equal(readName(mk(encodeURIComponent('100%赢'))), '100%赢');
});
