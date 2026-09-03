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

test('不能复用已废弃的 cookie 名', () => {
  // access_token（全站口令）和 display_name（自填署名）都已经删掉了，
  // 但**用户浏览器里还留着这两个 cookie**，而且不会自己消失。
  // 会话 cookie 万一改名撞上它们，就会读到一个过期的旧值 ——
  // 表现是"莫名其妙以别人的身份登录"或者"登录状态时有时无"
  assert.notEqual(SESSION_COOKIE, 'access_token');
  assert.notEqual(SESSION_COOKIE, 'display_name');
});
