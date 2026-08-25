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

test('vol_h1_at_ath 按时间戳取窗口，稀疏 candle 不撑大分母', () => {
  // GT 会省略无成交 candle。这里 ATH 两侧各只有 2 根，其余时段缺失。
  // 若按数组下标 ±6 取，会把 3 小时外的数据算进来。
  const sparse: AthCandle[] = [
    C(0, '1', '1', 100),
    C(3600 * 3, '1', '1', 999999),          // 3 小时前，不应计入
    C(3600 * 4 - 600, '1', '1', 50),        // ATH 前 10 分钟
    C(3600 * 4, '9', '9', 100),             // ATH
    C(3600 * 4 + 600, '1', '1', 50),        // ATH 后 10 分钟
    C(3600 * 8, '1', '1', 999999),          // 4 小时后，不应计入
  ];
  const r = computeAth(sparse, 1, 300);
  assert.equal(r.athTs, 3600 * 4);
  // 窗口 [ATH-1800, ATH+1800] 内只有 50+100+50=200，归一 ×3600/3900
  const expected = 200 * (3600 / 3900);
  assert.ok(Math.abs(r.volH1AtAth! - expected) < 1e-6,
    `应为 ${expected}，实际 ${r.volH1AtAth}（若为百万级说明按下标取了窗口）`);
});

test('1h 粒度下 vol_h1_at_ath 仍归一到每小时口径', () => {
  const hourly: AthCandle[] = [];
  for (let i = 0; i < 13; i++) hourly.push(C(i * 3600, '1', i === 6 ? '9' : '1', 120));
  const r = computeAth(hourly, 1, 3600);
  assert.equal(r.athTs, 6 * 3600);
  // 13 根 ×120 = 1560，覆盖 13 小时，归一到 1 小时 -> 120
  assert.ok(Math.abs(r.volH1AtAth! - 120) < 1e-6, `应为 120，实际 ${r.volH1AtAth}`);
});

test('all_time 必须 >= rolling_90d：1h 粒度会漏掉小时内尖峰', () => {
  // 线上真实场景：同一段时间，5m 有 12 倍的样本量，第 k 高的 close 必然更高。
  // 若 all_time 只用 1h，就会出现「全历史最高点低于 90 天最高点」的荒谬结果。
  const fiveMin: AthCandle[] = [];
  const hourly: AthCandle[] = [];
  for (let h = 0; h < 24; h++) {
    let hourClose = 0;
    for (let i = 0; i < 12; i++) {
      // 小时内先冲高再回落，收盘价低于小时内峰值
      const v = 1 + (i === 5 ? 0.5 : 0) - i * 0.01;
      fiveMin.push(C(h * 3600 + i * 300, String(v), String(v), 1000));
      hourClose = v;
    }
    hourly.push(C(h * 3600, String(hourClose), String(hourClose), 12000));
  }
  const from5m = computeAth(fiveMin, 3, 300);
  const from1h = computeAth(hourly, 3, 3600);
  assert.ok(from5m.athRobust!.gt(from1h.athRobust!),
    `5m 的第 3 高 close (${from5m.athRobust}) 应高于 1h 的 (${from1h.athRobust})`);

  // 修复后的取法：两者取高，保证 all_time >= rolling_90d
  const allTime = from1h.athRobust!.gt(from5m.athRobust!) ? from1h : from5m;
  assert.equal(allTime.athRobust!.toString(), from5m.athRobust!.toString());
});
