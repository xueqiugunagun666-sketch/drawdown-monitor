/**
 * 跑在内存库上。重点不是 CRUD 能不能用，而是**越权访问能不能被挡住** ——
 * 这个功能的全部意义就是"互不查看持仓"，仓储层是最后一道闸。
 */
process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import * as wr from './walletRepo.ts';

before(() => { runMigrations(); });

let seq = 0;
const mkUser = () => {
  const u = wr.createUser(`u${++seq}`, 'scrypt$fake');
  assert.ok(u, '测试用户创建失败 —— 用户名撞了？');
  return u;
};

test('用户名唯一，重复注册返回 null 而不是抛错', () => {
  const a = wr.createUser('dup-name', 'h');
  assert.ok(a);
  assert.equal(wr.createUser('dup-name', 'h'), null);
});

test('findUserByName 找得到也找得空', () => {
  wr.createUser('findme', 'hash-x');
  assert.equal(wr.findUserByName('findme')?.passwordHash, 'hash-x');
  assert.equal(wr.findUserByName('nobody'), null);
});

test('会话能建能查能删，过期的查不到', () => {
  const u = mkUser();
  wr.createSession(u.id, 'hash-live', 2000);
  assert.equal(wr.findUserBySessionHash('hash-live', 1000)?.id, u.id);
  assert.equal(wr.findUserBySessionHash('hash-live', 3000), null, '过期后必须查不到');
  wr.deleteSession('hash-live');
  assert.equal(wr.findUserBySessionHash('hash-live', 1000), null);
});

test('A 用户删不掉 B 用户的钱包', () => {
  const a = mkUser(), b = mkUser();
  const w = wr.addWallet(b.id, 'bsc', '0xbbb', null);
  assert.equal(wr.removeWallet(a.id, w!.id), false, '越权删除必须失败');
  assert.equal(wr.listWallets(b.id).length, 1, 'B 的钱包必须还在');
});

test('listWallets 只返回自己的', () => {
  const a = mkUser(), b = mkUser();
  wr.addWallet(a.id, 'bsc', '0xaaa1', null);
  wr.addWallet(b.id, 'bsc', '0xbbb1', null);
  const mine = wr.listWallets(a.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.address, '0xaaa1');
});

test('同一用户不能重复添加同链同地址', () => {
  const a = mkUser();
  assert.ok(wr.addWallet(a.id, 'bsc', '0xsame', null));
  assert.equal(wr.addWallet(a.id, 'bsc', '0xsame', null), null);
});

test('不同用户可以各自添加同一个地址', () => {
  const a = mkUser(), b = mkUser();
  assert.ok(wr.addWallet(a.id, 'bsc', '0xshared', null));
  assert.ok(wr.addWallet(b.id, 'bsc', '0xshared', null), '两个人可以看同一个地址');
});

test('listHoldings 不泄露他人持仓，即使持有同一个币', () => {
  const a = mkUser(), b = mkUser();
  const wa = wr.addWallet(a.id, 'bsc', '0xha', null)!;
  const wb = wr.addWallet(b.id, 'bsc', '0xhb', null)!;
  wr.upsertHolding(wa.id, 'bsc:0xtoken', '1000', 18, 100);
  wr.upsertHolding(wb.id, 'bsc:0xtoken', '9999', 18, 100);

  const ah = wr.listHoldings(a.id);
  assert.equal(ah.length, 1);
  assert.equal(ah[0]?.balance, '1000', 'A 只该看到自己的余额');
  assert.equal(wr.listHoldings(b.id)[0]?.balance, '9999');
});

test('余额是字符串存取，超过 2^53 不失真', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', '0xbig', null)!;
  const huge = '78409586395585725488444';
  wr.upsertHolding(w.id, 'bsc:0xt', huge, 18, 100);
  assert.equal(wr.listHoldings(a.id)[0]?.balance, huge);
});

test('usersHoldingToken 找出所有持有者，供报警扇出', () => {
  const a = mkUser(), b = mkUser(), c = mkUser();
  const wa = wr.addWallet(a.id, 'bsc', '0xfa', null)!;
  const wb = wr.addWallet(b.id, 'bsc', '0xfb', null)!;
  wr.addWallet(c.id, 'bsc', '0xfc', null);
  wr.upsertHolding(wa.id, 'bsc:0xfan', '1', 18, 100);
  wr.upsertHolding(wb.id, 'bsc:0xfan', '2', 18, 100);
  const holders = wr.usersHoldingToken('bsc:0xfan');
  assert.deepEqual(holders.map((h) => h.userId).sort(), [a.id, b.id].sort());
});

test('monitoredTokenIds 跨用户去重 —— 两人持有同一个币只算一次', () => {
  const a = mkUser(), b = mkUser();
  const wa = wr.addWallet(a.id, 'bsc', '0xma', null)!;
  const wb = wr.addWallet(b.id, 'bsc', '0xmb', null)!;
  wr.upsertHolding(wa.id, 'bsc:0xdedup', '1', 18, 100);
  wr.upsertHolding(wb.id, 'bsc:0xdedup', '1', 18, 100);
  wr.setHoldingMonitored(wa.id, 'bsc:0xdedup', true, null, null);
  wr.setHoldingMonitored(wb.id, 'bsc:0xdedup', true, null, null);
  assert.equal(wr.monitoredTokenIds().filter((t) => t === 'bsc:0xdedup').length, 1);
});

test('未监控的币不出现在 monitoredTokenIds 里', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', '0xun', null)!;
  wr.upsertHolding(w.id, 'bsc:0xunmon', '1', 18, 100);
  wr.setHoldingMonitored(w.id, 'bsc:0xunmon', false, '流动性不足', null);
  assert.ok(!wr.monitoredTokenIds().includes('bsc:0xunmon'));
  assert.equal(wr.listHoldings(a.id).find((h) => h.tokenId === 'bsc:0xunmon')?.filterReason, '流动性不足');
});

test('删钱包会级联删掉它的持仓', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', '0xcas', null)!;
  wr.upsertHolding(w.id, 'bsc:0xcascade', '1', 18, 100);
  assert.equal(wr.listHoldings(a.id).filter((h) => h.walletId === w.id).length, 1);
  assert.equal(wr.removeWallet(a.id, w.id), true);
  assert.equal(wr.listHoldings(a.id).filter((h) => h.walletId === w.id).length, 0);
});

test('报警按用户隔离', () => {
  const a = mkUser(), b = mkUser();
  wr.insertPumpAlert({
    id: 'al1', userId: a.id, tokenId: 'bsc:0xz', firedAt: 500, timeframe: '1h',
    basis: 'low', level: 2, multiple: '2.4', priceUsd: '1', basePriceUsd: '0.4',
    balance: '100', valueUsd: '100',
  });
  assert.equal(wr.listPumpAlerts(a.id, 0).length, 1);
  assert.equal(wr.listPumpAlerts(b.id, 0).length, 0, 'B 不该看到 A 的报警');
});

test('listPumpAlerts 按时间过滤，供 SSE 增量拉取', () => {
  const a = mkUser();
  for (const [id, at] of [['e1', 100], ['e2', 200], ['e3', 300]] as const) {
    wr.insertPumpAlert({
      id: `${a.id}-${id}`, userId: a.id, tokenId: 'bsc:0xq', firedAt: at, timeframe: '5m',
      basis: 'open', level: 2, multiple: '2', priceUsd: null, basePriceUsd: null,
      balance: null, valueUsd: null,
    });
  }
  assert.equal(wr.listPumpAlerts(a.id, 0).length, 3);
  assert.equal(wr.listPumpAlerts(a.id, 200).length, 2, 'sinceTs 应含等于该时刻的');
});

test('扫描状态更新：失败时错误被记录', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', '0xsc', null)!;
  wr.updateWalletScanState(w.id, 12345, 999, null);
  assert.equal(wr.listWallets(a.id).find((x) => x.id === w.id)?.lastScannedBlock, 12345);
  wr.updateWalletScanState(w.id, 12345, 1000, '节点超时');
  assert.equal(wr.listWallets(a.id).find((x) => x.id === w.id)?.lastScanError, '节点超时');
});

test('listAllEnabledWallets 跨用户返回，供 worker 扫描', () => {
  const before = wr.listAllEnabledWallets().length;
  const a = mkUser(), b = mkUser();
  wr.addWallet(a.id, 'bsc', '0xw1', null);
  wr.addWallet(b.id, 'base', '0xw2', null);
  assert.equal(wr.listAllEnabledWallets().length, before + 2);
});
