process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import { runPumpTick, type PumpDeps } from './pumpEngine.ts';
import { Decimal } from '../lib/decimal.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';
import type { XxyyQuote } from '../sources/xxyy.ts';

before(() => { runMigrations(); });

let seq = 0;
/** 建一个用户 + 钱包 + 一个已在监控的持仓 */
function holder(tokenId: string, balance = '1000000000000000000') {
  const u = wr.createUser(`pe${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xw${seq}`, null)!;
  wr.upsertHolding(w.id, tokenId, balance, 18, NOW);
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
  // 关掉 XXYY 候选源：普通测试不该真的去打外部接口
  fetchCandidatePrices: null,
  fetchQuotes: async (_chain, addrs) => {
    const m = new Map<string, BatchQuote>();
    for (const a of addrs) {
      const q = quotes[a];
      if (q) m.set(a, { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999,
                   volume1hUsd: 9999, marketCapUsd: null, symbol: 'T',
                   priceNative: null, quoteSymbol: null, quoteAddress: null, priceCorrected: false, pairCreatedAt: null,
                   imageUrl: null, websiteUrl: null, twitterUrl: null, telegramUrl: null, ...q });
    }
    return m;
  },
});

function guardedDeps(
  dsQuotes: Record<string, Partial<BatchQuote>>, candidates: Record<string, string>,
): PumpDeps {
  return {
    ...deps(dsQuotes),
    fetchCandidatePrices: async (_chain, addrs) => {
      const out = new Map<string, XxyyQuote>();
      for (const address of addrs) {
        const priceUsd = candidates[address];
        if (priceUsd) out.set(address, { priceUsd, marketCapUsd: null, pairAddress: null });
      }
      return out;
    },
  };
}

function clearXxyyHealth(): void {
  getRawDb().prepare(`DELETE FROM source_health WHERE source_id = 'xxyy'`).run();
}

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

test('被隔离的离谱报价不改 candle、状态，也不产生报警', async () => {
  const id = 'bsc:0xquarantine';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xquarantine': { priceUsd: '1' } }));
  const beforeStates = getRawDb().prepare(
    `SELECT timeframe, basis, level, state, last_fired_at
       FROM pump_states WHERE token_id=? ORDER BY timeframe, basis, level`,
  ).all(id);

  await runPumpTick(NOW + 60, deps({ '0xquarantine': { priceUsd: '1000001' } }));

  const candle = getRawDb().prepare(
    `SELECT h, l, c FROM candles WHERE token_id=? AND timeframe='5m' AND ts=?`,
  ).get(id, CUR) as { h: string; l: string; c: string };
  assert.deepEqual(candle, { h: '1', l: '1', c: '1' });
  assert.deepEqual(getRawDb().prepare(
    `SELECT timeframe, basis, level, state, last_fired_at
       FROM pump_states WHERE token_id=? ORDER BY timeframe, basis, level`,
  ).all(id), beforeStates);
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);
});

test('真实的 11 倍行情不会被异常报价守卫误杀', async () => {
  const id = 'bsc:0xreal11x';
  const h = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xreal11x': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xreal11x': { priceUsd: '11' } }));
  const alerts = wr.listPumpAlerts(h.userId, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.level, 10);
  assert.equal(alerts[0]?.priceUsd, '11');
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

test('第二个收件人落库失败时，状态与第一个人的报警一起回滚，重试不漏人', async () => {
  const id = 'bsc:0xatomicfanout';
  const a = holder(id);
  const b = holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xatomicfanout': { priceUsd: '1' } }));
  const beforeStates = getRawDb().prepare(
    `SELECT timeframe, basis, level, state, last_fired_at
       FROM pump_states WHERE token_id=? ORDER BY timeframe, basis, level`,
  ).all(id);

  const db = getRawDb();
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS test_fail_pump_user (user_id TEXT PRIMARY KEY)`);
  db.prepare(`DELETE FROM test_fail_pump_user`).run();
  db.prepare(`INSERT INTO test_fail_pump_user (user_id) VALUES (?)`).run(b.userId);
  db.exec(`
    CREATE TEMP TRIGGER test_fail_second_pump_insert
    BEFORE INSERT ON pump_alerts
    WHEN EXISTS (SELECT 1 FROM test_fail_pump_user WHERE user_id = NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'injected second-recipient failure');
    END
  `);

  await runPumpTick(NOW + 60, deps({ '0xatomicfanout': { priceUsd: '3' } }));
  assert.equal(wr.listPumpAlerts(a.userId, 0).length, 0, '第一个人的行也必须回滚');
  assert.equal(wr.listPumpAlerts(b.userId, 0).length, 0);
  assert.deepEqual(db.prepare(
    `SELECT timeframe, basis, level, state, last_fired_at
       FROM pump_states WHERE token_id=? ORDER BY timeframe, basis, level`,
  ).all(id), beforeStates, 'FIRED 状态不能越过失败的报警事务');

  db.exec(`DROP TRIGGER test_fail_second_pump_insert`);
  db.prepare(`DELETE FROM test_fail_pump_user`).run();
  await runPumpTick(NOW + 60, deps({ '0xatomicfanout': { priceUsd: '3' } }));
  assert.equal(wr.listPumpAlerts(a.userId, 0).length, 1);
  assert.equal(wr.listPumpAlerts(b.userId, 0).length, 1);
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
  const boardAt = NOW + 900;
  candles(id, [[Math.floor(boardAt / 300) * 300, '1', '1']]);
  // 把它也加进共享看板
  getRawDb().prepare(
    `INSERT INTO tokens
       (id, chain, address, added_at, enabled, frozen, fail_count, pinned, visibility,
        last_source, last_quote_at)
     VALUES (?, 'bsc', '0xboth', 1, 1, 0, 0, 0, 'public', 'dexscreener', ?)`,
  ).run(id, boardAt);
  getRawDb().prepare(
    `UPDATE candles SET source='dexscreener' WHERE token_id=? AND timeframe='5m' AND ts=?`,
  ).run(id, Math.floor(boardAt / 300) * 300);

  const before = (getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id=? AND source='wallet-batch'`).get(id) as { c: number }).c;
  await runPumpTick(boardAt, deps({ '0xboth': { priceUsd: '2' } }));
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

test('报价跨过 5m 边界才返回时，按实际评估时间归桶', async () => {
  const id = 'bsc:0xactualtime';
  holder(id);
  history(id, '1');
  const scheduledAt = NOW + 290;
  const evaluatedAt = NOW + 310;
  await runPumpTick(scheduledAt, {
    ...deps({ '0xactualtime': { priceUsd: '2' } }),
    clock: () => evaluatedAt,
  });
  const row = getRawDb().prepare(
    `SELECT ts FROM candles
       WHERE token_id=? AND timeframe='5m' AND source='wallet-batch'
       ORDER BY ts DESC LIMIT 1`,
  ).get(id) as { ts: number };
  assert.equal(row.ts, Math.floor(evaluatedAt / 300) * 300);
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
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);   // 默认 monitored=0
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 0, '前提：新持仓默认不监控');

  await runPumpTick(NOW, deps({ '0xpromote': { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999 } }));
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1, '达标的币必须被提升');
});

test('回归：不达标的新币被明确标注原因，而不是静默留在 0', async () => {
  const id = 'bsc:0xdust';
  const u = wr.createUser(`dust${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1', 18, NOW);

  await runPumpTick(NOW, deps({ '0xdust': { priceUsd: '1', liquidityUsd: 10, volume24hUsd: 5 } }));
  const h = wr.listHoldingsByWallet(w.id)[0]!;
  assert.equal(h.monitored, 0);
  assert.match(h.filterReason ?? '', /流动性/, '必须说明为什么没进监控');
});

test('回归：报价缺失的新币保持未监控，且写明原因', async () => {
  const u = wr.createUser(`noq${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnq${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xnoquote', '1000', 18, NOW);
  await runPumpTick(NOW, deps({}));
  const h = wr.listHoldingsByWallet(w.id)[0]!;
  assert.equal(h.monitored, 0);
  assert.match(h.filterReason ?? '', /报价缺失/);
});

test('decimals 未知的币不参与判定 —— 无法换算数量', async () => {
  const u = wr.createUser(`nod${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnd${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xnodecimals', '1000', null, NOW);
  await runPumpTick(NOW, deps({ '0xnodecimals': { priceUsd: '1' } }));
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 0);
});

test('持有人数超标的币被踢出监控，且写明原因', async () => {
  const id = 'bsc:0xairdrop';
  const u = wr.createUser(`air${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xaw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);

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
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);
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
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);
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
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);
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
  wr.upsertHolding(w.id, id, '1000', 18, NOW);

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
  wr.upsertHolding(w.id, id, '1000000000000000000', 18, NOW);
  history(id, '1');

  const asked: string[] = [];
  await runPumpTick(NOW, {
    ...deps({ '0xworthchecking': { priceUsd: '1', liquidityUsd: 50000, volume24hUsd: 99999 } }),
    fetchTokenInfo: async (_c, a) => { asked.push(a); return { symbol: 'OK', holderCount: 500 }; },
  });
  assert.ok(asked.includes('0xworthchecking'), '够格的币必须查');
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1);
});

test('仓位不足 $1 的不推送，但币仍在监控', async () => {
  // 只值几毛钱的币涨十倍也还是几块钱，为它响一次的代价大于收益
  const id = 'bsc:0xtinybag';
  const u = wr.createUser(`tiny${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xtw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '100000000000000', 18, NOW);   // 0.0001 个
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xtinybag': { priceUsd: '1' } }));       // 价值 $0.0001
  await runPumpTick(NOW + 60, deps({ '0xtinybag': { priceUsd: '5' } }));  // 涨 5 倍，仍只值 $0.0005
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 0, '仓位太小不该推送');
  assert.equal(wr.listHoldingsByWallet(w.id)[0]?.monitored, 1, '但币仍应在监控里');
});

test('仓位够 $1 的照常推送', async () => {
  const id = 'bsc:0xbigenough';
  const u = wr.createUser(`big${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xbw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '10000000000000000000', 18, NOW);   // 10 个
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xbigenough': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xbigenough': { priceUsd: '3' } }));   // 价值 $30
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1);
});

test('同一个币，仓位大的收到、仓位小的不收到', async () => {
  // 门槛按人判而不是按币判 —— 同一次上涨，对不同的人意义不同
  const id = 'bsc:0xmixedbags';
  const rich = wr.createUser(`rich${++seq}`, 'h')!;
  const poor = wr.createUser(`poor${++seq}`, 'h')!;
  const wr1 = wr.addWallet(rich.id, 'bsc', `0xrw${seq}`, null)!;
  const wr2 = wr.addWallet(poor.id, 'bsc', `0xpw${seq}`, null)!;
  wr.upsertHolding(wr1.id, id, '50000000000000000000', 18, NOW);  // 50 个
  wr.upsertHolding(wr2.id, id, '1000000000000', 18, NOW);         // 0.000001 个
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xmixedbags': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xmixedbags': { priceUsd: '4' } }));
  assert.equal(wr.listPumpAlerts(rich.id, 0).length, 1, '仓位 $200，该收到');
  assert.equal(wr.listPumpAlerts(poor.id, 0).length, 0, '仓位 $0.000004，不该收到');
});

test('没设过阈值的人用默认的 1 美元', async () => {
  const { MIN_ALERT_VALUE_USD } = await import('./pumpEngine.ts');
  assert.equal(MIN_ALERT_VALUE_USD, 1);
});

test('每人的阈值各判各的 —— 同一条上涨，有人收到有人不收到', async () => {
  const id = 'bsc:0xperuser';
  const picky = wr.createUser(`picky${++seq}`, 'h')!;
  const loose = wr.createUser(`loose${++seq}`, 'h')!;
  const w1 = wr.addWallet(picky.id, 'bsc', `0xpk${seq}`, null)!;
  const w2 = wr.addWallet(loose.id, 'bsc', `0xls${seq}`, null)!;
  // 两人余额一样：$50 的仓位
  for (const w of [w1, w2]) {
    wr.upsertHolding(w.id, id, '50000000000000000000', 18, NOW);
    wr.setHoldingMonitored(w.id, id, true, null, null);
  }
  wr.setMinAlertValue(picky.id, 500);      // 只想被 $500 以上的吵醒
  history(id, '0.25');

  await runPumpTick(NOW, deps({ '0xperuser': { priceUsd: '0.25' } }));
  await runPumpTick(NOW + 60, deps({ '0xperuser': { priceUsd: '1' } }));

  assert.equal(wr.listPumpAlerts(loose.id, 0).length, 1, '没设阈值，$50 该收到');
  assert.equal(wr.listPumpAlerts(picky.id, 0).length, 0, '阈值 $500，$50 不该收到');
});

test('阈值设成 0 就什么都不过滤 —— 连尘埃也报', async () => {
  const id = 'bsc:0xzerofloor';
  const u = wr.createUser(`zero${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xzf${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000', 18, NOW);   // 0.000001 个
  wr.setHoldingMonitored(w.id, id, true, null, null);
  wr.setMinAlertValue(u.id, 0);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xzerofloor': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xzerofloor': { priceUsd: '4' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1, '阈值 0，$0.000004 也该收到');
});

/* ---------- FLETCH 那个坑的回归测试 ---------- */

/** 建一个**被挡在监控外**的持仓：流动性够，只是没成交量 */
function coldHolder(tokenId: string, balance = '1000000000000000000') {
  const u = wr.createUser(`cold${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xcw${seq}`, null)!;
  wr.upsertHolding(w.id, tokenId, balance, 18, NOW);
  wr.setHoldingMonitored(w.id, tokenId, false, '24h 成交 $3,000 < $10,000', null);
  return { userId: u.id, walletId: w.id };
}

test('休眠的币靠 1h 成交量重新进监控 —— 不必等 24h 量爬回来', async () => {
  const id = 'bsc:0xfletch';
  const { walletId } = coldHolder(id);
  history(id, '1');
  wr.markTokenEvaluated(id, NOW - 1000, 32457);

  // 24h 量还是不够（$3,000 < $10,000），但一小时已经成交 $3,705
  await runPumpTick(NOW, deps({
    '0xfletch': { priceUsd: '1', liquidityUsd: 32457, volume24hUsd: 3000, volume1hUsd: 3705 },
  }));

  const row = wr.listHoldingsByWallet(walletId).find((x) => x.tokenId === id);
  assert.equal(row?.monitored, 1, '1h 量够就该重新进监控');
});

test('休眠的币 1h 量也不够时保持在监控外', async () => {
  const id = 'bsc:0xstilldead';
  const { walletId } = coldHolder(id);
  history(id, '1');
  wr.markTokenEvaluated(id, NOW - 1000, 32457);

  await runPumpTick(NOW, deps({
    '0xstilldead': { priceUsd: '1', liquidityUsd: 32457, volume24hUsd: 3000, volume1hUsd: 50 },
  }));

  const row = wr.listHoldingsByWallet(walletId).find((x) => x.tokenId === id);
  assert.equal(row?.monitored, 0);
});

test('判定后把流动性记进 token_meta —— 快车道靠它分流', async () => {
  const id = 'bsc:0xliqrec';
  holder(id);
  history(id, '1');
  await runPumpTick(NOW, deps({ '0xliqrec': { priceUsd: '1', liquidityUsd: 77777 } }));
  const meta = getRawDb()
    .prepare('SELECT last_liquidity_usd AS liq FROM token_meta WHERE token_id = ?')
    .get(id) as { liq: number | null } | undefined;
  assert.equal(meta?.liq, 77777);
});

/* ---------- PICKLES 那次的回归测试 ---------- */

test('2 倍档报过之后，30 分钟内穿 5 倍、10 倍照样要报', async () => {
  /**
   * 2026-09-04 线上真实序列（robinhood:0x82effee…，基准 0.00003056）：
   *   04:34 报 2 倍档（2.24x）
   *   04:48 穿 5 倍 —— 落在压制窗口里，没发
   *   05:03 穿 10 倍 —— 同样没发
   * 而状态机把这两档都置成了 FIRED，于是永久消耗掉，再也不会报。
   */
  const id = 'bsc:0xpickles';
  const u = wr.createUser(`pk${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xpk${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');                                   // 基准 1

  await runPumpTick(NOW, deps({ '0xpickles': { priceUsd: '1' } }));           // seed
  await runPumpTick(NOW + 60, deps({ '0xpickles': { priceUsd: '2.24' } }));   // 2 倍档
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1, '先报 2 倍档');

  // 14 分钟后穿 5 倍 —— 还在 30 分钟压制窗口内
  await runPumpTick(NOW + 900, deps({ '0xpickles': { priceUsd: '6' } }));
  const afterFive = wr.listPumpAlerts(u.id, 0);
  assert.equal(afterFive.length, 2, '5 倍档比 2 倍高，压制窗口不该挡它');
  assert.equal(afterFive[0]!.level, 5);

  // 再过几分钟穿 10 倍 —— 仍在窗口内
  await runPumpTick(NOW + 1740, deps({ '0xpickles': { priceUsd: '13.5' } }));
  const afterTen = wr.listPumpAlerts(u.id, 0);
  assert.equal(afterTen.length, 3, '10 倍档同理');
  assert.equal(afterTen[0]!.level, 10);
});

test('同一档位在窗口内反复穿越仍然只报一次', async () => {
  // 去重窗口的本意不能丢：一个在 2.0 附近震荡的币不该每次穿越都响
  const id = 'bsc:0xwobble';
  const u = wr.createUser(`wb${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwb${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xwobble': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xwobble': { priceUsd: '2.1' } }));    // 报 2 倍
  await runPumpTick(NOW + 120, deps({ '0xwobble': { priceUsd: '1.5' } }));   // 跌回，重新武装
  await runPumpTick(NOW + 180, deps({ '0xwobble': { priceUsd: '2.2' } }));   // 又穿 2 倍
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1, '同档反复穿越只报一次');
});

test('窗口内报过 10 倍后，跌回来再穿 5 倍不重复吵', async () => {
  const id = 'bsc:0xdown';
  const u = wr.createUser(`dn${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xdn${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xdown': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xdown': { priceUsd: '11' } }));       // 直接报 10 倍
  assert.equal(wr.listPumpAlerts(u.id, 0)[0]!.level, 10);
  await runPumpTick(NOW + 120, deps({ '0xdown': { priceUsd: '3' } }));       // 跌回，5 倍档重新武装
  await runPumpTick(NOW + 180, deps({ '0xdown': { priceUsd: '6' } }));       // 又穿 5 倍
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1, '已经报过 10 倍，5 倍不算新消息');
});

test('哈夫币那波：2 倍之后一路涨到 4.4 倍，中间要补报', async () => {
  /**
   * 2026-09-05 线上真实序列（robinhood:0x64aafe…，基准 0.0005851）：
   *   03:21:55 报 2 倍档（2.10x，价 0.001228）
   *   03:25    涨到 3.86x（0.002259）—— 比报警价又涨 84%，没有任何提示
   *   03:30    涨到 4.24x（0.002479）—— 又涨 102%，仍然没有
   *   03:36:55 穿 5 倍才报第二条（5.15x）
   * 中间十五分钟价格翻了一倍多，而 2 倍和 5 倍之间当时没有任何档位。
   */
  const id = 'bsc:0xhaf';
  const u = wr.createUser(`haf${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xhaf${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '0.0005851');

  await runPumpTick(NOW, deps({ '0xhaf': { priceUsd: '0.0005851' } }));       // seed
  await runPumpTick(NOW + 60, deps({ '0xhaf': { priceUsd: '0.001228' } }));   // 2.10x
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 1, '先报 2 倍档');

  // 3 倍档：0.0005851 * 3 = 0.0017553
  await runPumpTick(NOW + 200, deps({ '0xhaf': { priceUsd: '0.001800' } }));
  const afterThree = wr.listPumpAlerts(u.id, 0);
  assert.equal(afterThree.length, 2, '新增的 3 倍档该报');
  assert.equal(afterThree[0]!.level, 3);

  // 4.24x —— 没到 5 倍档，但比 3 倍档那条报警价（0.0018）又涨了 38%，不该发
  await runPumpTick(NOW + 500, deps({ '0xhaf': { priceUsd: '0.002479' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 2, '只涨 38%，不到补报线');

  // 再涨到比 0.0018 高 50% 以上（0.0027），仍没到 5 倍档 —— 该补报
  await runPumpTick(NOW + 560, deps({ '0xhaf': { priceUsd: '0.002750' } }));
  const afterAdvance = wr.listPumpAlerts(u.id, 0);
  assert.equal(afterAdvance.length, 3, '未升档但又涨 50%，该补一条');
  assert.equal(afterAdvance[0]!.level, 3, '补报沿用已报过的最高档，不能吃掉 5 倍档');

  // 真正穿 5 倍：补报没有把这一档消耗掉
  await runPumpTick(NOW + 900, deps({ '0xhaf': { priceUsd: '0.003015' } }));
  const afterFive = wr.listPumpAlerts(u.id, 0);
  assert.equal(afterFive.length, 4, '5 倍档照样要报');
  assert.equal(afterFive[0]!.level, 5);
});

test('补报不会在行情回落又涨回原位时触发', async () => {
  const id = 'bsc:0xnoretrigger';
  const u = wr.createUser(`nr${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnr${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xnoretrigger': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xnoretrigger': { priceUsd: '3' } }));  // 报 3 倍档
  const n = wr.listPumpAlerts(u.id, 0).length;

  // 跌到 1.8 再涨回 2.7：比"最后一条"是涨了 50%，但没超过已报过的最高价
  await runPumpTick(NOW + 300, deps({ '0xnoretrigger': { priceUsd: '1.8' } }));
  await runPumpTick(NOW + 360, deps({ '0xnoretrigger': { priceUsd: '2.7' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, n, '只是回到原位，不是新消息');
});

/* ---------------- ATH 报警 ---------------- */

import * as athRepo from '../db/athRepo.ts';
import { replaceDailyHighs, toDay } from '../db/athDailyRepo.ts';

/**
 * 造一个"有长历史"的币：wallet_ath 记录 + ath_daily 的按天高点。
 *
 * 必须写 ath_daily —— 滚动窗口的参照线来自真实历史（ath_daily 与 candles
 * 取大），不是 wallet_ath.ath_price 那个单值。days 决定哪些窗口算被覆盖。
 */
function withAth(tokenId: string, ath: string, days = 400) {
  const DAY = 86400;
  athRepo.upsertWalletAth({
    tokenId, athPrice: ath, athTs: NOW - DAY, historyStartTs: NOW - days * DAY,
    pairCreatedAt: NOW - days * DAY, complete: true, backfilledAt: NOW,
  });
  // 高点落在很久以前，最近这些天都低，好让"突破"是真的突破
  const rows = [{ day: toDay(NOW - days * DAY), high: ath }];
  for (let i = days - 1; i >= 0; i--) rows.push({ day: toDay(NOW - i * DAY), high: '0.0001' });
  replaceDailyHighs(tokenId, rows);
}

test('按突破的最长窗口报 —— 分量不同的两件事不该说成一样', async () => {
  const id = 'bsc:0xathbreak';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');
  withAth(id, '2');            // 400 天前有个 2 的高点，最近都很低

  const athOnly = () => wr.listPumpAlerts(u.id, 0).filter((a) => a.kind?.startsWith('ath'));

  await runPumpTick(NOW, deps({ '0xathbreak': { priceUsd: '1' } }));          // seed
  await runPumpTick(NOW + 60, deps({ '0xathbreak': { priceUsd: '1.05' } }));  // 只比近期高点高 5%
  assert.equal(athOnly().length, 0, '不到 10% 不算突破');

  // 2.1：远超近期各窗口，但不到 400 天前那个 2 的 10% 之上
  await runPumpTick(NOW + 120, deps({ '0xathbreak': { priceUsd: '2.1' } }));
  const first = athOnly();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.athWindow, '360d', '突破的最长窗口是 360 天，不是全部历史');

  // 2.3：越过 2 × 1.1，这才是真的历史新高
  await runPumpTick(NOW + 180, deps({ '0xathbreak': { priceUsd: '2.3' } }));
  const second = athOnly();
  assert.equal(second.length, 2, '够到更长的窗口 = 新消息');
  assert.equal(second[0]!.athWindow, 'all');
});

test('同一档窗口内继续爬升不重复报 —— 那是同一件事说七遍', async () => {
  const id = 'bsc:0xathsame';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');
  withAth(id, '99');           // 全部历史的高点很高，够不到

  await runPumpTick(NOW, deps({ '0xathsame': { priceUsd: '1' } }));
  let t = NOW;
  for (const px of ['1.2', '1.3', '1.4', '1.5', '1.6']) {
    t += 60;
    await runPumpTick(t, deps({ '0xathsame': { priceUsd: px } }));
  }
  const ath = wr.listPumpAlerts(u.id, 0).filter((a) => a.kind?.startsWith('ath'));
  assert.equal(ath.length, 1, `五轮新高只该报一次，实际 ${ath.length}`);
  assert.equal(ath[0]!.athWindow, '360d', '近期各窗口的高点都是 1，一次突破全都够到，取最长的');
});

test('单调上涨全程只报一次 —— 不是每根 K 线一条', async () => {
  const id = 'bsc:0xathgrind';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');
  withAth(id, '2');

  await runPumpTick(NOW, deps({ '0xathgrind': { priceUsd: '1' } }));
  let t = NOW;
  for (const p of ['2.3', '2.4', '2.5', '2.6', '2.7', '2.8']) {
    t += 60;
    await runPumpTick(t, deps({ '0xathgrind': { priceUsd: p } }));
  }
  const ath = wr.listPumpAlerts(u.id, 0).filter((a) => a.kind === 'ath' || a.kind === 'ath-advance');
  assert.equal(ath.length, 1, `六轮新高只该报一次，实际 ${ath.length}`);
});

test('没有 wallet_ath 记录时不报 —— 没有可信历史就没资格说"突破新高"', async () => {
  const id = 'bsc:0xnoath';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xnoath': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xnoath': { priceUsd: '99' } }));
  const ath = wr.listPumpAlerts(u.id, 0).filter((a) => a.kind?.startsWith('ath'));
  assert.equal(ath.length, 0);
});

test('冷启动已在高位的币不补报历史新高', async () => {
  const id = 'bsc:0xathseed';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');
  withAth(id, '2');
  // 一进来就已经在 ATH 的三倍
  await runPumpTick(NOW, deps({ '0xathseed': { priceUsd: '6' } }));
  const ath = wr.listPumpAlerts(u.id, 0).filter((a) => a.kind?.startsWith('ath'));
  assert.equal(ath.length, 0, '不为"它进来之前就破过新高"补报');
});

test('ATH 与暴涨同轮触发时只发 ATH —— 破新高本来就蕴含着在涨', async () => {
  const id = 'bsc:0xathboth';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');
  withAth(id, '1.5');

  await runPumpTick(NOW, deps({ '0xathboth': { priceUsd: '1' } }));
  // 涨到 3 倍：暴涨的 2x/3x 档和 ATH 突破都成立
  await runPumpTick(NOW + 60, deps({ '0xathboth': { priceUsd: '3' } }));
  const all = wr.listPumpAlerts(u.id, 0);
  assert.equal(all.length, 1, '同一件事只响一次');
  assert.equal(all[0]!.kind, 'ath', 'ATH 是更强的说法，优先它');
});

test('ATH 报警记下前高是什么时候立的 —— 之后 ath_ts 会被覆盖，事后查不到', async () => {
  const id = 'bsc:0xathbasets';
  const u = wr.createUser(`ath${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xath${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  const oldHighTs = NOW - 23 * 86400;
  athRepo.upsertWalletAth({
    tokenId: id, athPrice: '2', athTs: oldHighTs, historyStartTs: NOW - 400 * 86400,
    pairCreatedAt: NOW - 400 * 86400, complete: true, backfilledAt: NOW,
  });
  replaceDailyHighs(id, [
    { day: toDay(oldHighTs), high: '2' },
    { day: toDay(NOW), high: '0.0001' },
  ]);

  await runPumpTick(NOW, deps({ '0xathbasets': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xathbasets': { priceUsd: '2.5' } }));

  const a = wr.listPumpAlerts(u.id, 0).find((x) => x.kind === 'ath')!;
  assert.equal(a.baseTs, oldHighTs, '记的是旧高点的时刻，不是现在');
  // 库里的 ath_ts 已经被推到现在了，正说明必须在报警时就记下来
  assert.equal(athRepo.getWalletAth(id)!.athTs, NOW + 60);
});

test('报价与 K 线差三万倍时不判定 —— Monkey 那条 34852 倍', async () => {
  /**
   * 2026-09-05 线上：Monkey 同时在看板和钱包里。K 线由看板写
   * （多池中位数并剔除了那个 XAUt 离群池）稳定在 2.0e-25，而钱包用的
   * 批量接口只回一个池 —— 恰恰是被剔除的那个 —— 价格 5.9e-21。
   */
  const id = 'bsc:0xmonkey';
  const u = wr.createUser(`mk${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xmk${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '0.0000000000000000000000002');

  await runPumpTick(NOW, deps({ '0xmonkey': { priceUsd: '0.0000000000000000000000002' } }));
  const before = wr.listPumpAlerts(u.id, 0).length;

  // 下一轮报价跳三万倍
  await runPumpTick(NOW + 60, deps({ '0xmonkey': { priceUsd: '0.000000000000000000005925' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, before, '离群报价不该产生报警');
});

test('正常波动不受影响', async () => {
  const id = 'bsc:0xnormal2';
  const u = wr.createUser(`nm${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xnm${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xnormal2': { priceUsd: '1' } }));
  // 涨 3 倍：远低于 10 倍门槛，照常报
  await runPumpTick(NOW + 60, deps({ '0xnormal2': { priceUsd: '3' } }));
  assert.ok(wr.listPumpAlerts(u.id, 0).length > 0, '3 倍是正常行情，必须报');
});

test('看板币用看板的价判定，不用批量报价 —— Monkey 那条 34852 倍', async () => {
  /**
   * 2026-09-05 线上：Monkey 同时在看板和钱包里。看板做多池中位数并把那个
   * XAUt 池当离群剔掉了（中位价 2.0e-25），而钱包用的批量接口只回一个池
   * —— 恰恰就是被剔除的那个（5.9e-21）。拿它比看板写的历史低点，
   * 算出「暴涨 34852 倍」。
   */
  const id = 'bsc:0xscalemix';
  const u = wr.createUser(`sc${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xsc${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '0.0000000000000000000000002');        // 看板量级
  getRawDb().prepare(
    `INSERT INTO tokens
       (id, chain, address, added_at, enabled, frozen, fail_count, pinned, visibility,
        last_source, last_quote_at)
     VALUES (?, 'bsc', '0xscalemix', 1, 1, 0, 0, 0, 'public', 'dexscreener', ?)`,
  ).run(id, NOW);
  getRawDb().prepare(
    `UPDATE candles SET source='dexscreener' WHERE token_id=? AND timeframe='5m' AND ts=?`,
  ).run(id, CUR);

  await runPumpTick(NOW, deps({ '0xscalemix': { priceUsd: '0.0000000000000000000000002' } }));
  const before = wr.listPumpAlerts(u.id, 0).length;

  // 批量报价跳到另一个量级 —— 该被看板价顶替掉
  await runPumpTick(NOW + 60, deps({ '0xscalemix': { priceUsd: '0.000000000000000000005925' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, before, '离群池的报价不该产生报警');
});

test('看板价格超过 TTL 后暂停本轮，不拿钱包价接旧历史', async () => {
  const id = 'bsc:0xstaleboard';
  const h = holder(id);
  history(id, '1');
  getRawDb().prepare(
    `INSERT INTO tokens
       (id, chain, address, added_at, enabled, frozen, fail_count, pinned, visibility,
        last_source, last_quote_at)
     VALUES (?, 'bsc', '0xstaleboard', 1, 1, 0, 0, 0, 'public', 'dexscreener', ?)`,
  ).run(id, NOW - 121);

  await runPumpTick(NOW, deps({ '0xstaleboard': { priceUsd: '3' } }));
  const states = getRawDb().prepare(
    `SELECT COUNT(*) c FROM pump_states WHERE token_id=?`,
  ).get(id) as { c: number };
  assert.equal(states.c, 0);
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);
});

test('看板币被冻结后暂停本轮，不沿用冻结前旧价', async () => {
  const id = 'bsc:0xfrozenboard';
  const h = holder(id);
  history(id, '1');
  getRawDb().prepare(
    `INSERT INTO tokens
       (id, chain, address, added_at, enabled, frozen, fail_count, pinned, visibility,
        last_source, last_quote_at)
     VALUES (?, 'bsc', '0xfrozenboard', 1, 1, 1, 0, 0, 'public', 'dexscreener', ?)`,
  ).run(id, NOW);

  await runPumpTick(NOW, deps({ '0xfrozenboard': { priceUsd: '3' } }));
  const states = getRawDb().prepare(
    `SELECT COUNT(*) c FROM pump_states WHERE token_id=?`,
  ).get(id) as { c: number };
  assert.equal(states.c, 0);
  assert.equal(wr.listPumpAlerts(h.userId, 0).length, 0);
});

test('只在钱包里的币，一轮内涨 11 倍照常报 —— 那正是这工具要抓的事', async () => {
  // 反面用例：不能用"幅度超过 N 倍就拦"那种守卫，会把真实暴涨也拦掉
  const id = 'bsc:0xrealpump';
  const u = wr.createUser(`rp${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xrp${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xrealpump': { priceUsd: '1' } }));
  await runPumpTick(NOW + 60, deps({ '0xrealpump': { priceUsd: '11' } }));
  const a = wr.listPumpAlerts(u.id, 0);
  assert.ok(a.length > 0, '11 倍必须报');
  assert.equal(a[0]!.level, 10);
});

/* ---------------- 沉睡的币醒了 ---------------- */

test('沉睡的币被重新纳入监控时，补报它已经涨了多少 —— KANSO 那条', async () => {
  /**
   * 2026-09-06 线上：KANSO 持仓自 8-30 就在，拉盘前 24h 成交量只有约 $154
   * 走 30 分钟一次的慢车道；02:55 被纳入监控时价格已经 3.55 倍，
   * 2 倍和 3 倍档被静默吃掉，一直等到 5 倍才响 —— 那时已经 8.64 倍，
   * 市值从 5.6K 涨到 63K。
   */
  const id = 'bsc:0xwoke';
  const u = wr.createUser(`wk${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwk${seq}`, null)!;
  // 持仓一周前就在了
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW - 7 * 86400);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  // 首次判定时价格已经 3.55 倍
  await runPumpTick(NOW, deps({ '0xwoke': { priceUsd: '3.55' } }));
  const a = wr.listPumpAlerts(u.id, 0);
  assert.equal(a.length, 1, '沉睡的币醒了要补一条');
  assert.equal(a[0]!.level, 3, '报已达到的最高档，不是最低档');
  assert.ok(Number(a[0]!.multiple) >= 3.5);
});

test('新加钱包里早就涨过的币仍然静默 —— 不炸一串历史报警', async () => {
  const id = 'bsc:0xfreshwallet';
  const u = wr.createUser(`fw${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xfw${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW);   // 刚扫到
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xfreshwallet': { priceUsd: '8' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 0, '刚加的钱包不补报历史');
});

test('醒来时连 2 倍都没到就不补报', async () => {
  const id = 'bsc:0xwokelow';
  const u = wr.createUser(`wl${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwl${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW - 7 * 86400);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xwokelow': { priceUsd: '1.5' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0).length, 0);
});

test('醒来补报之后，继续涨到更高档位照常报', async () => {
  const id = 'bsc:0xwokeclimb';
  const u = wr.createUser(`wc${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xwc${seq}`, null)!;
  wr.upsertHolding(w.id, id, '1000000000000000000000000', 18, NOW - 7 * 86400);
  wr.setHoldingMonitored(w.id, id, true, null, null);
  history(id, '1');

  await runPumpTick(NOW, deps({ '0xwokeclimb': { priceUsd: '3.55' } }));
  assert.equal(wr.listPumpAlerts(u.id, 0)[0]!.level, 3);
  await runPumpTick(NOW + 60, deps({ '0xwokeclimb': { priceUsd: '11' } }));
  const a = wr.listPumpAlerts(u.id, 0);
  assert.equal(a.length, 2);
  assert.equal(a[0]!.level, 10, '醒来那条不该把后面的档位吃掉');
});

/* ---------------- XXYY 受保护报价 ---------------- */

test('XXYY 与 DS 同轮一致时取较低价，向上报警天然得到双源确认', async () => {
  clearXxyyHealth();
  const id = 'bsc:0xxxyyok';
  const h = holder(id, '1000000000000000000000000');
  history(id, '1');

  await runPumpTick(NOW, guardedDeps(
    { '0xxxyyok': { priceUsd: '1.05' } }, { '0xxxyyok': '1' },
  ));
  await runPumpTick(NOW + 60, guardedDeps(
    { '0xxxyyok': { priceUsd: '3.1' } }, { '0xxxyyok': '3' },
  ));

  const alert = wr.listPumpAlerts(h.userId, 0)[0]!;
  assert.equal(alert.priceUsd, '3', '报警必须记录双源都达到的较低价格');
  const candle = getRawDb().prepare(
    `SELECT c, source FROM candles WHERE token_id = ? AND timeframe = '5m' ORDER BY ts DESC LIMIT 1`,
  ).get(id) as { c: string; source: string };
  assert.equal(candle.c, '3');
  assert.equal(candle.source, 'wallet-xxyy');
});

test('XXYY 与 DS 偏离超过 10% 时整轮回退 DS，不让离群价触发假报警', async () => {
  clearXxyyHealth();
  const id = 'bsc:0xxxyybad';
  const h = holder(id, '1000000000000000000000000');
  history(id, '1');

  await runPumpTick(NOW, guardedDeps(
    { '0xxxyybad': { priceUsd: '1' } }, { '0xxxyybad': '1' },
  ));
  await runPumpTick(NOW + 60, guardedDeps(
    { '0xxxyybad': { priceUsd: '3' } }, { '0xxxyybad': '300' },
  ));

  const alert = wr.listPumpAlerts(h.userId, 0)[0]!;
  assert.equal(alert.priceUsd, '3');
  assert.ok(new Decimal(alert.multiple).lt(10), '300 美元离群价不能进入倍数判断');
  const health = getRawDb().prepare(
    `SELECT consecutive_failures AS n FROM source_health WHERE source_id = 'xxyy'`,
  ).get() as { n: number };
  assert.equal(health.n, 1);
});

test('XXYY 请求完全失败也计入健康分母，行情继续使用 DS', async () => {
  clearXxyyHealth();
  const id = 'bsc:0xxxyydown';
  holder(id);
  history(id, '1');
  const d = deps({ '0xxxyydown': { priceUsd: '1' } });
  d.fetchCandidatePrices = async () => { throw new Error('timeout'); };

  await runPumpTick(NOW, d);

  const health = getRawDb().prepare(
    `SELECT consecutive_failures AS n, last_fail_message AS message
     FROM source_health WHERE source_id = 'xxyy'`,
  ).get() as { n: number; message: string };
  assert.equal(health.n, 1);
  assert.match(health.message, /bsc 请求失败/);
});

test('DS 也没有可比样本时不把旧故障误清零', async () => {
  clearXxyyHealth();
  const id = 'bsc:0xnosample';
  holder(id);
  getRawDb().prepare(
    `INSERT INTO source_health (source_id, consecutive_failures, last_fail_at)
     VALUES ('xxyy', 2, ?)`,
  ).run(NOW - 1);
  const d = deps({});
  d.fetchCandidatePrices = async () => new Map<string, XxyyQuote>();

  await runPumpTick(NOW, d);

  const health = getRawDb().prepare(
    `SELECT consecutive_failures AS n FROM source_health WHERE source_id = 'xxyy'`,
  ).get() as { n: number };
  assert.equal(health.n, 2);
});
