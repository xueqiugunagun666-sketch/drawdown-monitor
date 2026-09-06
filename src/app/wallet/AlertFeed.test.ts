import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAthAlert, isPumpAthAlert, sourceAlertText, type AlertRow,
} from './AlertFeed.tsx';
import {
  buildAlertBatch, buildNotificationSpecs, stableNotificationTag,
} from './notificationBatch.ts';

function row(
  id: string, level: number, kind: string, multiple = String(level), seq = level,
): AlertRow {
  return {
    id, tokenId: kind === 'source-down' ? 'system:xxyy' : `bsc:${id}`,
    firedAt: 1, timeframe: '5m', basis: 'low', level, multiple,
    priceUsd: null, basePriceUsd: null, valueUsd: null,
    symbol: id, address: `0x${id}`, chain: 'bsc', kind, seq,
  };
}

test('同批系统与行情分开投递，系统不再吞掉行情', () => {
  const system = row('system', 0, 'source-down', '1', 11);
  const pump = row('pump', 2, 'level', '2', 12);
  const ath = row('ath', 0, 'ath', '1.2', 13);
  const batch = buildAlertBatch([pump, system, ath]);
  assert.deepEqual(batch.system.map((a) => a.id), ['system']);
  assert.deepEqual(batch.market.map((a) => a.id), ['pump', 'ath']);
  assert.equal(batch.sound, 'system-and-market');

  const specs = buildNotificationSpecs(batch, (a) => a.symbol ?? a.id);
  assert.deepEqual(specs.map((x) => x.channel), ['system', 'market']);
  assert.deepEqual(specs[0]?.alertIds, ['system']);
  assert.deepEqual(specs[1]?.alertIds, ['pump', 'ath']);
  assert.match(specs[1]?.body ?? '', /共|pump|ath/);
});

test('pump-ath 同时写出暴涨倍数、暴涨档位和新高', () => {
  const combined = row('monkey', 5, 'pump-ath', '5.25', 21);
  combined.athScope = '90天新高';
  const batch = buildAlertBatch([combined]);
  assert.equal(batch.sound, 'pump-and-ath');
  assert.equal(isAthAlert('pump-ath'), true);
  assert.equal(isPumpAthAlert('pump-ath'), true);
  const spec = buildNotificationSpecs(batch, (a) => a.symbol ?? a.id)[0]!;
  assert.match(spec.body, /暴涨 5\.3x/);
  assert.match(spec.body, /5x档/);
  assert.match(spec.body, /破90天新高/);
});

test('数据源故障文案覆盖请求失败、缺失和偏价，并说明已回退', () => {
  const text = sourceAlertText(row('system', 0, 'source-down'));
  assert.match(text.title, /XXYY.*自动回退/);
  assert.match(text.body, /请求失败、缺失或偏价/);
  assert.match(text.body, /DexScreener/);
});

test('同一批重放得到稳定 tag，不按通知标题去重', () => {
  const a = row('same-a', 2, 'level', '2', 31);
  const b = row('same-b', 5, 'level', '5', 32);
  const first = stableNotificationTag('market', [a, b]);
  const reordered = stableNotificationTag('market', [b, a]);
  const differentEvent = stableNotificationTag('market', [a, { ...b, id: 'same-c' }]);
  assert.equal(first, reordered);
  assert.notEqual(first, differentEvent);
  assert.match(first, /same-a:31/);
  assert.match(first, /same-b:32/);
});
