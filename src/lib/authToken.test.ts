import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches, checkRateLimit, recordFailure, clearFailures, clientIp } from './authToken.ts';

test('口令一致才通过', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc124', 'abc123'), false);
});

test('长度不同也安全返回 false，不抛错', () => {
  assert.equal(tokenMatches('short', 'a-much-longer-token'), false);
  assert.equal(tokenMatches('', 'x'), false);
});

test('限流：超过次数后拒绝，并给出等待时间', () => {
  const ip = '1.2.3.4';
  clearFailures(ip);
  for (let i = 0; i < 8; i++) {
    assert.equal(checkRateLimit(ip).allowed, true, `第 ${i + 1} 次应放行`);
    recordFailure(ip);
  }
  const r = checkRateLimit(ip);
  assert.equal(r.allowed, false, '第 9 次应被拦');
  assert.ok(r.retryAfterSeconds > 0);
});

test('登录成功后清空失败计数', () => {
  const ip = '5.6.7.8';
  clearFailures(ip);
  for (let i = 0; i < 8; i++) recordFailure(ip);
  assert.equal(checkRateLimit(ip).allowed, false);
  clearFailures(ip);
  assert.equal(checkRateLimit(ip).allowed, true);
});

test('限流按 IP 隔离，一个人被拦不影响别人', () => {
  const a = '10.0.0.1', b = '10.0.0.2';
  clearFailures(a); clearFailures(b);
  for (let i = 0; i < 8; i++) recordFailure(a);
  assert.equal(checkRateLimit(a).allowed, false);
  assert.equal(checkRateLimit(b).allowed, true);
});

test('从反代头里取真实 IP', () => {
  const mk = (h: Record<string, string>) => new Request('http://x/', { headers: h });
  assert.equal(clientIp(mk({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(clientIp(mk({ 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIp(mk({})), 'unknown');
});
