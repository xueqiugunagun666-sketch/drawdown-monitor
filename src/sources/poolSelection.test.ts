import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { selectPools, medianPrice, deviationFactor } from './poolSelection.ts';

const P = (price: string, liq: number) => ({ priceUsd: new Decimal(price), liquidityUsd: liq });

test('中位数：奇数与偶数个', () => {
  assert.equal(medianPrice([new Decimal(1), new Decimal(3), new Decimal(2)]).toString(), '2');
  assert.equal(medianPrice([new Decimal(1), new Decimal(3)]).toString(), '2');
});

test('偏离倍数对称', () => {
  assert.equal(deviationFactor(new Decimal(2), new Decimal(1)).toString(), '2');
  assert.equal(deviationFactor(new Decimal('0.5'), new Decimal(1)).toString(), '2');
});

test('BONK 场景：虚高 4948x 的高流动性池被剔除', () => {
  // 真实数据形状：1 个坏池流动性最高，29 个池价格一致
  const pools = [
    P('0.01563', 3_416_429),       // 坏池：价格 4948x，流动性最高
    P('0.000003152', 123_053),
    P('0.000003156', 122_439),
    P('0.000003153', 117_538),
  ];
  const r = selectPools(pools, 1.5);
  assert.equal(r.outliers.length, 1);
  assert.equal(r.outliers[0]!.liquidityUsd, 3_416_429);
  // 主池应是剩余池中流动性最高者，而非坏池
  assert.equal(r.primary.liquidityUsd, 123_053);
  // liquidity_total 不含坏池
  assert.equal(r.liquidityTotal, 123_053 + 122_439 + 117_538);
  assert.equal(r.crossValidated, true);
});

test('JUP 场景：坏池占总流动性绝大多数时仍能剔除（中位数不加权）', () => {
  const pools = [
    P('1014.61', 421_000_000),
    P('1014.50', 1_000_000),
    P('0.20495', 1_200_000),
    P('0.20490', 1_080_000),
    P('0.20500', 500_000),
  ];
  const r = selectPools(pools, 1.5);
  assert.equal(r.outliers.length, 2);
  assert.ok(r.primary.priceUsd.lt(1), '主池价格应是真实量级');
  assert.ok(r.liquidityTotal < 3_000_000, `liquidity_total 应剔除虚高，实际 ${r.liquidityTotal}`);
});

test('健康代币：1.0-1.3x 的真实价差不被误伤', () => {
  const pools = [P('0.1994', 5_424_822), P('0.19925', 120_000), P('0.2025', 80_000)];
  const r = selectPools(pools, 1.5);
  assert.equal(r.outliers.length, 0);
  assert.equal(r.primary.liquidityUsd, 5_424_822);
});

test('池数 < 3：不剔除，标记为未交叉验证', () => {
  const r1 = selectPools([P('100', 5000)], 1.5);
  assert.equal(r1.crossValidated, false);
  assert.equal(r1.outliers.length, 0);

  // 两池互差 5000x 也不剔除 —— 无从判断谁对
  const r2 = selectPools([P('0.0002', 900), P('1.0', 100)], 1.5);
  assert.equal(r2.crossValidated, false);
  assert.equal(r2.outliers.length, 0);
  assert.equal(r2.primary.liquidityUsd, 900);
});
