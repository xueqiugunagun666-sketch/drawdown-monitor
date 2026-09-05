import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { backfillAth, type AthBackfillDeps } from './athBackfill.ts';
import * as athRepo from '../db/athRepo.ts';
import { runMigrations } from '../db/migrate.ts';
import type { Candle } from '../sources/types.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';

process.env.DATABASE_PATH = ':memory:';
runMigrations();

const DAY = 86400;
const NOW = 1_788_600_000;

const candle = (ts: number, c: string): Candle =>
  ({ ts, o: null, h: null, l: null, c: new Decimal(c) } as unknown as Candle);

const quote = (pairCreatedAt: number | null): BatchQuote => ({
  priceUsd: '1', liquidityUsd: 1, volume24hUsd: 1, volume1hUsd: 1,
  marketCapUsd: null, symbol: 'T', priceNative: null, quoteSymbol: null,
  quoteAddress: null, priceCorrected: false, pairCreatedAt,
  imageUrl: null, websiteUrl: null, twitterUrl: null, telegramUrl: null,
});

function deps(over: Partial<AthBackfillDeps> = {}): AthBackfillDeps {
  return {
    isConfigured: () => true,
    supportsChain: () => true,
    fetchQuotes: async (_c, addrs) => new Map(addrs.map((a) => [a, quote(NOW - 20 * DAY)])),
    fetchKline: async () => [candle(NOW - 20 * DAY, '1'), candle(NOW - 10 * DAY, '9'), candle(NOW, '4')],
    ...over,
  };
}

test('回填后写入 ATH，且历史覆盖建池时间时标记为完整', async () => {
  const r = await backfillAth(['bsc:0xa1'], NOW, deps());
  assert.deepEqual(r, { done: 1, skipped: 0, complete: 1 });
  const row = athRepo.getWalletAth('bsc:0xa1')!;
  assert.equal(row.athPrice, '9', '取最高收盘价');
  assert.equal(row.athTs, NOW - 10 * DAY);
  assert.equal(row.complete, 1);
  assert.equal(row.pairCreatedAt, NOW - 20 * DAY);
});

test('历史起点晚于建池时间就是不完整 —— 不能冒充历史新高', async () => {
  await backfillAth(['bsc:0xa2'], NOW, deps({
    fetchQuotes: async (_c, addrs) => new Map(addrs.map((a) => [a, quote(NOW - 200 * DAY)])),
  }));
  const row = athRepo.getWalletAth('bsc:0xa2')!;
  assert.equal(row.complete, 0);
});

test('按币龄挑分辨率：20 天的币用小时线，200 天的用日线', async () => {
  const seen: string[] = [];
  const spy = (created: number) => deps({
    fetchQuotes: async (_c, addrs) => new Map(addrs.map((a) => [a, quote(created)])),
    fetchKline: async (_c, _a, tf) => { seen.push(tf); return [candle(NOW, '1')]; },
  });
  await backfillAth(['bsc:0xyoung'], NOW, spy(NOW - 20 * DAY));
  await backfillAth(['bsc:0xold'], NOW, spy(NOW - 200 * DAY));
  assert.deepEqual(seen, ['1h', '1d']);
});

test('拿不到建池时间时按最老处理，用日线且判为不完整', async () => {
  const seen: string[] = [];
  await backfillAth(['bsc:0xunknown'], NOW, deps({
    fetchQuotes: async (_c, addrs) => new Map(addrs.map((a) => [a, quote(null)])),
    fetchKline: async (_c, _a, tf) => { seen.push(tf); return [candle(NOW - 500 * DAY, '7')]; },
  }));
  assert.deepEqual(seen, ['1d']);
  assert.equal(athRepo.getWalletAth('bsc:0xunknown')!.complete, 0);
});

test('单个币取历史失败不拖垮整批', async () => {
  let n = 0;
  const r = await backfillAth(['bsc:0xok1', 'bsc:0xbad', 'bsc:0xok2'], NOW, deps({
    fetchKline: async () => {
      n++;
      if (n === 2) throw new Error('上游抽风');
      return [candle(NOW - 20 * DAY, '3')];
    },
  }));
  assert.equal(r.done, 2);
  assert.equal(r.skipped, 1);
});

test('取建池时间整批失败时仍然回填，只是一律判不完整', async () => {
  const r = await backfillAth(['bsc:0xnoquote'], NOW, deps({
    fetchQuotes: async () => { throw new Error('报价挂了'); },
  }));
  assert.equal(r.done, 1);
  assert.equal(r.complete, 0);
  assert.equal(athRepo.getWalletAth('bsc:0xnoquote')!.complete, 0);
});

test('GMGN 不支持的链整链跳过', async () => {
  const r = await backfillAth(['weird:0xz'], NOW, deps({ supportsChain: () => false }));
  assert.deepEqual(r, { done: 0, skipped: 1, complete: 0 });
});

test('未配置 GMGN 时什么都不做，而不是报错', async () => {
  const r = await backfillAth(['bsc:0xq'], NOW, deps({ isConfigured: () => false }));
  assert.deepEqual(r, { done: 0, skipped: 0, complete: 0 });
});

test('实时刷新新高不动 backfilled_at —— 否则长历史永远不重拉', () => {
  athRepo.upsertWalletAth({
    tokenId: 'bsc:0xrt', athPrice: '5', athTs: NOW - DAY, historyStartTs: NOW - 30 * DAY,
    pairCreatedAt: NOW - 30 * DAY, complete: true, backfilledAt: NOW - 3 * DAY,
  });
  athRepo.raiseWalletAth('bsc:0xrt', '8', NOW);
  const row = athRepo.getWalletAth('bsc:0xrt')!;
  assert.equal(row.athPrice, '8');
  assert.equal(row.athTs, NOW);
  assert.equal(row.backfilledAt, NOW - 3 * DAY, 'backfilled_at 不该被动');
});

test('挑出需要重拉的币：没记录的和过期的', () => {
  const stale = 'bsc:0xstale', fresh = 'bsc:0xfresh';
  athRepo.upsertWalletAth({ tokenId: stale, athPrice: '1', athTs: NOW, historyStartTs: NOW,
    pairCreatedAt: NOW, complete: true, backfilledAt: NOW - 30 * DAY });
  athRepo.upsertWalletAth({ tokenId: fresh, athPrice: '1', athTs: NOW, historyStartTs: NOW,
    pairCreatedAt: NOW, complete: true, backfilledAt: NOW });
  const need = athRepo.tokenIdsNeedingBackfill([stale, fresh, 'bsc:0xbrandnew'], NOW - 7 * DAY);
  assert.deepEqual(need.sort(), [stale, 'bsc:0xbrandnew'].sort());
});
