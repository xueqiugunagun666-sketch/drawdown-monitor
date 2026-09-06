import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNotificationAlert, sourceAlertText, type AlertRow,
} from './AlertFeed.tsx';

function row(id: string, level: number, kind: string): AlertRow {
  return {
    id, tokenId: kind === 'source-down' ? 'system:xxyy' : `bsc:${id}`,
    firedAt: 1, timeframe: '5m', basis: 'low', level, multiple: String(level),
    priceUsd: null, basePriceUsd: null, valueUsd: null,
    symbol: null, address: null, chain: null, kind,
  };
}

test('同批有系统故障时优先通知系统故障，不被高倍行情盖住', () => {
  const system = row('system', 0, 'source-down');
  const pump = row('pump', 10, 'level');
  assert.equal(pickNotificationAlert([pump, system]), system);
});

test('没有系统故障时仍选择最高档行情', () => {
  const low = row('low', 2, 'level');
  const high = row('high', 5, 'level');
  assert.equal(pickNotificationAlert([low, high]), high);
  assert.equal(pickNotificationAlert([]), null);
});

test('数据源故障文案覆盖请求失败、缺失和偏价，并说明已回退', () => {
  const text = sourceAlertText(row('system', 0, 'source-down'));
  assert.match(text.title, /XXYY.*自动回退/);
  assert.match(text.body, /请求失败、缺失或偏价/);
  assert.match(text.body, /DexScreener/);
});
