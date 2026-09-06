process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../../db/migrate.ts';
import * as wr from '../../../../db/walletRepo.ts';
import { hashToken } from '../../../../lib/session.ts';
import { GET, PATCH, POST } from './route.ts';

let alice: { id: string }, bob: { id: string };
const aliceToken = 'wallet-label-alice';
const bobToken = 'wallet-label-bob';

before(() => {
  runMigrations();
  alice = wr.createUser('wallet-label-alice', 'h')!;
  bob = wr.createUser('wallet-label-bob', 'h')!;
  wr.createSession(alice.id, hashToken(aliceToken), 9e9);
  wr.createSession(bob.id, hashToken(bobToken), 9e9);
});

const req = (token: string | null, method: string, body?: unknown) => new Request('http://x/api/wallet/wallets', {
  method,
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

test('未登录修改地址备注返回 401', async () => {
  assert.equal((await PATCH(req(null, 'PATCH', { address: address(1), label: '自己1' }))).status, 401);
});

test('添加时的备注会返回并可由本人 trim 后修改', async () => {
  const addr = address(2);
  const added = await POST(req(aliceToken, 'POST', {
    address: addr, label: '  自己1  ', chains: ['bsc', 'base'],
  }));
  assert.equal(added.status, 200);
  assert.deepEqual(
    wr.listWallets(alice.id).filter((w) => w.address === addr).map((w) => w.label),
    ['自己1', '自己1'],
  );

  const patched = await PATCH(req(aliceToken, 'PATCH', { address: addr, label: '  自己2  ' }));
  assert.equal(patched.status, 200);
  assert.deepEqual(
    wr.listWallets(alice.id).filter((w) => w.address === addr).map((w) => w.label),
    ['自己2', '自己2'],
  );

  const listed = await GET(req(aliceToken, 'GET'));
  assert.equal(listed.status, 200);
  const data = await listed.json() as { wallets: Array<{ address: string; label: string | null }> };
  assert.deepEqual(data.wallets.filter((w) => w.address === addr).map((w) => w.label), ['自己2', '自己2']);
});

test('备注清空传空串，其他用户不能改同地址', async () => {
  const addr = address(3);
  wr.addWallet(alice.id, 'bsc', addr, '原备注');

  const forbidden = await PATCH(req(bobToken, 'PATCH', { address: addr, label: '不应改到 A' }));
  assert.equal(forbidden.status, 404);
  assert.equal(wr.listWallets(alice.id).find((w) => w.address === addr)?.label, '原备注');

  const cleared = await PATCH(req(aliceToken, 'PATCH', { address: addr, label: '   ' }));
  assert.equal(cleared.status, 200);
  assert.equal(wr.listWallets(alice.id).find((w) => w.address === addr)?.label, null);
});

test('缺少 label 不会误清空备注', async () => {
  const addr = address(4);
  wr.addWallet(alice.id, 'bsc', addr, '保留');
  const res = await PATCH(req(aliceToken, 'PATCH', { address: addr }));
  assert.equal(res.status, 400);
  assert.equal(wr.listWallets(alice.id).find((w) => w.address === addr)?.label, '保留');
});
