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

test('每个币独立生成一条 Chrome 通知，同批事件不合并也不丢失', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    row(`coin-${i}`, 'level', '2', 2, 20 + i));
  const batch = buildAlertBatch(rows);
  const specs = buildNotificationSpecs(batch, (a) => a.symbol ?? a.id);
  assert.equal(specs.length, 7);
  assert.deepEqual(specs.map((spec) => spec.alertIds), rows.map((alert) => [alert.id]));
  assert.equal(new Set(specs.map((spec) => spec.tag)).size, 7, '每个事件的 tag 必须不同，不能互相替换');
  assert.ok(specs.every((spec) => !spec.title.includes('共 7 个行情异动')));
});

test('单币通知保留所在链、市值变化、判定窗口与持仓价值', () => {
  const pump = row('cap', 'level', '2.035', 2, 30);
  pump.marketCapUsd = 162_400;
  pump.priceUsd = '2.035';
  pump.basePriceUsd = '1';
  pump.valueUsd = '125.5';
  const spec = buildNotificationSpecs(buildAlertBatch([pump]), (a) => a.symbol ?? a.id)[0]!;
  assert.match(spec.title, /🚀.*cap.*BSC.*暴涨 2\.0x/);
  assert.match(spec.body, /市值.*→.*162\.4K/);
  assert.match(spec.body, /5 分钟内从低点/);
  assert.match(spec.body, /持仓.*125/);
});

test('不同链使用直观链名，ATH 与暴涨标题一眼可区分', () => {
  const ath = row('sue', 'ath', '1.18', 0, 32);
  ath.chain = 'robinhood';
  ath.tokenId = 'robinhood:0xsue';
  ath.athScope = '30天新高';
  const pump = row('base-pump', 'level', '3', 3, 33);
  pump.chain = 'base';
  pump.tokenId = 'base:0xbase';
  const specs = buildNotificationSpecs(buildAlertBatch([ath, pump]), (a) => a.symbol ?? a.id);
  assert.match(specs[0]!.title, /^🏆.*sue.*Robinhood.*破30天新高$/);
  assert.match(specs[1]!.title, /^🚀.*base-pump.*Base.*暴涨 3\.0x/);
});

test('同一币由多个已备注地址持有时，合并通知列出全部备注', () => {
  const pump = row('wallet-labels', 'level', '2.1', 2, 31);
  pump.walletLabels = ['自己1', '自己2'];
  const spec = buildNotificationSpecs(buildAlertBatch([pump]), (a) => a.symbol ?? a.id)[0]!;
  assert.match(spec.body, /地址 自己1、自己2/);
});

test('Solana RPC 系统通知说明保留旧持仓，不冒充报价回退', () => {
  const alert = { ...row('sol-rpc', 'source-down', '1', 0, 13), tokenId: 'system:xxyy-solana-rpc' };
  const specs = buildNotificationSpecs(buildAlertBatch([alert]), (a) => a.symbol ?? a.tokenId);
  assert.equal(specs.length, 1);
  assert.match(specs[0]!.title, /Solana 钱包 RPC 异常/);
  assert.match(specs[0]!.body, /旧持仓已保留/);
  assert.doesNotMatch(specs[0]!.body, /DexScreener/);
});
