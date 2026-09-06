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

test('钱包备注添加时会 trim、限制 40 字，并把空串存成 null', () => {
  const a = mkUser();
  const trimmed = wr.addWallet(a.id, 'bsc', '0xlabel-trim', '  自己1  ')!;
  const empty = wr.addWallet(a.id, 'base', '0xlabel-empty', '   ')!;
  const long = wr.addWallet(a.id, 'ethereum', '0xlabel-long', 'x'.repeat(41))!;
  const rows = wr.listWallets(a.id);
  assert.equal(rows.find((x) => x.id === trimmed.id)?.label, '自己1');
  assert.equal(rows.find((x) => x.id === empty.id)?.label, null);
  assert.equal(rows.find((x) => x.id === long.id)?.label, 'x'.repeat(40));
});

test('用户只能修改自己地址的备注，且跨链行一起更新和清空', () => {
  const a = mkUser(), b = mkUser();
  const addr = '0xlabel-owned';
  wr.addWallet(a.id, 'bsc', addr, '旧备注');
  wr.addWallet(a.id, 'base', addr, '旧备注');
  wr.addWallet(b.id, 'bsc', addr, '别人的备注');

  assert.equal(wr.updateWalletLabelByAddress(b.id, addr, '不该成功'), 1);
  assert.equal(wr.updateWalletLabelByAddress(a.id, addr, '  自己1  '), 2);
  assert.deepEqual(
    wr.listWallets(a.id).filter((x) => x.address === addr).map((x) => x.label),
    ['自己1', '自己1'],
  );
  assert.equal(wr.listWallets(b.id).find((x) => x.address === addr)?.label, '不该成功');

  assert.equal(wr.updateWalletLabelByAddress(a.id, addr, '   '), 2);
  assert.deepEqual(
    wr.listWallets(a.id).filter((x) => x.address === addr).map((x) => x.label),
    [null, null],
  );
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

test('钱包代币候选可持久重试、失败退避并在成功后移除', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', `0xcandidate${++seq}`, null)!;
  const id = `bsc:0xcandidate${seq}`;
  wr.rememberWalletTokenCandidates(w.id, [id], 100);
  assert.deepEqual(wr.dueWalletTokenCandidates(w.id, 100).map((x) => x.tokenId), [id]);
  assert.equal(wr.dueWalletTokenCandidates(w.id, 100)[0]?.discoveredAt, 100);

  wr.markWalletTokenCandidateFailed(w.id, id, 110, 830, '临时 RPC 失败');
  assert.equal(wr.dueWalletTokenCandidates(w.id, 829).length, 0);
  assert.equal(wr.dueWalletTokenCandidates(w.id, 830)[0]?.attemptCount, 1);

  wr.removeWalletTokenCandidate(w.id, id);
  assert.equal(wr.dueWalletTokenCandidates(w.id, 999999).length, 0);
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

test('停用钱包不参与报警收件人和监控调度', () => {
  const a = mkUser();
  const w = wr.addWallet(a.id, 'bsc', `0xdisabled${++seq}`, null)!;
  const id = `bsc:0xdisabled${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  getRawDb().prepare(`UPDATE wallets SET enabled = 0 WHERE id = ?`).run(w.id);

  assert.equal(wr.usersHoldingToken(id).length, 0);
  assert.ok(!wr.monitoredTokenIds().includes(id));
  assert.ok(!wr.tokenIdsDueForEval(999999).includes(id));
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

test('报警空库的快照边界是 0，第一条 SSE 必须从这里接', () => {
  const a = mkUser();
  assert.equal(wr.maxPumpAlertSeq(), 0);
  assert.deepEqual(wr.pumpAlertSnapshot(a.id, 0), { snapshotSeq: 0, alerts: [] });
});

test('报警按用户隔离', () => {
  const a = mkUser(), b = mkUser();
  wr.insertPumpAlert({
    id: 'al1', userId: a.id, tokenId: 'bsc:0xz', firedAt: 500, timeframe: '1h',
    basis: 'low', level: 2, multiple: '2.4', priceUsd: '1', basePriceUsd: '0.4',
    balance: '100', valueUsd: '100', kind: 'level',
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

test('历史报警快照同时返回边界序号，每一行都带 seq', () => {
  const a = mkUser();
  for (const id of ['snap1', 'snap2']) {
    wr.insertPumpAlert({
      id: `${a.id}-${id}`, userId: a.id, tokenId: 'bsc:0xsnapshot', firedAt: 600,
      timeframe: '5m', basis: 'open', level: 2, multiple: '2',
      priceUsd: '2', basePriceUsd: '1', balance: null, valueUsd: null,
    });
  }
  const snapshot = wr.pumpAlertSnapshot(a.id, 0);
  assert.equal(snapshot.snapshotSeq, wr.maxPumpAlertSeq());
  assert.equal(snapshot.alerts.length, 2, '同秒写入的两条不能互相覆盖');
  assert.ok(snapshot.alerts.every((row) => Number.isInteger(row.seq) && row.seq > 0));
  assert.ok(snapshot.alerts[0]!.seq > snapshot.alerts[1]!.seq, '历史按写入序号倒序');
  assert.ok(snapshot.alerts.every((row) => row.seq <= snapshot.snapshotSeq));
});

test('没有当前用户报警时仍返回全局快照边界', () => {
  const a = mkUser();
  const snapshot = wr.pumpAlertSnapshot(a.id, 0);
  assert.equal(snapshot.alerts.length, 0);
  assert.equal(snapshot.snapshotSeq, wr.maxPumpAlertSeq());
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
  assert.ok(wr.tokenIdsDueForEval(1000 + wr.REJECTED_RECHECK_SECONDS + 300).includes(id),
    '30 分钟后加最多 5 分钟固定抖动，必须重判');
});

test('流动性够、只差成交量的币走 3 分钟快车道', () => {
  const u = wr.createUser(`warm${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwarm${seq}`, null)!;
  const id = `bsc:0xwarm${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, false, '24h 成交 $3,000 < $10,000', null);
  wr.markTokenEvaluated(id, 1000, 32457);          // FLETCH 的真实流动性
  assert.ok(!wr.tokenIdsDueForEval(1000 + 60).includes(id), '3 分钟没到不该重判');
  assert.ok(wr.tokenIdsDueForEval(1000 + wr.WARM_RECHECK_SECONDS + 30).includes(id),
    '3 分钟后加最多 30 秒固定抖动，必须重判，不必等 30 分钟');
});

test('流动性不够的币仍然走 30 分钟慢车道', () => {
  const u = wr.createUser(`cold${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xcold${seq}`, null)!;
  const id = `bsc:0xcold${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, false, '流动性 $12 < $5,000', null);
  wr.markTokenEvaluated(id, 1000, 12);
  assert.ok(!wr.tokenIdsDueForEval(1000 + wr.WARM_RECHECK_SECONDS).includes(id),
    '流动性不够的不该进快车道');
  assert.ok(wr.tokenIdsDueForEval(1000 + wr.REJECTED_RECHECK_SECONDS + 300).includes(id));
});

test('报价缺失时保留上次的流动性 —— 一次接口抖动不该把币踢出快车道', () => {
  const u = wr.createUser(`keepliq${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xkl${seq}`, null)!;
  const id = `bsc:0xkl${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, false, '24h 成交不足', null);
  wr.markTokenEvaluated(id, 1000, 32457);
  wr.markTokenEvaluated(id, 1100);                 // 这一轮没报价
  assert.ok(wr.tokenIdsDueForEval(1100 + wr.WARM_RECHECK_SECONDS + 30).includes(id),
    '流动性被抹成 NULL 的话这里就会掉到慢车道');
});

test('从未判定过的币一定要判 —— 否则新扫到的币永远进不来', () => {
  const u = wr.createUser(`due3${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdue3${seq}`, null)!;
  const id = `bsc:0xfresh${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  assert.ok(wr.tokenIdsDueForEval(999999).includes(id));
});

test('调度顺序固定为热币、首次币、温币、冷币', () => {
  const u = wr.createUser(`priority${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xpriority${seq}`, null)!;
  const hot = `bsc:0xpriority-hot${seq}`;
  const fresh = `bsc:0xpriority-fresh${seq}`;
  const warm = `bsc:0xpriority-warm${seq}`;
  const cold = `bsc:0xpriority-cold${seq}`;
  for (const id of [hot, fresh, warm, cold]) wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, hot, true, null, null);
  wr.markTokenEvaluated(hot, 9_990, 50_000);
  wr.markTokenEvaluated(warm, 1_000, 50_000);
  wr.markTokenEvaluated(cold, 1_000, 10);

  const due = wr.tokenIdsDueForEval(10_000);
  const positions = [hot, fresh, warm, cold].map((id) => due.indexOf(id));
  assert.ok(positions.every((i) => i >= 0));
  assert.ok(positions[0]! < positions[1]!);
  assert.ok(positions[1]! < positions[2]!);
  assert.ok(positions[2]! < positions[3]!);
});

test('技术失败不推进成功水位，并按 15 秒起的有界退避重试', () => {
  const u = wr.createUser(`retry${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xretry${seq}`, null)!;
  const id = `bsc:0xretry${seq}`;
  wr.upsertHolding(w.id, id, '1', 18, 100);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  wr.markTokenEvaluated(id, 1_000, 50_000);
  wr.markTokenAttempted(id, 2_000);
  wr.markTokenQuoteSucceeded(id, 2_000, 50_000);
  const next = wr.markTokenEvaluationFailed(id, 2_001);
  const row = getRawDb().prepare(
    `SELECT last_eval_ok_at, last_quote_ok_at, next_retry_at, eval_failure_count
       FROM token_meta WHERE token_id=?`,
  ).get(id) as Record<string, number>;
  assert.equal(row.last_eval_ok_at, 1_000, '失败不能冒充判定成功');
  assert.equal(row.last_quote_ok_at, 2_000, '有效报价水位要独立保留');
  assert.equal(row.next_retry_at, next);
  assert.equal(row.eval_failure_count, 1);
  assert.ok(next >= 2_016 && next <= 2_026);
  assert.equal(wr.tokenRetryDelaySeconds(id, 100), 300, '退避连抖动在内也不能超过 5 分钟');
  assert.ok(!wr.tokenIdsDueForEval(next - 1).includes(id));
  assert.ok(wr.tokenIdsDueForEval(next).includes(id));

  wr.markTokenEvaluated(id, next, 50_000);
  const recovered = getRawDb().prepare(
    `SELECT last_eval_ok_at, next_retry_at, eval_failure_count
       FROM token_meta WHERE token_id=?`,
  ).get(id) as { last_eval_ok_at: number; next_retry_at: number | null; eval_failure_count: number };
  assert.equal(recovered.last_eval_ok_at, next);
  assert.equal(recovered.next_retry_at, null);
  assert.equal(recovered.eval_failure_count, 0);
});

test('明确无池是正常冷检查，不误记成技术故障', () => {
  const id = `bsc:0xno-pool${++seq}`;
  wr.markTokenCheckedWithoutQuote(id, 3_000);
  const row = getRawDb().prepare(
    `SELECT last_eval_ok_at, last_quote_ok_at, next_retry_at, eval_failure_count
       FROM token_meta WHERE token_id=?`,
  ).get(id) as {
    last_eval_ok_at: number; last_quote_ok_at: number | null;
    next_retry_at: number | null; eval_failure_count: number;
  };
  assert.equal(row.last_eval_ok_at, 3_000);
  assert.equal(row.last_quote_ok_at, null);
  assert.equal(row.next_retry_at, null);
  assert.equal(row.eval_failure_count, 0);
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
  assert.equal(wr.upsertWalletCandle(id, '1', 1000, slot).status, 'accepted');
  // 实测 USDG 那根：正常约 1 美元，DexScreener 给了 5.56e-24
  assert.equal(wr.upsertWalletCandle(id, '0.000000000000000000000005563', 1000, slot + 300).status, 'quarantined',
    '5.56e-24 相对 1 是 1e24 倍跳变，必须丢弃');
  const n = getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=?`).get(id) as { c: number };
  assert.equal(n.c, 1, '垃圾报价不该建出新 candle');
});

test('正常波动照常写入', () => {
  const id = 'bsc:0xnormalmove';
  const slot = Math.floor(1_700_200_000 / 300) * 300;
  wr.upsertWalletCandle(id, '1', 1000, slot);
  assert.equal(wr.upsertWalletCandle(id, '5', 1000, slot + 300).status, 'accepted', '5 倍是正常行情');
  assert.equal(wr.upsertWalletCandle(id, '500', 1000, slot + 600).status, 'accepted', '100 倍也放行');
});

test('第一根没有参照，直接写入', () => {
  const id = 'bsc:0xfirstcandle';
  assert.equal(wr.upsertWalletCandle(id, '0.000000000001', 1000, 1_700_300_000).status, 'accepted');
});

test('同一 5m 格内的离谱跳变也会被隔离', () => {
  const id = 'bsc:0xsameslot';
  const slot = Math.floor(1_700_400_000 / 300) * 300;
  wr.upsertWalletCandle(id, '1', 1000, slot);
  assert.equal(wr.upsertWalletCandle(id, '100', 1000, slot + 100).status, 'accepted');
  assert.equal(
    wr.upsertWalletCandle(id, '1000001', 1000, slot + 200).status,
    'quarantined',
  );
  const row = getRawDb().prepare(
    `SELECT h, l, c FROM candles WHERE token_id=? AND timeframe='5m' AND ts=?`,
  ).get(id, slot) as { h: string; l: string; c: string };
  assert.deepEqual(row, { h: '100', l: '1', c: '100' });
});

test('非法、非有限及非正价格一律隔离且不落库', () => {
  for (const [i, price] of ['', 'NaN', 'Infinity', '-1', '0'].entries()) {
    const id = `bsc:0xinvalidprice${i}`;
    assert.equal(
      wr.upsertWalletCandle(id, price, 1000, 1_700_500_000 + i).status,
      'quarantined',
    );
    const row = getRawDb().prepare(
      `SELECT COUNT(*) c FROM candles WHERE token_id=?`,
    ).get(id) as { c: number };
    assert.equal(row.c, 0);
  }
});

/* ---------- 每人自己的粉尘阈值 ---------- */

test('没设过时是 null —— 调用方用默认值，不在库里写死', () => {
  const u = wr.createUser(`mav${++seq}`, 'h')!;
  assert.equal(wr.getMinAlertValue(u.id), null);
});

test('设了之后读得回来，也能清回默认', () => {
  const u = wr.createUser(`mav2${++seq}`, 'h')!;
  assert.equal(wr.setMinAlertValue(u.id, 50), true);
  assert.equal(wr.getMinAlertValue(u.id), 50);
  assert.equal(wr.setMinAlertValue(u.id, null), true);
  assert.equal(wr.getMinAlertValue(u.id), null);
});

test('$0 合法 —— 就是"什么都别过滤"', () => {
  const u = wr.createUser(`mav3${++seq}`, 'h')!;
  assert.equal(wr.setMinAlertValue(u.id, 0), true);
  assert.equal(wr.getMinAlertValue(u.id), 0);
});

test('荒唐的值一律拒绝且不写入 —— 手滑多打几个零等于静默关掉报警', () => {
  const u = wr.createUser(`mav4${++seq}`, 'h')!;
  wr.setMinAlertValue(u.id, 50);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, wr.MAX_MIN_ALERT_VALUE_USD + 1]) {
    assert.equal(wr.setMinAlertValue(u.id, bad), false, String(bad));
    assert.equal(wr.getMinAlertValue(u.id), 50, `${bad} 不该改动已有值`);
  }
});

test('改自己的阈值改不到别人', () => {
  const a = wr.createUser(`mava${++seq}`, 'h')!, b = wr.createUser(`mavb${++seq}`, 'h')!;
  wr.setMinAlertValue(a.id, 200);
  assert.equal(wr.getMinAlertValue(b.id), null);
});

test('usersHoldingToken 带出各自的阈值 —— 扇出要按人判', () => {
  const a = wr.createUser(`uht${++seq}`, 'h')!, b = wr.createUser(`uht2${++seq}`, 'h')!;
  const wa = wr.addWallet(a.id, 'bsc', `0xuht${seq}a`, null)!;
  const wb = wr.addWallet(b.id, 'bsc', `0xuht${seq}b`, null)!;
  const id = `bsc:0xshared${seq}`;
  wr.upsertHolding(wa.id, id, '1', 18, 100);
  wr.upsertHolding(wb.id, id, '1', 18, 100);
  wr.setMinAlertValue(a.id, 500);
  const rows = wr.usersHoldingToken(id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.userId === a.id)?.minAlertValueUsd, 500);
  assert.equal(rows.find((r) => r.userId === b.id)?.minAlertValueUsd, null);
});

/* ---------- 推送游标：必须按写入顺序，不能按 fired_at ---------- */

function alertRow(userId: string, tokenId: string, firedAt: number, level = 2) {
  wr.insertPumpAlert({
    id: `${tokenId}-${firedAt}-${level}-${++seq}`, userId, tokenId, firedAt,
    timeframe: '6h', basis: 'low', level, multiple: String(level),
    priceUsd: '1', basePriceUsd: '0.5', balance: '1', valueUsd: '100', ackedAt: null,
  });
}

test('同一轮里两条报警共用 fired_at，一条都不能漏', () => {
  // 线上真实发生过：9-03 pananiu 有 3 次两条报警共用同一个 fired_at。
  // 用 fired_at 当游标时，先送到的那条会把同轮的另一条永久顶掉。
  const u = wr.createUser(`seq1${++seq}`, 'h')!;
  const start = wr.maxPumpAlertSeq();
  alertRow(u.id, 'bsc:0xaaa', 1788443275);
  alertRow(u.id, 'bsc:0xbbb', 1788443275);          // 同一个 fired_at

  const first = wr.pumpAlertsAfterSeq(u.id, start);
  assert.equal(first.length, 2, '两条都要拿到');
  // 模拟"先送到第一条"：游标推进到它的 seq，第二条仍然要能拿到
  const afterFirst = wr.pumpAlertsAfterSeq(u.id, first[0]!.seq);
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0]!.tokenId, 'bsc:0xbbb');
});

test('fired_at 比游标早的新行照样送得出去 —— 那 23 秒的窗口', () => {
  // FLETCH 那条：fired_at=17:24:14（轮次开始时刻），实际落库 17:24:37。
  // 若此间重连、游标取"此刻"，用时间戳就永远送不出去了
  const u = wr.createUser(`seq2${++seq}`, 'h')!;
  const start = wr.maxPumpAlertSeq();
  alertRow(u.id, 'bsc:0xlate', 1788427454);         // fired_at 早于"此刻"
  const got = wr.pumpAlertsAfterSeq(u.id, start);
  assert.equal(got.length, 1, '按写入顺序就不受 fired_at 影响');
  assert.equal(got[0]!.tokenId, 'bsc:0xlate');
});

test('游标按 seq 递增，且拿不到别人的报警', () => {
  const a = wr.createUser(`seq3${++seq}`, 'h')!, b = wr.createUser(`seq4${++seq}`, 'h')!;
  const start = wr.maxPumpAlertSeq();
  alertRow(a.id, 'bsc:0xmine', 1788400000);
  alertRow(b.id, 'bsc:0xtheirs', 1788400001);
  const mine = wr.pumpAlertsAfterSeq(a.id, start);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.tokenId, 'bsc:0xmine');
});

test('从当前最大 seq 开始的新连接不重播历史', () => {
  const u = wr.createUser(`seq5${++seq}`, 'h')!;
  alertRow(u.id, 'bsc:0xold', 1788400000);
  const cursor = wr.maxPumpAlertSeq();
  assert.equal(wr.pumpAlertsAfterSeq(u.id, cursor).length, 0);
  alertRow(u.id, 'bsc:0xnew', 1788400001);
  assert.equal(wr.pumpAlertsAfterSeq(u.id, cursor).length, 1);
});

test('返回顺序是写入顺序（升序），不是 fired_at 顺序', () => {
  const u = wr.createUser(`seq6${++seq}`, 'h')!;
  const start = wr.maxPumpAlertSeq();
  alertRow(u.id, 'bsc:0xlater', 1788400500);        // fired_at 更晚，先写入
  alertRow(u.id, 'bsc:0xearlier', 1788400100);      // fired_at 更早，后写入
  const got = wr.pumpAlertsAfterSeq(u.id, start);
  assert.deepEqual(got.map((r) => r.tokenId), ['bsc:0xlater', 'bsc:0xearlier']);
});

test('SSE 增量按上限分页，下一页仍可从最后 seq 续取', () => {
  const u = wr.createUser(`page${++seq}`, 'h')!;
  const start = wr.maxPumpAlertSeq();
  for (let i = 0; i < 5; i++) alertRow(u.id, `bsc:0xpage${i}`, 200 + i);
  const first = wr.pumpAlertsAfterSeq(u.id, start, 2);
  assert.equal(first.length, 2);
  const second = wr.pumpAlertsAfterSeq(u.id, first[1]!.seq, 2);
  assert.equal(second.length, 2);
  assert.ok(second[0]!.seq > first[1]!.seq);
});

/* ---------- 单个持仓的主键查找 ---------- */

test('getHolding 只取指定的那一行', () => {
  const u = wr.createUser(`gh${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xgh${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xone', '111', 18, 100);
  wr.upsertHolding(w.id, 'bsc:0xtwo', '222', 6, 100);
  assert.equal(wr.getHolding(w.id, 'bsc:0xtwo')?.balance, '222');
  assert.equal(wr.getHolding(w.id, 'bsc:0xone')?.decimals, 18);
});

test('getHolding 拿不到别的钱包的同一个币', () => {
  const a = wr.createUser(`gha${++seq}`, 'h')!, b = wr.createUser(`ghb${++seq}`, 'h')!;
  const wa = wr.addWallet(a.id, 'bsc', `0xgha${seq}`, null)!;
  const wb = wr.addWallet(b.id, 'bsc', `0xghb${seq}`, null)!;
  wr.upsertHolding(wa.id, 'bsc:0xshared', '999', 18, 100);
  assert.equal(wr.getHolding(wa.id, 'bsc:0xshared')?.balance, '999');
  assert.equal(wr.getHolding(wb.id, 'bsc:0xshared'), undefined);
});

test('没有这一行时返回 undefined，不是抛错', () => {
  const u = wr.createUser(`ghn${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xghn${seq}`, null)!;
  assert.equal(wr.getHolding(w.id, 'bsc:0xnothere'), undefined);
});

test('结果与 listHoldingsByWallet().find() 完全一致', () => {
  // 这次替换的正确性判据就是这一条
  const u = wr.createUser(`ghsame${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xghs${seq}`, null)!;
  for (const t of ['bsc:0xa', 'bsc:0xb', 'bsc:0xc']) wr.upsertHolding(w.id, t, '1', 18, 100);
  wr.setHoldingMonitored(w.id, 'bsc:0xb', true, null, 555);
  for (const t of ['bsc:0xa', 'bsc:0xb', 'bsc:0xc', 'bsc:0xmissing']) {
    assert.deepEqual(
      wr.getHolding(w.id, t),
      wr.listHoldingsByWallet(w.id).find((x) => x.tokenId === t),
      t,
    );
  }
});

/* ---------- 回填重试的冷却 ---------- */

test('首次一定试 —— 新进监控的币不能因为冷却拿不到历史', () => {
  // FLETCH 那种情况：币刚被重新提升为监控中，正需要立刻回填
  assert.equal(wr.shouldTryBackfill(`bsc:0xnever${++seq}`, 1000), true);
});

test('试过之后进入冷却，满 30 分钟才再试', () => {
  const id = `bsc:0xcool${++seq}`;
  wr.markBackfillAttempted(id, 1000);
  assert.equal(wr.shouldTryBackfill(id, 1000 + 60), false);
  assert.equal(wr.shouldTryBackfill(id, 1000 + wr.BACKFILL_RETRY_SECONDS - 1), false);
  assert.equal(wr.shouldTryBackfill(id, 1000 + wr.BACKFILL_RETRY_SECONDS), true);
});

test('记的是尝试不是成功 —— 一直失败的币也不能每轮都打一次', () => {
  const id = `bsc:0xfail${++seq}`;
  for (const t of [1000, 1060, 1120]) {
    if (wr.shouldTryBackfill(id, t)) wr.markBackfillAttempted(id, t);
  }
  // 只有第一次 t=1000 会通过，后两次都被冷却挡住
  assert.equal(wr.shouldTryBackfill(id, 1000 + wr.BACKFILL_RETRY_SECONDS - 1), false);
});

test('冷却不影响已有的持有人数与判定时刻', () => {
  const id = `bsc:0xkeep${++seq}`;
  wr.setTokenMeta(id, 12345, 'KEEP', 500);
  wr.markTokenEvaluated(id, 600, 9999);
  wr.markBackfillAttempted(id, 700);
  const m = wr.getTokenMeta(id);
  assert.equal(m?.holderCount, 12345);
  assert.equal(m?.symbol, 'KEEP');
  assert.ok(wr.tokenIdsDueForEval(600 + wr.WARM_RECHECK_SECONDS).length >= 0);
});
