process.env.DATABASE_PATH = ':memory:';

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import type { XxyyPricesDetailedResult, XxyyQuote } from '../sources/xxyy.ts';
import { runXxyyAlertTick, type XxyyAlertDeps } from './xxyyAlertEngine.ts';
import { XXYY_PRICE_REGIME, upsertXxyyCandle } from '../db/xxyyCandleRepo.ts';

before(() => runMigrations());

const NOW = 1_800_000_000; // 正好落在 5m 边界
let seq = 0;

function holder(tokenId: string) {
  const user = wr.createUser(`xxyy-alert-${++seq}`, 'h')!;
  const [chain] = tokenId.split(':');
  const wallet = wr.addWallet(user.id, chain!, `wallet-${seq}`, null)!;
  wr.upsertHolding(wallet.id, tokenId, '1000000000000000000000000', 18, NOW);
  wr.setHoldingMonitored(wallet.id, tokenId, true, null, null);
  return { user, wallet };
}

function deps(prices: Record<string, string>, fetchedAt: number): XxyyAlertDeps {
  return {
    fetchPricesDetailed: async (chain, addresses): Promise<XxyyPricesDetailedResult> => {
      const quotes = new Map<string, XxyyQuote>();
      const missing: string[] = [];
      for (const address of addresses) {
        const priceUsd = prices[address];
        if (!priceUsd) { missing.push(address); continue; }
        quotes.set(address, {
          priceUsd, marketCapUsd: 250_000, pairAddress: null,
          chain, mint: address, fetchedAt,
        });
      }
      return {
        quotes,
        failures: missing.length > 0
          ? [{ addresses: missing, kind: 'partial_response', reason: '测试未提供报价' }]
          : [],
      };
    },
  };
}

test('XXYY 15 秒快轮次独立触发 2x，报警记录来源与采样时间', async () => {
  const tokenId = 'bsc:0xfast';
  const { user } = holder(tokenId);

  await runXxyyAlertTick(NOW, deps({ '0xfast': '1' }, NOW));
  await runXxyyAlertTick(NOW + 15, deps({ '0xfast': '2.5' }, NOW + 12));

  const alert = wr.listPumpAlerts(user.id, 0)[0];
  assert.ok(alert);
  assert.equal(alert.priceUsd, '2.5');
  assert.equal(alert.level, 2);
  assert.equal(alert.priceSource, 'xxyy');
  assert.equal(alert.priceRegime, XXYY_PRICE_REGIME);
  assert.equal(alert.quoteFetchedAt, NOW + 12);
  assert.equal(alert.evaluatedAt, NOW + 15);
});

test('共享看板的 DexScreener 价格不会覆盖钱包 XXYY 报警', async () => {
  const tokenId = 'bsc:0xshared-fast';
  const { user } = holder(tokenId);
  const db = getRawDb();
  db.prepare(
    `INSERT INTO tokens (id, chain, address, added_at, visibility)
     VALUES (?, 'bsc', '0xshared-fast', ?, 'public')`,
  ).run(tokenId, NOW);
  db.prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, source)
     VALUES (?, '5m', ?, '100', '100', '100', '100', 'dexscreener')`,
  ).run(tokenId, NOW);

  await runXxyyAlertTick(NOW, deps({ '0xshared-fast': '1' }, NOW));
  await runXxyyAlertTick(NOW + 15, deps({ '0xshared-fast': '3' }, NOW + 15));

  const alert = wr.listPumpAlerts(user.id, 0)[0];
  assert.equal(alert?.priceUsd, '3');
  assert.equal(alert?.priceSource, 'xxyy');
  assert.equal((db.prepare(
    `SELECT c FROM candles WHERE token_id = ? AND timeframe = '5m'`,
  ).get(tokenId) as { c: string }).c, '100');
});

test('XXYY 缺价时不拿任何 DS/共享看板价格替代', async () => {
  const tokenId = 'bsc:0xmissing-fast';
  const { user } = holder(tokenId);
  getRawDb().prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, source)
     VALUES (?, '5m', ?, '1', '9', '1', '9', 'dexscreener')`,
  ).run(tokenId, NOW);
  const result = await runXxyyAlertTick(NOW, deps({}, NOW));
  assert.equal(wr.listPumpAlerts(user.id, 0).length, 0);
  assert.equal(getRawDb().prepare(
    `SELECT count(*) AS n FROM wallet_xxyy_candles WHERE token_id = ?`,
  ).get(tokenId) && (getRawDb().prepare(
    `SELECT count(*) AS n FROM wallet_xxyy_candles WHERE token_id = ?`,
  ).get(tokenId) as { n: number }).n, 0);
  assert.ok(result.requested >= 1);
});

test('非 2x 的 XXYY 上涨可单独触发运行期 ATH', async () => {
  const tokenId = 'solana:AthMintCase';
  const { user } = holder(tokenId);
  await runXxyyAlertTick(NOW, deps({ AthMintCase: '1' }, NOW));
  await runXxyyAlertTick(NOW + 15, deps({ AthMintCase: '1.2' }, NOW + 15));
  const alert = wr.listPumpAlerts(user.id, 0)[0];
  assert.equal(alert?.kind, 'ath');
  assert.equal(alert?.athWindow, 'all');
  assert.equal(alert?.priceSource, 'xxyy');
});

test('极端跳价等待下一次 XXYY 复核，第二次一致后才进入状态机', async () => {
  const tokenId = 'bsc:0xconfirm-fast';
  const { user } = holder(tokenId);
  upsertXxyyCandle(tokenId, '1', null, NOW - 300);
  await runXxyyAlertTick(NOW, deps({ '0xconfirm-fast': '2000' }, NOW));
  assert.equal(wr.listPumpAlerts(user.id, 0).length, 0);
  await runXxyyAlertTick(NOW + 15, deps({ '0xconfirm-fast': '2050' }, NOW + 15));
  const row = getRawDb().prepare(
    `SELECT c FROM wallet_xxyy_candles WHERE token_id = ? ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId) as { c: string };
  assert.equal(row.c, '2050');
});

test('HTTP 200 但 XXYY 覆盖率掉到健康水位一半以下会显式降级', async () => {
  const db = getRawDb();
  db.prepare(`DELETE FROM wallet_xxyy_source_baselines WHERE chain = 'bsc'`).run();
  db.prepare(`DELETE FROM source_health WHERE source_id = 'xxyy-alerts:bsc'`).run();
  for (let i = 0; i < 6; i++) holder(`bsc:0xcoverage-${i}`);
  const addresses = wr.monitoredTokenIds()
    .filter((id) => id.startsWith('bsc:')).map((id) => id.slice(4));
  const full = Object.fromEntries(addresses.map((address) => [address, '1']));
  await runXxyyAlertTick(NOW + 600, deps(full, NOW + 600));
  await runXxyyAlertTick(NOW + 615, deps({ [addresses[0]!]: '1' }, NOW + 615));
  const health = db.prepare(
    `SELECT consecutive_failures, last_fail_message FROM source_health
      WHERE source_id = 'xxyy-alerts:bsc'`,
  ).get() as { consecutive_failures: number; last_fail_message: string };
  assert.equal(health.consecutive_failures, 1);
  assert.match(health.last_fail_message, /覆盖率突然掉崖/);
});
