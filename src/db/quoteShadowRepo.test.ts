process.env.DATABASE_PATH = ':memory:';

import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import { getRawDb } from './index.ts';
import { pruneQuoteShadow, recordQuoteShadow, recordQuoteShadows } from './quoteShadowRepo.ts';
import { decideQuote } from '../worker/quoteDecision.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';

const ds: BatchQuote = {
  priceUsd: '1.05', priceSource: 'dexscreener', liquidityUsd: 10,
  volume24hUsd: 20, volume1hUsd: 2, marketCapUsd: 100, symbol: 'T',
  priceNative: '1', quoteSymbol: 'USDT', quoteAddress: '0xquote',
  priceCorrected: false, pairCreatedAt: null, imageUrl: null, websiteUrl: null,
  twitterUrl: null, telegramUrl: null, pairAddress: '0xpair', dexId: 'uni',
  quoteIdentity: { chain: 'bsc', address: '0xquote', symbol: 'USDT', trust: 'unknown' },
};
const xx = { priceUsd: '1', marketCapUsd: 95, pairAddress: '0xxpair' };

before(() => runMigrations());
beforeEach(() => getRawDb().prepare('DELETE FROM quote_shadow').run());

test('每币每 5 分钟覆盖写并保留来源身份与两种结果', () => {
  recordQuoteShadow({
    tokenId: 'bsc:0xt', observedAt: 1_700_000_100, ds, xxyy: xx,
    decision: decideQuote(ds, xx, true),
  });
  recordQuoteShadow({
    tokenId: 'bsc:0xt', observedAt: 1_700_000_150,
    ds: { ...ds, priceUsd: '1.06' }, xxyy: xx,
    decision: decideQuote({ ...ds, priceUsd: '1.06' }, xx, true),
  });
  const rows = getRawDb().prepare('SELECT * FROM quote_shadow').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.observed_at, 1_700_000_150);
  assert.equal(rows[0]!.current_price_usd, '1');
  assert.equal(rows[0]!.hypothetical_price_usd, '1');
  assert.equal(rows[0]!.ds_pair_address, '0xpair');
  assert.match(String(rows[0]!.ds_quote_identity), /0xquote/);
});

test('只清理超过七天的影子观察', () => {
  const now = 2_000_000_000;
  const insert = getRawDb().prepare(
    `INSERT INTO quote_shadow
       (token_id, bucket_ts, observed_at, decision, round_healthy)
     VALUES (?, ?, ?, 'unavailable', 0)`,
  );
  insert.run('bsc:old', now - 8 * 86400, now - 8 * 86400);
  insert.run('bsc:new', now - 6 * 86400, now - 6 * 86400);
  assert.equal(pruneQuoteShadow(now), 1);
  assert.deepEqual(
    getRawDb().prepare('SELECT token_id FROM quote_shadow').all(),
    [{ token_id: 'bsc:new' }],
  );
});

test('批量写入共用事务且完整保留每个币', () => {
  const decision = decideQuote(ds, xx, true);
  recordQuoteShadows(['a', 'b', 'c'].map((suffix, i) => ({
    tokenId: `bsc:${suffix}`, observedAt: 1_700_000_100 + i,
    ds, xxyy: xx, decision,
  })));
  assert.equal(
    (getRawDb().prepare('SELECT count(*) AS n FROM quote_shadow').get() as { n: number }).n,
    3,
  );
});
