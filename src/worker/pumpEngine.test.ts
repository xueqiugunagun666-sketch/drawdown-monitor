process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import { runPumpTick, type PumpDeps } from './pumpEngine.ts';
import { Decimal } from '../lib/decimal.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';

before(() => { runMigrations(); });

let seq = 0;
/** 建一个用户 + 钱包 + 一个已在监控的持仓 */
function holder(tokenId: string, balance = '1000000000000000000') {
  const u = wr.createUser(`pe${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xw${seq}`, null)!;
  wr.upsertHolding(w.id, tokenId, balance, 18, 100);
  wr.setHoldingMonitored(w.id, tokenId, true, null, null);
  return { userId: u.id, walletId: w.id };
}

/** 直接塞 5m candle，绕开回填 */
function candles(tokenId: string, rows: Array<[ts: number, o: string, l: string]>) {
  const db = getRawDb();
  const st = db.prepare(
    `INSERT OR REPLACE INTO candles (token_id, timeframe, ts, o, h, l, c) VALUES (?, '5m', ?, ?, ?, ?, ?)`,
  );
  for (const [ts, o, l] of rows) st.run(tokenId, ts, o, o, l, o);
}

const NOW = 1_700_000_100;
const CUR = Math.floor(NOW / 300) * 300;

/** 造够 24h 覆盖度的历史，价格恒为 base */
function history(tokenId: string, base: string) {
  const rows: Array<[number, string, string]> = [];
  for (let i = 288; i >= 0; i--) rows.push([CUR - i * 300, base, base]);
  candles(tokenId, rows);
}

const deps = (quotes: Record<string, Partial<BatchQuote>>): PumpDeps => ({
  fetchQuotes: async (_chain, addrs) => {
    const m = new Map<string, BatchQuote>();
    for (const a of addrs) {
      const q = quotes[a];
      if (q) m.set(a, { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999, symbol: 'T', ...q });
    }
    return m;
  },
});

test('新币首次进入监控当轮不产生报警，即使已经在 6 倍', async () => {
  const id = 'bsc:0xseed';
  holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xseed': { priceUsd: '6' } }));
  assert.equal(wr.listPumpAlerts(wr.findUserByName(`pe${seq}`)!.id, 0).length, 0,
    'seed 那一轮必须静默，这是 6699db0 那个坑的反向版本');
});

test('seed 之后继续涨到更高档位才报', async () => {
  const id = 'bsc:0xclimb';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xclimb': { priceUsd: '6' } }));       // seed：2x/5x 置 FIRED
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);

  await runPumpTick(NOW + 60, deps({ '0xclimb': { priceUsd: '12' } })); // 越过 10x
  const alerts = wr.listPumpAlerts(h.userId, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.level, 10);
});

test('从平稳涨到 2 倍会报，且带上倍数与基准价', async () => {
  const id = 'bsc:0xrise';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xrise': { priceUsd: '1' } }));        // seed 在 1 倍
  await runPumpTick(NOW + 60, deps({ '0xrise': { priceUsd: '2.5' } }));
  const a = wr.listPumpAlerts(h.userId, 0)[0];
  assert.ok(a, '应产生报警');
  assert.equal(a!.level, 2);
  assert.equal(a!.priceUsd, '2.5');
  assert.ok(Number(a!.multiple) >= 2);
});

test('同一波行情只发一条，不是每个窗口各发一条', async () => {
  const id = 'bsc:0xonce';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xonce': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xonce': { priceUsd: '3' } }));
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 1,
    '四窗口两基准共八个组合达标，但只该发一条');
});

test('未被选中的窗口状态也被写回，去重窗口过后不重放', async () => {
  const id = 'bsc:0xnoreplay';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xnoreplay': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xnoreplay': { priceUsd: '3' } }));
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 1);

  // 跨过 30 分钟去重窗口，价格没变
  await runPumpTick(NOW + 2400, deps({ '0xnoreplay': { priceUsd: '3' } }));
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 1,
    '状态若没写回，去重窗口一过就会重放');
});

test('两个用户持有同一个币，各自收到一条，余额不串号', async () => {
  const id = 'bsc:0xshared';
  const a = holder(id, '1000000000000000000');     // 1 个
  const b = holder(id, '5000000000000000000');     // 5 个
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xshared': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xshared': { priceUsd: '4' } }));

  const aa = wr.listPumpAlerts(a.userId, 0);
  const bb = wr.listPumpAlerts(b.userId, 0);
  assert.equal(aa.length, 1);
  assert.equal(bb.length, 1);
  assert.equal(aa[0]?.balance, '1000000000000000000');
  assert.equal(bb[0]?.balance, '5000000000000000000');
  assert.equal(aa[0]?.valueUsd, '4', '1 个 × $4');
  assert.equal(bb[0]?.valueUsd, '20', '5 个 × $4');
});

test('报价缺失时不报警且不把币踢出监控', async () => {
  const id = 'bsc:0xgap';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xgap': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({}));            // 完全没报价
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);
  assert.equal(wr.listHoldingsByWallet(h.walletId)[0]?.monitored, 1, '不该被踢出');
});

test('流动性跌破入门槛但在滞回区内，仍然监控', async () => {
  const id = 'bsc:0xhyst';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xhyst': { priceUsd: '1', liquidityUsd: 4000 } }));
  assert.equal(wr.listHoldingsByWallet(h.walletId)[0]?.monitored, 1);
});

test('历史不足 24h 的新币不会因此误报', async () => {
  const id = 'bsc:0xyoung';
  const h = holder(id);
  candles(id, [[CUR, '1', '1']]);                   // 只有一根
  await runPumpTick(NOW, deps({ '0xyoung': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xyoung': { priceUsd: '3' } }));
  const alerts = wr.listPumpAlerts(h.userId, 0);
  // 5m 窗口有数据会报，但不该出现 24h/6h/1h 的条目
  for (const a of alerts) {
    assert.equal(a.timeframe, '5m', `历史只有 5 分钟，不该产出 ${a.timeframe} 报警`);
  }
});

test('完全没有 candle 的币不报警也不崩', async () => {
  const id = 'bsc:0xnocandle';
  const h = holder(id);
  await runPumpTick(NOW, deps({ '0xnocandle': { priceUsd: '999' } }));
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);
});

test('币同时在共享看板里时，不抢写 candle（让给轮询器）', async () => {
  const id = 'bsc:0xboth';
  const h = holder(id);
  history(id, '1');
  // 把它也加进共享看板
  getRawDb().prepare(
    `INSERT INTO tokens (id, chain, address, added_at, enabled, frozen, fail_count, pinned, visibility)
     VALUES (?, 'bsc', '0xboth', 1, 1, 0, 0, 0, 'public')`,
  ).run(id);

  const before = (getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=? AND source='wallet-batch'`).get(id) as { c: number }).c;
  await runPumpTick(NOW + 900, deps({ '0xboth': { priceUsd: '2' } }));
  const after = (getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=? AND source='wallet-batch'`).get(id) as { c: number }).c;
  assert.equal(after, before, '看板已覆盖的币，钱包引擎不该再写 candle');
});

test('只在钱包里的币，引擎会写 candle 攒历史', async () => {
  const id = 'bsc:0xwalletonly';
  holder(id);
  history(id, '1');
  await runPumpTick(NOW + 900, deps({ '0xwalletonly': { priceUsd: '2' } }));
  const n = (getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=? AND source='wallet-batch'`).get(id) as { c: number }).c;
  assert.ok(n > 0, '钱包独有的币必须自己攒历史');
});

test('回填发生在 seed 之前 —— 顺序反了整套状态都是错的', async () => {
  const id = 'bsc:0xorder';
  const h = holder(id);
  // 不预置任何历史，全靠回填。回填给出的历史是恒 1 元
  const rows = Array.from({ length: 288 }, (_, i) => ({
    ts: CUR - (287 - i) * 300,
    o: new Decimal('1'), h: new Decimal('1'), l: new Decimal('1'), c: new Decimal('1'),
    volumeUsd: 10,
  }));
  let backfilled = false;
  const d: PumpDeps = {
    ...deps({ '0xorder': { priceUsd: '6' } }),
    backfill: {
      isConfigured: () => true,
      supportsChain: () => true,
      fetchKline: async () => { backfilled = true; return rows; },
    },
  };
  await runPumpTick(NOW, d);
  assert.ok(backfilled, '应触发回填');
  // 回填后历史是 1 元、现价 6 元 -> 24h 窗口已达 6 倍，
  // 但这是 seed 那一轮，必须静默
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);

  // 下一轮涨到 12 倍，10x 档才该报，且窗口应该是能覆盖 24h 的
  await runPumpTick(NOW + 60, { ...d, ...deps({ '0xorder': { priceUsd: '12' } }) });
  const alerts = wr.listPumpAlerts(h.userId, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.level, 10);
  // 不能断言恰好是 24h：回填出的历史是恒 1 元，1h/6h/24h 的基准与倍数
  // 完全相同，而 pickWinner 在倍数相同时取最短窗口，所以 1h 胜出——
  // 这正是既定的择优规则。要证明的是"用上了长窗口"，即不是 5m
  // （若回填在 seed 之后，长窗口全是 too_young，只剩 5m 可选）
  assert.notEqual(alerts[0]?.timeframe, '5m',
    '回填若在 seed 之后，长窗口会全部 too_young，只可能选到 5m');
  assert.ok(['1h', '6h', '24h'].includes(alerts[0]!.timeframe));
});

test('已有充足历史的币不重复回填', async () => {
  const id = 'bsc:0xnorefill';
  holder(id);
  history(id, '1');
  let calls = 0;
  await runPumpTick(NOW, {
    ...deps({ '0xnorefill': { priceUsd: '1' } }),
    backfill: {
      isConfigured: () => true, supportsChain: () => true,
      fetchKline: async () => { calls++; return []; },
    },
  });
  assert.equal(calls, 0, '历史够了就不该再请求 GMGN');
});

test('回归：新扫到的币（monitored=0）能被过滤层提升为监控中', async () => {
  // 曾经的死锁：引擎只取 monitored=1 的币，而新持仓写入时 monitored=0，
  // 于是过滤层永远不执行，币永远不会被提升 —— 整个功能一条报警都不会产生。
  // 实机跑出来才发现：33 条持仓、0 个监控中、0 个 filter_reason
  const id = 'bsc:0xpromote';
  const u = wr.createUser(`promo${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xpw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);   // 默认 monitored=0
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 0, '前提：新持仓默认不监控');

  await runPumpTick(NOW, deps({ '0xpromote': { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999 } }));
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1, '达标的币必须被提升');
});

test('回归：不达标的新币被明确标注原因，而不是静默留在 0', async () => {
  const id = 'bsc:0xdust';
  const u = wr.createUser(`dust${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1', 18, 100);

  await runPumpTick(NOW, deps({ '0xdust': { priceUsd: '1', liquidityUsd: 10, volume24hUsd: 5 } }));
  const h = wr.listHoldingsByWallet(w.id)[0]!;
  assert.equal(h.monitored, 0);
  assert.match(h.filterReason ?? '', /流动性/, '必须说明为什么没进监控');
});

test('回归：报价缺失的新币保持未监控，且写明原因', async () => {
  const u = wr.createUser(`noq${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnq${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xnoquote', '1000', 18, 100);
  await runPumpTick(NOW, deps({}));
  const h = wr.listHoldingsByWallet(w.id)[0]!;
  assert.equal(h.monitored, 0);
  assert.match(h.filterReason ?? '', /报价缺失/);
});

test('decimals 未知的币不参与判定 —— 无法换算数量', async () => {
  const u = wr.createUser(`nod${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnd${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xnodecimals', '1000', null, 100);
  await runPumpTick(NOW, deps({ '0xnodecimals': { priceUsd: '1' } }));
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 0);
});

test('持有人数超标的币被踢出监控，且写明原因', async () => {
  const id = 'bsc:0xairdrop';
  const u = wr.createUser(`air${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xaw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);

  await runPumpTick(NOW, {
    ...deps({ '0xairdrop': { priceUsd: '1', liquidityUsd: 99189, volume24hUsd: 260271 } }),
    fetchTokenInfo: async () => ({ symbol: 'MOONALD', holderCount: 705786 }),
  });
  const h = wr.listHoldingsByWallet(w.id)[0]!;
  assert.equal(h.monitored, 0);
  assert.match(h.filterReason ?? '', /空投盘/);
});

test('持有人数缓存住，同一天不重复查', async () => {
  const id = 'bsc:0xcached';
  const u = wr.createUser(`cache${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xcw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);
  history(id, '1');

  const asked: string[] = [];
  const d = {
    ...deps({ '0xcached': { priceUsd: '1' } }),
    fetchTokenInfo: async (_c: string, a: string) => { asked.push(a); return { symbol: 'X', holderCount: 500 }; },
  };
  await runPumpTick(NOW, d);
  await runPumpTick(NOW + 120, d);
  await runPumpTick(NOW + 240, d);
  const n = asked.filter((a) => a === '0xcached').length;
  assert.equal(n, 1, `持有人数一天查一次就够，实际查了 ${n} 次`);
});

test('查不到持有人数也写缓存，不会每轮重试', async () => {
  const id = 'bsc:0xunknown';
  const u = wr.createUser(`unk${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xuw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);
  history(id, '1');

  const asked: string[] = [];
  const d = {
    ...deps({ '0xunknown': { priceUsd: '1' } }),
    fetchTokenInfo: async (_c: string, a: string) => { asked.push(a); return null; },
  };
  await runPumpTick(NOW, d);
  await runPumpTick(NOW + 120, d);
  assert.equal(asked.filter((a) => a === '0xunknown').length, 1);
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1, '查不到不该影响其它判定');
});

test('取持有人数失败不影响本轮判定', async () => {
  const id = 'bsc:0xinfofail';
  const u = wr.createUser(`fail${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xfw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);
  history(id, '1');

  await runPumpTick(NOW, {
    ...deps({ '0xinfofail': { priceUsd: '1' } }),
    fetchTokenInfo: async () => { throw new Error('429 限流'); },
  });
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1);
});

test('被流动性挡掉的币不查持有人数 —— 省掉绝大部分 GMGN 请求', async () => {
  // 线上 1206 个去重代币里只有一百多个能过流动性关。
  // 对全部币无差别查询会把判定轮次从 120 秒拖到 2 分 40 秒
  const id = 'bsc:0xdustnoinfo';
  const u = wr.createUser(`dni${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdn${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000', 18, 100);

  // 只统计问到这个币的次数 —— runPumpTick 会遍历本文件之前测试留下的全部币
  const asked: string[] = [];
  await runPumpTick(NOW, {
    ...deps({ '0xdustnoinfo': { priceUsd: '1', liquidityUsd: 10, volume24hUsd: 5 } }),
    fetchTokenInfo: async (_c, a) => { asked.push(a); return { symbol: 'X', holderCount: 1 }; },
  });
  assert.ok(!asked.includes('0xdustnoinfo'), '流动性都不够的币，不该为它花一次请求');
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 0);
});

test('通过流动性的币才查持有人数', async () => {
  const id = 'bsc:0xworthchecking';
  const u = wr.createUser(`wc${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwc${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, 100);
  history(id, '1');

  const asked: string[] = [];
  await runPumpTick(NOW, {
    ...deps({ '0xworthchecking': { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999 } }),
    fetchTokenInfo: async (_c, a) => { asked.push(a); return { symbol: 'OK', holderCount: 500 }; },
  });
  assert.ok(asked.includes('0xworthchecking'), '够格的币必须查');
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1);
});
