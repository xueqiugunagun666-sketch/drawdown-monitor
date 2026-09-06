import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlertRow } from './AlertFeed.tsx';
import {
  buildAlertBatch, buildNotificationSpecs, formatAthDelta, formatMultiple,
} from './notificationBatch.ts';

function row(
  id: string, kind: string, multiple: string, level: number, seq: number,
): AlertRow {
  return {
    id, tokenId: `bsc:${id}`, firedAt: 1, timeframe: '5m', basis: 'low',
    level, multiple, priceUsd: null, basePriceUsd: null, valueUsd: null,
    symbol: id, address: `0x${id}`, chain: 'bsc', seq, kind,
  };
}

test('倍数与 ATH 百分比全部用 Decimal，极小值不变成科学计数或 NaN', () => {
  assert.equal(formatMultiple('5.25'), '5.3');
  assert.equal(formatMultiple('0.00000000000000000000000001'), '0.0');
  assert.equal(formatMultiple('not-a-price'), null);
  assert.equal(formatAthDelta('1.125'), '高出 13%');
  assert.equal(formatAthDelta('not-a-price'), null);
});

test('重复事件只保留一行，系统与行情各自保留全部事件', () => {
  const pump = row('pump', 'level', '2', 2, 10);
  const ath = row('ath', 'ath', '1.1', 0, 11);
  const system = row('source', 'source-down', '1', 0, 12);
  const duplicate = { ...pump, multiple: '2.5' };
  const batch = buildAlertBatch([pump, ath, system, duplicate]);
  assert.equal(batch.rows.length, 3);
  assert.deepEqual(batch.market.map((a) => a.id), ['pump', 'ath']);
  assert.deepEqual(batch.system.map((a) => a.id), ['source']);
});

test('批次通知最多两条，前五条预览且正文说明剩余事件仍在页面', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    row(`coin-${i}`, 'level', '2', 2, 20 + i));
  const batch = buildAlertBatch(rows);
  const specs = buildNotificationSpecs(batch, (a) => a.symbol ?? a.id);
  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.alertIds.length, 7);
  assert.match(specs[0]?.body ?? '', /另外 2 条已保留在页面异动记录/);
});

test('行情摘要保留市值变化、判定窗口与持仓价值', () => {
  const pump = row('cap', 'level', '2.035', 2, 30);
  pump.marketCapUsd = 162_400;
  pump.priceUsd = '2.035';
  pump.basePriceUsd = '1';
  pump.valueUsd = '125.5';
  const spec = buildNotificationSpecs(buildAlertBatch([pump]), (a) => a.symbol ?? a.id)[0]!;
  assert.match(spec.body, /市值.*→.*162\.4K/);
  assert.match(spec.body, /5 分钟内从低点/);
  assert.match(spec.body, /持仓.*125/);
});

test('同一币由多个已备注地址持有时，合并通知列出全部备注', () => {
  const pump = row('wallet-labels', 'level', '2.1', 2, 31);
  pump.walletLabels = ['自己1', '自己2'];
  const spec = buildNotificationSpecs(buildAlertBatch([pump]), (a) => a.symbol ?? a.id)[0]!;
  assert.match(spec.body, /地址 自己1、自己2/);
});
