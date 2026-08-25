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

function quote(price: string, at: number, liquidity = 100_000): TokenQuote {
  const p = new Decimal(price);
  return {
    chain: CHAIN, address: ADDR, symbol: 'TEST', name: 'Test',
    priceUsd: p, priceNative: null,
    liquidityPrimary: liquidity, liquidityTotal: liquidity,
    fdvUsd: null,
    volume: { m5: 5000, h1: 60000, h24: 1_000_000 },
    txns: { m5: { buys: 10, sells: 8 }, h1: { buys: 120, sells: 90 }, h24: { buys: 2000, sells: 1800 } },
    primaryPool: pool('PoolA', price, liquidity),
    allPools: [pool('PoolA', price, liquidity)],
    medianPriceUsd: p, crossValidated: true,
    fetchedAt: at, source: 'test',
  };
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

  for (let i = 0; i < 5; i++) processQuote(token, { ...quote('1.00', t0 + i * 300), address: addr2 });
  // 流动性 1000 < 门槛 5000
  for (let i = 5; i < 10; i++) {
    const q = { ...quote('0.10', t0 + i * 300, 1000), address: addr2 };
    assert.equal(processQuote(token, q).length, 0, '流动性不足不得触发');
  }
});

test('合格 candle 不足 k 根时不报警', () => {
  const addr3 = 'FreshToken33333333333333333333333333333333333';
  repo.addToken({ chain: CHAIN, address: addr3, note: '新币' });
  const token = repo.getToken(`${CHAIN}:${addr3}`)!;
  const t0 = align5m(2_000_000_000);

  // 只有 2 根 candle，k=3
  processQuote(token, { ...quote('1.00', t0), address: addr3 });
  const r = processQuote(token, { ...quote('0.01', t0 + 300), address: addr3 });
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
  const q = (price: string, i: number) => ({ ...quote(price, t0 + i * 300), address: addr });

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
  const q = (price: string, i: number) => ({ ...quote(price, t0 + i * 300), address: addr });

  for (let i = 0; i < 5; i++) processQuote(token, q('1.00', i));
  // 一步跌到 -96%：四档都够条件，但 cooldown 只放行一档
  const r = processQuote(token, q('0.04', 5));
  assert.equal(r.length, 1, `cooldown 内同一代币只应触发一档，实际 ${r.length}`);
});
