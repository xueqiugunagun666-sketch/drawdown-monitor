/**
 * 直接打路由函数，不经过 HTTP —— 权限是后端边界，
 * 前端隐藏按钮不算数，必须在这一层验证。
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'boss';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../db/migrate.ts';
import * as repo from '../../../db/repo.ts';
import * as wr from '../../../db/walletRepo.ts';
import { hashToken } from '../../../lib/session.ts';
import { GET, PUT } from './route.ts';

let bobTok: string, bossTok: string;

before(() => {
  runMigrations();
  const boss = wr.createUser('boss', 'h')!;
  const bob = wr.createUser('bob', 'h')!;
  bossTok = 'tok-boss'; bobTok = 'tok-bob';
  wr.createSession(boss.id, hashToken(bossTok), 9e9);
  wr.createSession(bob.id, hashToken(bobTok), 9e9);

  repo.upsertRule({
    id: 'default', tokenId: null, type: 'drawdown',
    athMode: 'rolling_90d', quoteMode: 'usd', levels: JSON.stringify([80, 85, 90, 95]),
    confirmTicks: 2, hysteresis: 15, rearmMinutes: 60, minLiquidityUsd: 5000,
    athSustainCandles: 3, cooldownMinutes: 30, bouncePct: 25, channels: null, enabled: 1,
  });
});

const req = (token: string | null, body?: unknown) => new Request('http://x/', {
  method: 'PUT',
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('未登录 PUT 返回 401', async () => {
  assert.equal((await PUT(req(null, { hysteresis: 20 }))).status, 401);
});

test('普通用户 PUT 返回 403，且规则不变', async () => {
  const res = await PUT(req(bobTok, { hysteresis: 20 }));
  assert.equal(res.status, 403);
  assert.equal(repo.listRules().find((r) => r.id === 'default')!.hysteresis, 15, '403 之后不能生效');
});

test('管理员 PUT 成功', async () => {
  const res = await PUT(req(bossTok, { hysteresis: 20 }));
  assert.equal(res.status, 200);
  assert.equal(repo.listRules().find((r) => r.id === 'default')!.hysteresis, 20);
});

test('普通用户 GET 200 —— 档位是所有人都该看到的', async () => {
  // 必须带会话。这条原本用的是匿名请求，当时能过是因为 GET 只查全站口令，
  // 而测试环境没设 ACCESS_TOKEN 所以直接放行 —— 验的其实不是「普通用户」。
  // 全站口令撤掉之后只读接口也要会话，改成带 bob 的 cookie 才是本意
  const res = await GET(req(bobTok));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.rules));
});

test('未登录 GET 401 —— 只读接口也不能裸奔', async () => {
  // 中间件只能判断 cookie 存不存在、判断不了有没有效，
  // 所以每个路由都得自查，只读的也不例外
  assert.equal((await GET(new Request('http://x/'))).status, 401);
});
