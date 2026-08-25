import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { computeAth, type AthCandle } from './ath.ts';

const C = (ts: number, h: string, c: string, vol: number, liq: number | null = 10000): AthCandle => ({
  ts, h: new Decimal(h), c: new Decimal(c), volumeUsd: vol, liquidityTotal: liq,
});

test('合格 candle 不足 k 根时 ath_robust 为 null（不得瞎给值）', () => {
  const r = computeAth([C(0, '1', '1', 100), C(300, '2', '2', 100)], 3);
  assert.equal(r.athRobust, null);
  assert.equal(r.athRaw?.toString(), '2');
});

test('ath_robust = 第 k 高的 close，插针只影响 ath_raw', () => {
  // 一根针：high 冲到 100，但 close 只有 10；其余 close 稳定在 5~7
  const candles = [
    C(0, '5', '5', 1000),
    C(300, '100', '10', 1000),   // 插针
    C(600, '7', '7', 1000),
    C(900, '6', '6', 1000),
    C(1200, '5', '5', 1000),
  ];
  const r = computeAth(candles, 3);
  assert.equal(r.athRaw?.toString(), '100', 'raw 应保留针尖');
  // close 降序: 10, 7, 6, 5, 5 -> 第 3 高 = 6
  assert.equal(r.athRobust?.toString(), '6');
  assert.equal(r.athTs, 900);
});

test('k=1 时退化为最高 close', () => {
  const candles = [C(0, '5', '5', 1000), C(300, '100', '10', 1000), C(600, '7', '7', 1000)];
  assert.equal(computeAth(candles, 1).athRobust?.toString(), '10');
});

test('vol_floor 过滤掉低成交 candle', () => {
  // 非零 volume: 1000,1000,1000,1 -> 中位数 1000 -> floor=100
  // volume=1 的那根 close=999 被排除
  const candles = [
    C(0, '5', '5', 1000),
    C(300, '999', '999', 1),      // 低成交的假高点
    C(600, '7', '7', 1000),
    C(900, '6', '6', 1000),
  ];
  const r = computeAth(candles, 3);
  assert.ok(r.volFloor > 0 && r.volFloor < 1000, `volFloor=${r.volFloor}`);
  assert.equal(r.qualifyingCount, 3);
  // 合格 close: 5,7,6 -> 第 3 高 = 5
  assert.equal(r.athRobust?.toString(), '5');
});

test('vol_h1_at_ath：13 根归一到 60 分钟', () => {
  // 构造 ATH 在中间，前后各 6 根 volume 均为 100 -> 13*100*12/13 = 1200
  const candles: AthCandle[] = [];
  for (let i = 0; i < 13; i++) candles.push(C(i * 300, '1', i === 6 ? '9' : '1', 100));
  const r = computeAth(candles, 1);
  assert.equal(r.athTs, 6 * 300);
  assert.ok(Math.abs(r.volH1AtAth! - 1200) < 1e-6, `实际 ${r.volH1AtAth}`);
});

test('回填段（liquidity 为 null）标记 inferred + volume_proxy', () => {
  const candles = [
    C(0, '5', '5', 1000, null), C(300, '7', '7', 1000, null), C(600, '6', '6', 1000, null),
  ];
  const r = computeAth(candles, 3);
  assert.equal(r.athConfidence, 'inferred');
  assert.equal(r.verdictBasis, 'volume_proxy');
  assert.equal(r.athLiquidity, null);
  assert.ok(r.volH1AtAth! > 0, 'volume 替代分母仍应可用');
});

test('实时段（liquidity 已知）标记 verified + liquidity', () => {
  const candles = [
    C(0, '5', '5', 1000, 50000), C(300, '7', '7', 1000, 60000), C(600, '6', '6', 1000, 55000),
  ];
  const r = computeAth(candles, 3);
  assert.equal(r.athConfidence, 'verified');
  assert.equal(r.verdictBasis, 'liquidity');
  assert.equal(r.athLiquidity, 50000);  // 第 3 高 close=5 那根
});

test('memecoin 量级：1e-12 不丢精度', () => {
  const candles = [
    C(0, '0.000000000001234', '0.000000000001234', 1000),
    C(300, '0.000000000001235', '0.000000000001235', 1000),
    C(600, '0.000000000001233', '0.000000000001233', 1000),
  ];
  const r = computeAth(candles, 3);
  assert.equal(r.athRobust?.toString(), '0.000000000001233');
  assert.equal(r.athRaw?.toString(), '0.000000000001235');
});

test('堆在大量 candle 下与全排序结果一致', () => {
  const n = 5000, k = 7;
  const candles: AthCandle[] = [];
  for (let i = 0; i < n; i++) {
    const v = ((i * 7919) % 10007) / 10007;
    candles.push(C(i * 300, String(v), String(v), 1000));
  }
  const r = computeAth(candles, k);
  const expected = candles.map((c) => c.c).sort((a, b) => b.cmp(a))[k - 1]!;
  assert.equal(r.athRobust?.toString(), expected.toString());
});
