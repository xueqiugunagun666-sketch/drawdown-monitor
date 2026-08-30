/**
 * 跑在内存库上。重点不是 CRUD 能不能用，而是**越权访问能不能被挡住** ——
 * 这个功能的全部意义就是"互不查看持仓"，仓储层是最后一道闸。
 */
process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import { getRawDb } from './index.ts';
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

test('钱包 candle：同格内 o 保留首次、h/l 取极值、c 取最新', () => {
  const db = getRawDb();
  const id = 'bsc:0xcandle';
  // 从对齐后的格起点算偏移，且全部 < 300，确保四次都落在同一格
  const slot = Math.floor(1_700_000_000 / 300) * 300;
  wr.upsertWalletCandle(id, '10', 1000, slot + 10);
  wr.upsertWalletCandle(id, '25', 1000, slot + 60);
  wr.upsertWalletCandle(id, '4', 1000, slot + 120);
  wr.upsertWalletCandle(id, '15', 1000, slot + 299);
  const row = db.prepare(`SELECT o,h,l,c FROM candles WHERE token_id=? AND ts=?`).get(id, slot) as
    { o: string; h: string; l: string; c: string };
  assert.equal(row.o, '10', 'o 应保留首次');
  assert.equal(row.h, '25');
  assert.equal(row.l, '4');
  assert.equal(row.c, '15', 'c 应是最新');
});

test('钱包 candle：跨格会新建一根，历史就是这样攒起来的', () => {
  const db = getRawDb();
  const id = 'bsc:0xslots';
  wr.upsertWalletCandle(id, '1', 1000, 1_700_000_000);
  wr.upsertWalletCandle(id, '2', 1000, 1_700_000_300);
  wr.upsertWalletCandle(id, '3', 1000, 1_700_000_600);
  const n = db.prepare(`SELECT COUNT(*) c FROM candles WHERE token_id=?`).get(id) as { c: number };
  assert.equal(n.c, 3);
});

test('钱包 candle：写入时刻会向下对齐到 5m 格', () => {
  const db = getRawDb();
  const id = 'bsc:0xalign';
  wr.upsertWalletCandle(id, '1', 1000, 1_700_000_299);
  const row = db.prepare(`SELECT ts FROM candles WHERE token_id=?`).get(id) as { ts: number };
  assert.equal(row.ts % 300, 0, 'ts 必须是 300 的整数倍');
  assert.equal(row.ts, 1_700_000_100);
});

test('钱包 candle：极小价格不丢精度', () => {
  const db = getRawDb();
  const id = 'bsc:0xtiny';
  wr.upsertWalletCandle(id, '0.000000000001234', 1000, 1_700_000_000);
  const row = db.prepare(`SELECT o FROM candles WHERE token_id=?`).get(id) as { o: string };
  assert.equal(row.o, '0.000000000001234');
});

test('同一地址跨多链各建一行，扫描水位互不干扰', () => {
  const u = wr.createUser(`multi${++seq}`, 'h')!;
  const addr = '0xmultichain';
  const ids: string[] = [];
  for (const c of ['ethereum', 'bsc', 'base', 'robinhood']) {
    const w = wr.addWallet(u.id, c, addr, '我的钱包');
    assert.ok(w, `${c} 应能添加`);
    ids.push(w.id);
  }
  assert.equal(wr.listWallets(u.id).length, 4);

  // 各链水位独立
  wr.updateWalletScanState(ids[0]!, 111, 100, null);
  wr.updateWalletScanState(ids[1]!, 222, 100, null);
  const rows = wr.listWallets(u.id);
  assert.equal(rows.find((r) => r.chain === 'ethereum')?.lastScannedBlock, 111);
  assert.equal(rows.find((r) => r.chain === 'bsc')?.lastScannedBlock, 222);
  assert.equal(rows.find((r) => r.chain === 'base')?.lastScannedBlock, null);
});

test('按地址删除会带走该地址在所有链上的行', () => {
  const u = wr.createUser(`rmall${++seq}`, 'h')!;
  const addr = '0xremoveall';
  for (const c of ['ethereum', 'bsc', 'base']) wr.addWallet(u.id, c, addr, null);
  wr.addWallet(u.id, 'bsc', '0xkeepthis', null);
  assert.equal(wr.listWallets(u.id).length, 4);

  assert.equal(wr.removeWalletByAddress(u.id, addr), 3);
  const left = wr.listWallets(u.id);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.address, '0xkeepthis');
});

test('按地址删除删不掉别人的', () => {
  const a = wr.createUser(`rma${++seq}`, 'h')!, b = wr.createUser(`rmb${++seq}`, 'h')!;
  wr.addWallet(b.id, 'bsc', '0xbobaddr', null);
  assert.equal(wr.removeWalletByAddress(a.id, '0xbobaddr'), 0);
  assert.equal(wr.listWallets(b.id).length, 1);
});

test('地址大小写归一 —— 同一地址不同写法不该建出两组', () => {
  const u = wr.createUser(`case${++seq}`, 'h')!;
  assert.ok(wr.addWallet(u.id, 'bsc', '0xAbCdEf0123', null));
  assert.equal(wr.addWallet(u.id, 'bsc', '0xabcdef0123', null), null, '大小写不同也算重复');
});

test('监控中的币每轮都要判', () => {
  const u = wr.createUser(`due${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdue${seq}`, null)!;
  const id = `bsc:0xmon${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  wr.markTokenEvaluated(id, 1000);
  assert.ok(wr.tokenIdsDueForEval(1001).includes(id), '刚判过也要继续判');
});

test('被挡掉的币 30 分钟内不重复判', () => {
  const u = wr.createUser(`due2${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdue2${seq}`, null)!;
  const id = `bsc:0xrej${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, false, '流动性不足', null);
  wr.markTokenEvaluated(id, 1000);
  assert.ok(!wr.tokenIdsDueForEval(1000 + 60).includes(id), '刚判过不该重判');
  assert.ok(wr.tokenIdsDueForEval(1000 + wr.REJECTED_RECHECK_SECONDS).includes(id), '满 30 分钟要重判');
});

test('从未判定过的币一定要判 —— 否则新扫到的币永远进不来', () => {
  const u = wr.createUser(`due3${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdue3${seq}`, null)!;
  const id = `bsc:0xfresh${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  assert.ok(wr.tokenIdsDueForEval(999999).includes(id));
});

test('markTokenEvaluated 不会抹掉已有的持有人数', () => {
  const id = 'bsc:0xkeepmeta';
  wr.setTokenMeta(id, 705786, 'MOONALD', 500);
  wr.markTokenEvaluated(id, 900);
  const m = wr.getTokenMeta(id);
  assert.equal(m?.holderCount, 705786, '判定标记不该冲掉持有人数');
  assert.equal(m?.symbol, 'MOONALD');
});

test('decimals 未知的币不参与判定', () => {
  const u = wr.createUser(`due4${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdue4${seq}`, null)!;
  const id = `bsc:0xnodec${seq}`;
  wr.upsertHolding(w.id, id, '1', null, 100);
  assert.ok(!wr.tokenIdsDueForEval(999999).includes(id));
});

test('离谱跳变的报价不写进 candle', () => {
  const id = 'bsc:0xjunkquote';
  const slot = Math.floor(1_700_100_000 / 300) * 300;
  assert.equal(wr.upsertWalletCandle(id, '1', 1000, slot), true);
  // 实测 USDG 那根：正常约 1 美元，DexScreener 给了 5.56e-24
  assert.equal(wr.upsertWalletCandle(id, '0.000000000000000000000005563', 1000, slot + 300), false,
    '5.56e-24 相对 1 是 1e24 倍跳变，必须丢弃');
  const n = getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=?`).get(id) as { c: number };
  assert.equal(n.c, 1, '垃圾报价不该建出新 candle');
});

test('正常波动照常写入', () => {
  const id = 'bsc:0xnormalmove';
  const slot = Math.floor(1_700_200_000 / 300) * 300;
  wr.upsertWalletCandle(id, '1', 1000, slot);
  assert.equal(wr.upsertWalletCandle(id, '5', 1000, slot + 300), true, '5 倍是正常行情');
  assert.equal(wr.upsertWalletCandle(id, '500', 1000, slot + 600), true, '100 倍也放行');
});

test('第一根没有参照，直接写入', () => {
  const id = 'bsc:0xfirstcandle';
  assert.equal(wr.upsertWalletCandle(id, '0.000000000001', 1000, 1_700_300_000), true);
});

test('跳变守卫用的是上一根收盘，不是同格内的值', () => {
  const id = 'bsc:0xsameslot';
  const slot = Math.floor(1_700_400_000 / 300) * 300;
  wr.upsertWalletCandle(id, '1', 1000, slot);
  // 同一格内再写一次正常值
  assert.equal(wr.upsertWalletCandle(id, '1.5', 1000, slot + 100), true);
});
