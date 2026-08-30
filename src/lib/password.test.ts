import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

test('同一密码两次哈希结果不同（盐不同）', async () => {
  assert.notEqual(await hashPassword('hunter2'), await hashPassword('hunter2'));
});

test('正确密码校验通过，错误密码不通过', async () => {
  const h = await hashPassword('hunter2');
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('hunter3', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('哈希串里不含明文密码', async () => {
  const h = await hashPassword('correct-horse-battery-staple');
  assert.ok(!h.includes('correct-horse'));
  assert.ok(h.startsWith('scrypt$'));
});

test('损坏或伪造的哈希串返回 false，不抛错', async () => {
  // 抛错会让登录接口 500，从而泄露"这个用户存在但数据坏了"
  for (const bad of ['', 'garbage', 'scrypt$', 'scrypt$a$b$c$d$e', 'bcrypt$1$2$3$4$5']) {
    assert.equal(await verifyPassword('x', bad), false, `输入 ${JSON.stringify(bad)} 应返回 false`);
  }
});

test('中文与 emoji 密码可用', async () => {
  const h = await hashPassword('密码🔒很长很长');
  assert.equal(await verifyPassword('密码🔒很长很长', h), true);
  assert.equal(await verifyPassword('密码🔒很长很短', h), false);
});

test('长度不同的哈希不会因 timingSafeEqual 抛错', async () => {
  // timingSafeEqual 对不等长 Buffer 会抛 RangeError，必须先比长度
  const h = await hashPassword('x');
  const truncated = h.split('$').slice(0, 5).join('$') + '$' + Buffer.from('short').toString('base64');
  assert.equal(await verifyPassword('x', truncated), false);
});
