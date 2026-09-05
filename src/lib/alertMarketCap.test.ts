import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseMarketCap } from './alertMarketCap.ts';

test('起点市值由现市值按价格比例反推 —— 供应量不变', () => {
  // 线上真实例子：奶蛙 2.0x，$0.0000798376 -> $0.0001624，现市值 162.4K
  const b = baseMarketCap(162_436, '0.0001624', '0.0000798376')!;
  assert.ok(b > 79_000 && b < 80_500, `实际 ${b}，期望约 79.8K`);
});

test('缺任何一个数就返回 null，不编造', () => {
  assert.equal(baseMarketCap(null, '1', '0.5'), null);
  assert.equal(baseMarketCap(100, null, '0.5'), null);
  assert.equal(baseMarketCap(100, '1', null), null);
  assert.equal(baseMarketCap(NaN, '1', '0.5'), null);
});

test('价格为 0 / 负数 / 非法时不做除法', () => {
  assert.equal(baseMarketCap(100, '0', '0.5'), null);
  assert.equal(baseMarketCap(100, '1', '0'), null);
  assert.equal(baseMarketCap(100, '-1', '0.5'), null);
  assert.equal(baseMarketCap(100, '乱写', '0.5'), null);
});

test('极小价格上不塌精度 —— 用 number 算这里会变成 0', () => {
  const b = baseMarketCap(2_000_000,
    '0.0000000000000000000002', '0.0000000000000000000001')!;
  assert.ok(Math.abs(b - 1_000_000) < 1, `实际 ${b}`);
});

test('价格没变时起点等于现值', () => {
  assert.equal(baseMarketCap(500_000, '0.01', '0.01'), 500_000);
});
