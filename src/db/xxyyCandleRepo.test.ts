process.env.DATABASE_PATH = ':memory:';

import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getRawDb } from './index.ts';
import { runMigrations } from './migrate.ts';
import {
  bootstrapXxyyCandlesFromShadow, loadXxyy5mCandles, upsertXxyyCandle,
  xxyyHistoryStart, xxyyWindowHighsBefore, XXYY_PRICE_REGIME,
} from './xxyyCandleRepo.ts';

before(() => runMigrations());
beforeEach(() => {
  const db = getRawDb();
  db.prepare('DELETE FROM wallet_xxyy_pending_quotes').run();
  db.prepare('DELETE FROM wallet_xxyy_daily_highs').run();
  db.prepare('DELETE FROM wallet_xxyy_candles').run();
  db.prepare('DELETE FROM quote_shadow').run();
  db.prepare('DELETE FROM candles').run();
});

test('XXYY candle 与共享看板 candles 完全隔离', () => {
  const db = getRawDb();
  db.prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, source)
     VALUES ('bsc:0xsame', '5m', 900, '1', '1', '1', '1', 'dexscreener')`,
  ).run();
  assert.deepEqual(upsertXxyyCandle('bsc:0xsame', '2', 200, 1000), {
    status: 'accepted', reason: null,
  });
  assert.equal((db.prepare(`SELECT c FROM candles`).get() as { c: string }).c, '1');
  const own = db.prepare(
    `SELECT c, price_regime FROM wallet_xxyy_candles`,
  ).get() as { c: string; price_regime: string };
  assert.deepEqual(own, { c: '2', price_regime: XXYY_PRICE_REGIME });
});

test('同一 5m 格用 Decimal 合并 OHLC，市值保留文本', () => {
  upsertXxyyCandle('solana:MintCase', '0.00000000000000000021', 123.45, 1000);
  upsertXxyyCandle('solana:MintCase', '0.00000000000000000019', 120, 1020);
  const row = getRawDb().prepare(
    `SELECT o, h, l, c, market_cap_usd FROM wallet_xxyy_candles`,
  ).get();
  assert.deepEqual(row, {
    o: '0.00000000000000000021', h: '0.00000000000000000021',
    l: '0.00000000000000000019', c: '0.00000000000000000019', market_cap_usd: '120',
  });
});

test('超过 1000x 的跳变只延迟一轮，相邻两次一致后接受', () => {
  upsertXxyyCandle('bsc:0xjump', '1', null, 1000);
  const first = upsertXxyyCandle('bsc:0xjump', '2000', null, 1300);
  assert.equal(first.status, 'pending-confirmation');
  assert.equal(loadXxyy5mCandles('bsc:0xjump', 0).length, 1);
  const second = upsertXxyyCandle('bsc:0xjump', '2050', null, 1315);
  assert.equal(second.status, 'accepted');
  assert.equal(loadXxyy5mCandles('bsc:0xjump', 0).length, 2);
});

test('只从 quote_shadow 的 XXYY 列建立同源历史', () => {
  const db = getRawDb();
  db.prepare(
    `INSERT INTO quote_shadow
       (token_id, bucket_ts, observed_at, ds_price_usd, xxyy_price_usd, decision, round_healthy)
     VALUES ('bsc:0xseed', 900, 1000, '99', '2', 'diverged', 0)`,
  ).run();
  assert.deepEqual(bootstrapXxyyCandlesFromShadow(), { attempted: 1, accepted: 1 });
  assert.equal(loadXxyy5mCandles('bsc:0xseed', 0)[0]?.o, '2');
});

test('历史起点与滚动高点只读 XXYY 专表', () => {
  upsertXxyyCandle('bsc:0xhigh', '2', null, 86400 + 60);
  upsertXxyyCandle('bsc:0xhigh', '3', null, 2 * 86400 + 60);
  assert.equal(xxyyHistoryStart('bsc:0xhigh'), 86400);
  const highs = xxyyWindowHighsBefore('bsc:0xhigh', [
    { key: '3d', seconds: 3 * 86400 }, { key: 'all', seconds: null },
  ], 3 * 86400);
  assert.equal(highs.get('3d')?.toString(), '3');
  assert.equal(highs.get('all')?.toString(), '3');
});
