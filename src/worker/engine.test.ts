/**
 * 引擎集成测试 —— 对应 Phase 1 验收标准：
 * 「能正确报警一次且不重复刷屏」。
 *
 * 用临时 DB + 合成行情驱动，不打网络。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ddm-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CONFIG_PATH = './config.default.json';

// DB 路径必须在模块首次取连接前设好，故用动态 import
const { runMigrations } = await import('../db/migrate.ts');
const repo = await import('../db/repo.ts');
const { processQuote } = await import('./engine.ts');
const { Decimal } = await import('../lib/decimal.ts');
const { align5m } = await import('../lib/time.ts');
import type { TokenQuote, PoolRef } from '../sources/types.ts';

const CHAIN = 'solana' as const;
const ADDR = 'TestTokenAddress1111111111111111111111111111';
const TOKEN_ID = `${CHAIN}:${ADDR}`;

function pool(addr: string, price: string, liq: number): PoolRef {
  return {
    chain: CHAIN, address: addr, dex: 'raydium', quoteSymbol: 'SOL',
    quoteAddress: 'So11111111111111111111111111111111111111112',
    liquidityUsd: liq, createdAt: 1, priceUsd: price, isOutlier: false,
  };
}

// 池子主键是 chain:address —— 每个代币必须用不同的池地址，
// 否则它们在 pools 表里会互相覆盖
function poolAddrFor(tokenAddr: string): string {
  return 'Pool' + tokenAddr.slice(0, 12);
}

function quote(price: string, at: number, liquidity = 100_000): TokenQuote {
  const p = new Decimal(price);
  return {
    chain: CHAIN, address: ADDR, symbol: 'TEST', name: 'Test',
    priceUsd: p, priceNative: null,
    liquidityPrimary: liquidity, liquidityTotal: liquidity,
    fdvUsd: null,
    volume: { m5: 5000, h1: 60000, h24: 1_000_000 },
    txns: { m5: { buys: 10, sells: 8 }, h1: { buys: 120, sells: 90 }, h24: { buys: 2000, sells: 1800 } },
    primaryPool: pool(poolAddrFor(ADDR), price, liquidity),
    allPools: [pool(poolAddrFor(ADDR), price, liquidity)],
    medianPriceUsd: p, crossValidated: true,
    fetchedAt: at, source: 'test',
  };
}

/** 把 quote 改挂到另一个代币上，池地址同步替换 */
function withAddr(q: TokenQuote, addr: string): TokenQuote {
  const pa = poolAddrFor(addr);
  const pr = { ...q.primaryPool, address: pa };
  return { ...q, address: addr, primaryPool: pr, allPools: [pr] };
}

before(() => {
  runMigrations();
  repo.upsertRule({
    id: 'default', tokenId: null, type: 'drawdown',
    athMode: 'since_added', quoteMode: 'usd', levels: JSON.stringify([80]),
    confirmTicks: 2, hysteresis: 15, rearmMinutes: 60,
    minLiquidityUsd: 5000, athSustainCandles: 3, cooldownMinutes: 30,
    bouncePct: 25, channels: JSON.stringify(['telegram']), enabled: 1,
  });
  repo.addToken({ chain: CHAIN, address: ADDR, note: '测试用' });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('完整闭环：建立 ATH -> 暴跌 -> 触发一次 -> 不重复刷屏', () => {
  const token = repo.getToken(TOKEN_ID)!;
  const t0 = align5m(1_800_000_000);
  const STEP = 300;   // 每根 candle 一个 5m 格

  // 1) 先喂 5 根高价 candle 建立 ATH（k=3 需要至少 3 根合格 candle）
  let fired = 0;
  for (let i = 0; i < 5; i++) {
    fired += processQuote(token, quote('1.00', t0 + i * STEP)).length;
  }
  assert.equal(fired, 0, '横盘期不应报警');

  const ath = repo.getAth(TOKEN_ID, 'since_added', 'usd');
  assert.equal(ath?.athRobust, '1', `ath_robust 应为 1，实际 ${ath?.athRobust}`);
  assert.equal(ath?.athConfidence, 'verified', '实时段应为 verified');

  // 2) 暴跌到 0.15 → 回撤 85%，需连续 2 次确认
  const r1 = processQuote(token, quote('0.15', t0 + 5 * STEP));
  assert.equal(r1.length, 0, '第一次达阈值只确认，不触发');

  const r2 = processQuote(token, quote('0.15', t0 + 6 * STEP));
  assert.equal(r2.length, 1, '第二次确认应触发');
  assert.equal(r2[0]!.level, 80);
  assert.ok(r2[0]!.drawdownUsd.gte(85), `回撤应 >= 85%，实际 ${r2[0]!.drawdownUsd}`);

  // 3) 持续低位 20 轮，不得重复报警
  let extra = 0;
  for (let i = 7; i < 27; i++) {
    extra += processQuote(token, quote('0.15', t0 + i * STEP)).length;
  }
  assert.equal(extra, 0, '不得重复刷屏');
  assert.equal(repo.listAlerts().length, 1, 'alerts 表应只有 1 条');

  const st = repo.getAlertState(TOKEN_ID, 'default', 80);
  assert.equal(st.state, 'FIRED');
});

test('流动性低于门槛时不触发', () => {
  const addr2 = 'LowLiqToken2222222222222222222222222222222222';
  repo.addToken({ chain: CHAIN, address: addr2, note: '低流动性' });
  const token = repo.getToken(`${CHAIN}:${addr2}`)!;
  const t0 = align5m(1_900_000_000);

  for (let i = 0; i < 5; i++) processQuote(token, withAddr(quote('1.00', t0 + i * 300), addr2));
  // 流动性 1000 < 门槛 5000
  for (let i = 5; i < 10; i++) {
    const q = withAddr(quote('0.10', t0 + i * 300, 1000), addr2);
    assert.equal(processQuote(token, q).length, 0, '流动性不足不得触发');
  }
});

test('合格 candle 不足 k 根时不报警', () => {
  const addr3 = 'FreshToken33333333333333333333333333333333333';
  repo.addToken({ chain: CHAIN, address: addr3, note: '新币' });
  const token = repo.getToken(`${CHAIN}:${addr3}`)!;
  const t0 = align5m(2_000_000_000);

  // 只有 2 根 candle，k=3
  processQuote(token, withAddr(quote('1.00', t0), addr3));
  const r = processQuote(token, withAddr(quote('0.01', t0 + 300), addr3));
  assert.equal(r.length, 0);
  const ath = repo.getAth(`${CHAIN}:${addr3}`, 'since_added', 'usd');
  assert.equal(ath?.athRobust, null, 'ath_robust 应为 null 而不是瞎给一个值');
});

test('多档位：各档独立触发一次，受 cooldown 间隔约束', () => {
  const addr = 'MultiLevelToken444444444444444444444444444444';
  repo.upsertRule({
    id: 'multi', tokenId: `${CHAIN}:${addr}`, type: 'drawdown',
    athMode: 'since_added', quoteMode: 'usd', levels: JSON.stringify([80, 85, 90, 95]),
    confirmTicks: 1, hysteresis: 15, rearmMinutes: 60,
    minLiquidityUsd: 5000, athSustainCandles: 3,
    cooldownMinutes: 0,     // 本测试关心分档，不关心冷却间隔
    bouncePct: 25, channels: JSON.stringify(['telegram']), enabled: 1,
  });
  repo.addToken({ chain: CHAIN, address: addr, note: '多档位测试' });
  const token = repo.getToken(`${CHAIN}:${addr}`)!;
  const t0 = align5m(2_100_000_000);
  const q = (price: string, i: number) => withAddr(quote(price, t0 + i * 300), addr);

  for (let i = 0; i < 5; i++) processQuote(token, q('1.00', i));

  // 跌 82% -> 只有 80 档触发
  const r1 = processQuote(token, q('0.18', 5));
  assert.deepEqual(r1.map((a) => a.level), [80]);

  // 跌 88% -> 85 档触发，80 档已 FIRED 不重复
  const r2 = processQuote(token, q('0.12', 6));
  assert.deepEqual(r2.map((a) => a.level), [85]);

  // 跌 96% -> 90 与 95 同轮触发
  const r3 = processQuote(token, q('0.04', 7));
  assert.deepEqual(r3.map((a) => a.level).sort((a, b) => a - b), [90, 95]);

  // 继续下跌不再有新报警
  let extra = 0;
  for (let i = 8; i < 20; i++) extra += processQuote(token, q('0.03', i)).length;
  assert.equal(extra, 0, '四档都已触发，不得再报');

  const levels = repo.listAlerts().filter((a) => a.tokenId === `${CHAIN}:${addr}`).map((a) => a.level).sort((x, y) => (x ?? 0) - (y ?? 0));
  assert.deepEqual(levels, [80, 85, 90, 95]);
});

test('cooldown 会把同一轮的多档触发拉开', () => {
  const addr = 'CooldownToken5555555555555555555555555555555';
  repo.upsertRule({
    id: 'cd', tokenId: `${CHAIN}:${addr}`, type: 'drawdown',
    athMode: 'since_added', quoteMode: 'usd', levels: JSON.stringify([80, 85, 90, 95]),
    confirmTicks: 1, hysteresis: 15, rearmMinutes: 60,
    minLiquidityUsd: 5000, athSustainCandles: 3,
    cooldownMinutes: 30, bouncePct: 25, channels: JSON.stringify(['telegram']), enabled: 1,
  });
  repo.addToken({ chain: CHAIN, address: addr, note: '冷却测试' });
  const token = repo.getToken(`${CHAIN}:${addr}`)!;
  const t0 = align5m(2_200_000_000);
  const q = (price: string, i: number) => withAddr(quote(price, t0 + i * 300), addr);

  for (let i = 0; i < 5; i++) processQuote(token, q('1.00', i));
  // 一步跌到 -96%：四档都够条件，但 cooldown 只放行一档
  const r = processQuote(token, q('0.04', 5));
  assert.equal(r.length, 1, `cooldown 内同一代币只应触发一档，实际 ${r.length}`);
});

test('all_time 不得低于 rolling_90d（线上出现过的反常）', () => {
  const addr = 'InvariantToken666666666666666666666666666666';
  repo.addToken({ chain: CHAIN, address: addr, note: '不变量测试' });
  const token = repo.getToken(`${CHAIN}:${addr}`)!;
  const t0 = align5m(2_300_000_000);

  // 造出小时内有尖峰、收盘回落的形态 —— 1h 序列会漏掉尖峰
  for (let h = 0; h < 20; h++) {
    for (let i = 0; i < 12; i++) {
      const v = h === 10 && i === 5 ? '2.0' : String(1 - i * 0.01);
      processQuote(token, withAddr(quote(v, t0 + h * 3600 + i * 300), addr));
    }
  }

  const r90 = repo.getAth(`${CHAIN}:${addr}`, 'rolling_90d', 'usd');
  const all = repo.getAth(`${CHAIN}:${addr}`, 'all_time', 'usd');
  assert.ok(r90?.athRobust && all?.athRobust, '两个模式都应算出 ATH');
  assert.ok(
    Number(all!.athRobust) >= Number(r90!.athRobust),
    `all_time (${all!.athRobust}) 不得低于 rolling_90d (${r90!.athRobust})`,
  );
});

test('代币比窗口年轻时，不应标记为「数据不完整」', () => {
  const addr = 'YoungToken7777777777777777777777777777777777';
  repo.addToken({ chain: CHAIN, address: addr, note: '新币' });
  const token = repo.getToken(`${CHAIN}:${addr}`)!;
  const t0 = align5m(2_400_000_000);

  // 真实情况：GT 能给到的最早数据就是建池时刻，两者基本重合
  // （线上实测牛来：建池 08:07:11，最早 5m candle 08:05:00）
  const poolCreated = t0;
  for (let i = 0; i < 6; i++) {
    const q = withAddr(quote('1.0', t0 + i * 300), addr);
    q.primaryPool = { ...q.primaryPool, createdAt: poolCreated };
    q.allPools = [q.primaryPool];
    processQuote(token, q);
  }
  // 模拟回填「已到数据源尽头」
  repo.upsertBackfillJob({
    tokenId: `${CHAIN}:${addr}`, timeframe: '5m', poolAddress: 'PoolA',
    status: 'done', targetSinceTs: t0 - 90 * 86400, oldestDoneTs: t0,
    pagesDone: 1, pagesEstimated: 26, candlesWritten: 6,
    reachedSourceLimit: 1, lastError: null, startedAt: t0, updatedAt: t0,
  });
  processQuote(token, withAddr(quote('1.0', t0 + 6 * 300), addr));

  const r90 = repo.getAth(`${CHAIN}:${addr}`, 'rolling_90d', 'usd');
  assert.equal(r90?.backfillPartial, 0,
    '池子建成时间晚于窗口起点，拿到的已经是全部存在的数据，不该标不完整');
});

test('数据源确实还有更早数据却拿不到时，仍要标记不完整', () => {
  const addr = 'TruncatedToken8888888888888888888888888888888';
  repo.addToken({ chain: CHAIN, address: addr, note: '历史被截断' });
  const token = repo.getToken(`${CHAIN}:${addr}`)!;
  const t0 = align5m(2_500_000_000);

  // 池子 30 天前就建了，但回填只拿到最近这一段 —— 中间 30 天是真的缺
  const poolCreated = t0 - 30 * 86400;
  for (let i = 0; i < 6; i++) {
    const q = withAddr(quote('1.0', t0 + i * 300), addr);
    q.primaryPool = { ...q.primaryPool, createdAt: poolCreated };
    q.allPools = [q.primaryPool];
    processQuote(token, q);
  }
  repo.upsertBackfillJob({
    tokenId: `${CHAIN}:${addr}`, timeframe: '5m', poolAddress: 'PoolA',
    status: 'done', targetSinceTs: t0 - 90 * 86400, oldestDoneTs: t0,
    pagesDone: 1, pagesEstimated: 26, candlesWritten: 6,
    reachedSourceLimit: 1, lastError: null, startedAt: t0, updatedAt: t0,
  });
  processQuote(token, withAddr(quote('1.0', t0 + 6 * 300), addr));

  const r90 = repo.getAth(`${CHAIN}:${addr}`, 'rolling_90d', 'usd');
  assert.equal(r90?.backfillPartial, 1,
    '建池到最早 candle 之间差 30 天，这是真的缺数据，必须标出来');
});
