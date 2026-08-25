import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mask, registerSecret, scrubSecrets, safeErrorMessage } from './mask.ts';

test('掩码保留前 4 后 4', () => {
  assert.equal(mask('sk-abcdefgh1234wxyz'), 'sk-a...wxyz');
  assert.equal(mask(undefined), '<unset>');
  assert.equal(mask(''), '<empty>');
});

test('过短的值整体隐藏，不泄漏可枚举片段', () => {
  assert.equal(mask('short'), '***');
  assert.equal(mask('12345678901'), '***');
});

test('已注册密钥会从任意文本中抹掉', () => {
  const secret = 'aaaabbbbccccddddeeee';
  registerSecret(secret);
  const text = `请求失败: https://api.example.com/bot${secret}/sendMessage`;
  const out = scrubSecrets(text);
  assert.ok(!out.includes(secret), '原始密钥不得出现');
  assert.ok(out.includes('aaaa...eeee'), '应替换为掩码值');
});

test('未注册的 Telegram token 也被兜底掩码', () => {
  const text = 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage';
  const out = scrubSecrets(text);
  assert.ok(!out.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'));
  assert.ok(out.includes('123456789:'), 'bot id 可保留，token 部分掩码');
});

test('错误消息经掩码后才输出', () => {
  const secret = 'zzzz1111yyyy2222xxxx';
  registerSecret(secret);
  const err = new Error(`connect failed with token=${secret}`);
  assert.ok(!safeErrorMessage(err).includes(secret));
});
