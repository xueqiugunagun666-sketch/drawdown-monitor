import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSessionToken, hashToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from './session.ts';

test('会话 token 足够长且每次不同', () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43, `32 字节 base64url 应至少 43 字符，实际 ${a.length}`);
});

test('token 是 URL 安全的（要放进 cookie）', () => {
  assert.match(newSessionToken(), /^[A-Za-z0-9_-]+$/);
});

test('hashToken 稳定、定长、不可逆', () => {
  const t = newSessionToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.equal(hashToken(t).length, 64);            // sha256 hex
  assert.ok(!hashToken(t).includes(t));
});

test('不同 token 哈希不同', () => {
  assert.notEqual(hashToken(newSessionToken()), hashToken(newSessionToken()));
});

test('TTL 有限且合理', () => {
  assert.ok(SESSION_TTL_SECONDS > 0 && SESSION_TTL_SECONDS <= 90 * 86400);
});

test('cookie 名与全站口令的 cookie 不冲突', () => {
  assert.notEqual(SESSION_COOKIE, 'access_token');
  assert.notEqual(SESSION_COOKIE, 'display_name');
});
