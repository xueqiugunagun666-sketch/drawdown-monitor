/**
 * 直接打路由函数，不经过 HTTP —— 权限是后端边界，
 * 前端隐藏按钮不算数，必须在这一层验证。
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'boss';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../../db/migrate.ts';
import * as repo from '../../../../db/repo.ts';
import * as wr from '../../../../db/walletRepo.ts';
import { hashToken } from '../../../../lib/session.ts';
import { DELETE, PATCH } from './route.ts';

let boss: { id: string }, alice: { id: string }, bobTok: string, aliceTok: string, bossTok: string;

before(() => {
  runMigrations();
  boss = wr.createUser('boss', 'h')!;
  alice = wr.createUser('alice', 'h')!;
  const bob = wr.createUser('bob', 'h')!;
  bossTok = 'tok-boss'; aliceTok = 'tok-alice'; bobTok = 'tok-bob';
  wr.createSession(boss.id, hashToken(bossTok), 9e9);
  wr.createSession(alice.id, hashToken(aliceTok), 9e9);
  wr.createSession(bob.id, hashToken(bobTok), 9e9);
});

const req = (token: string | null, body?: unknown) => new Request('http://x/', {
  method: 'POST',
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id: encodeURIComponent(id) }) });

let n = 0;
const mkToken = (ownerId: string | null) => {
  const addr = `0x${(++n).toString().padStart(40, '0')}`;
  repo.addToken({ chain: 'bsc', address: addr, note: '原备注', ownerId });
  return `bsc:${addr}`;
};

test('未登录删除返回 401', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(null), ctx(id))).status, 401);
});

test('普通用户删别人的返回 403，且代币还在', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(bobTok), ctx(id))).status, 403);
  assert.ok(repo.getToken(id), '403 之后代币必须还在');
});

test('普通用户删无主的返回 403 —— NULL 不属于任何人', async () => {
  const id = mkToken(null);
  assert.equal((await DELETE(req(aliceTok), ctx(id))).status, 403);
});

test('本人删自己的成功', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(aliceTok), ctx(id))).status, 200);
  assert.equal(repo.getToken(id), undefined);
});

test('管理员删无主的成功', async () => {
  const id = mkToken(null);
  assert.equal((await DELETE(req(bossTok), ctx(id))).status, 200);
});

test('普通用户改别人的备注 403', async () => {
  const id = mkToken(alice.id);
  assert.equal((await PATCH(req(bobTok, { note: '篡改' }), ctx(id))).status, 403);
  assert.equal(repo.getToken(id)!.note, '原备注');
});

test('普通用户改 enabled 403，管理员可以', async () => {
  const id = mkToken(alice.id);
  assert.equal((await PATCH(req(aliceTok, { enabled: false }), ctx(id))).status, 403);
  assert.equal(repo.getToken(id)!.enabled, 1, '403 之后不能生效');
  assert.equal((await PATCH(req(bossTok, { enabled: false }), ctx(id))).status, 200);
});

test('置顶任何登录用户都能改，包括别人的和无主的', async () => {
  const a = mkToken(alice.id);
  assert.equal((await PATCH(req(bobTok, { pinned: true }), ctx(a))).status, 200);
  const b = mkToken(null);
  assert.equal((await PATCH(req(bobTok, { pinned: true }), ctx(b))).status, 200);
});

test('原子性：note + enabled 一起提交且无权改 enabled，note 也不能落库', async () => {
  const id = mkToken(alice.id);
  const res = await PATCH(req(aliceTok, { note: '新备注', enabled: false }), ctx(id));
  assert.equal(res.status, 403);
  assert.equal(repo.getToken(id)!.note, '原备注', '部分成功会让人以为整体成功了');
});

test('原子性：pinned + note 改别人的，pinned 也不能落库', async () => {
  const id = mkToken(alice.id);
  const res = await PATCH(req(bobTok, { pinned: true, note: '篡改' }), ctx(id));
  assert.equal(res.status, 403);
  assert.equal(repo.getToken(id)!.pinned, 0);
});
