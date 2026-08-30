process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import { getRawDb } from '../db/index.ts';
import { Decimal } from '../lib/decimal.ts';
import { backfillWalletToken, needsBackfill, BACKFILL_SECONDS, type BackfillDeps } from './walletBackfill.ts';

before(() => { runMigrations(); });

const NOW = 1_700_000_100;
const CUR = Math.floor(NOW / 300) * 300;

const candle = (ts: number, p: string) => ({
  ts, o: new Decimal(p), h: new Decimal(p), l: new Decimal(p), c: new Decimal(p), volumeUsd: 100,
});

const deps = (rows: ReturnType<typeof candle>[]): BackfillDeps => ({
  fetchKline: async () => rows,
  supportsChain: () => true,
  isConfigured: () => true,
});

test('回填窗口是 24 小时', () => {
  assert.equal(BACKFILL_SECONDS, 86400);
});

test('没有任何 candle 的币需要回填', () => {
  assert.equal(needsBackfill('bsc:0xnone', NOW), true);
});

test('已有覆盖 24h 的历史就不再回填', () => {
  const db = getRawDb();
  const st = db.prepare(`INSERT INTO candles (token_id,timeframe,ts,o,h,l,c) VALUES (?, '5m', ?, '1','1','1','1')`);
  for (let i = 288; i >= 0; i--) st.run('bsc:0xfull', CUR - i * 300);
  assert.equal(needsBackfill('bsc:0xfull', NOW), false);
});

test('只有几根新 candle 的币仍需回填', () => {
  const db = getRawDb();
  db.prepare(`INSERT INTO candles (token_id,timeframe,ts,o,h,l,c) VALUES ('bsc:0xthin','5m',?, '1','1','1','1')`).run(CUR);
  assert.equal(needsBackfill('bsc:0xthin', NOW), true);
});

test('回填写入的 candle 可被窗口计算读到', async () => {
  const rows = Array.from({ length: 288 }, (_, i) => candle(CUR - (287 - i) * 300, '2'));
  const n = await backfillWalletToken('bsc:0xbf', NOW, deps(rows));
  assert.equal(n, 288);
  const cnt = getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id='bsc:0xbf' AND timeframe='5m'`).get() as { c: number };
  assert.equal(cnt.c, 288);
});

test('回填不覆盖已有的实时 candle', () => {
  // 实时写的带流动性与成交笔数，回填只有 OHLCV 六字段。
  // 覆盖会把 ath_confidence 从 verified 降成 inferred
  const db = getRawDb();
  db.prepare(
    `INSERT INTO candles (token_id,timeframe,ts,o,h,l,c,liquidity_total,source)
     VALUES ('bsc:0xkeep','5m',?, '9','9','9','9', 12345, 'wallet-batch')`).run(CUR);
  return backfillWalletToken('bsc:0xkeep', NOW, deps([candle(CUR, '1')])).then(() => {
    const row = db.prepare(
      `SELECT o, liquidity_total, source FROM candles WHERE token_id='bsc:0xkeep' AND ts=?`).get(CUR) as
      { o: string; liquidity_total: number; source: string };
    assert.equal(row.o, '9', '实时数据不该被回填覆盖');
    assert.equal(row.liquidity_total, 12345);
    assert.equal(row.source, 'wallet-batch');
  });
});

test('回填的 candle 标记来源为 gmgn，与实时数据可区分', async () => {
  await backfillWalletToken('bsc:0xsrc', NOW, deps([candle(CUR - 3000, '1')]));
  const row = getRawDb().prepare(
    `SELECT source FROM candles WHERE token_id='bsc:0xsrc' AND ts=?`).get(CUR - 3000) as { source: string };
  assert.equal(row.source, 'gmgn');
});

test('超出 24h 窗口的 candle 被丢弃，不无限增长', async () => {
  const rows = [candle(CUR - 200000, '1'), candle(CUR - 600, '2')];
  const n = await backfillWalletToken('bsc:0xtrim', NOW, deps(rows));
  assert.equal(n, 1, '只该写窗口内那根');
});

test('GMGN 未配置时跳过且不抛错', async () => {
  const n = await backfillWalletToken('bsc:0xnokey', NOW, {
    ...deps([candle(CUR, '1')]), isConfigured: () => false,
  });
  assert.equal(n, 0);
});

test('GMGN 不支持的链跳过且不抛错', async () => {
  const n = await backfillWalletToken('solana:xyz', NOW, {
    ...deps([candle(CUR, '1')]), supportsChain: () => false,
  });
  assert.equal(n, 0);
});

test('拉取失败不抛出，返回 0 —— 回填是尽力而为，不能拖垮判定循环', async () => {
  const n = await backfillWalletToken('bsc:0xfail', NOW, {
    ...deps([]), fetchKline: async () => { throw new Error('GMGN 429'); },
  });
  assert.equal(n, 0);
});

test('价格全程走字符串，极小价格不丢精度', async () => {
  await backfillWalletToken('bsc:0xprec', NOW, deps([candle(CUR - 900, '0.000000000001234')]));
  const row = getRawDb().prepare(
    `SELECT o FROM candles WHERE token_id='bsc:0xprec' AND ts=?`).get(CUR - 900) as { o: string };
  assert.equal(row.o, '0.000000000001234');
});
