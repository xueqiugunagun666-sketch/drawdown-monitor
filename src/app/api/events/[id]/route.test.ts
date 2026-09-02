process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'boss';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../../db/migrate.ts';
import * as repo from '../../../../db/repo.ts';
import * as wr from '../../../../db/walletRepo.ts';
import { hashToken } from '../../../../lib/session.ts';
import { DELETE, PATCH } from './route.ts';

let boss: { id: string }, alice: { id: string };
let bossTok = 'e-boss', aliceTok = 'e-alice', bobTok = 'e-bob';

before(() => {
  runMigrations();
  boss = wr.createUser('boss', 'h')!;
  alice = wr.createUser('alice', 'h')!;
  const bob = wr.createUser('bob', 'h')!;
  wr.createSession(boss.id, hashToken(bossTok), 9e9);
  wr.createSession(alice.id, hashToken(aliceTok), 9e9);
  wr.createSession(bob.id, hashToken(bobTok), 9e9);
});

const req = (token: string | null, body?: unknown) => new Request('http://x/', {
  method: 'POST',
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let n = 0;
const mkEvent = (ownerId: string | null) => {
  const id = `ev-${++n}`;
  repo.upsertEvent({ id, title: '原标题', atTs: 9e8, inputTz: 'Asia/Shanghai',
    priority: 'normal', remindOffsets: '[0]', createdAt: 1, ownerId });
  return id;
};

test('未登录删日程 401', async () => {
  assert.equal((await DELETE(req(null), ctx(mkEvent(alice.id)))).status, 401);
});

test('删别人的日程 403，日程还在', async () => {
  const id = mkEvent(alice.id);
  assert.equal((await DELETE(req(bobTok), ctx(id))).status, 403);
  assert.ok(repo.getEvent(id));
});

test('删无主日程 403', async () => {
  assert.equal((await DELETE(req(aliceTok), ctx(mkEvent(null)))).status, 403);
});

test('本人删自己的、管理员删无主的，都成功', async () => {
  const own = mkEvent(alice.id);
  assert.equal((await DELETE(req(aliceTok), ctx(own))).status, 200);
  const orphan = mkEvent(null);
  assert.equal((await DELETE(req(bossTok), ctx(orphan))).status, 200);
});

test('改别人的日程 403，标题不变', async () => {
  const id = mkEvent(alice.id);
  assert.equal((await PATCH(req(bobTok, { title: '篡改' }), ctx(id))).status, 403);
  assert.equal(repo.getEvent(id)!.title, '原标题');
});
