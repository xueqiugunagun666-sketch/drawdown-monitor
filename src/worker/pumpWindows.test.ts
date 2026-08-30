import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  WINDOW_SECONDS, TIMEFRAMES, windowStartTs, computeMultiples, computeMultiplesDetailed,
  type Candle5m,
} from './pumpWindows.ts';

/** 造一串 5m candle，ts 从 startTs 起每 300 秒一根 */
function series(startTs: number, rows: Array<[o: string, l: string]>): Candle5m[] {
  return rows.map(([o, l], i) => ({ ts: startTs + i * 300, o, l }));
}

const NOW = 1_700_000_100;                    // 故意不落在 300 边界上
const CUR = Math.floor(NOW / 300) * 300;      // 当前这根 candle 的 ts

test('窗口起点：5m 就是当前这根 candle', () => {
  assert.equal(windowStartTs('5m', NOW), CUR);
});

test('窗口起点：其余窗口按 5m 根数回推', () => {
  assert.equal(windowStartTs('1h', NOW), CUR - 3300);
  assert.equal(windowStartTs('6h', NOW), CUR - 21300);
  assert.equal(windowStartTs('24h', NOW), CUR - 86100);
});

test('每个窗口恰好覆盖 WINDOW_SECONDS/300 根 candle', () => {
  for (const tf of TIMEFRAMES) {
    const n = (CUR - windowStartTs(tf, NOW)) / 300 + 1;
    assert.equal(n, WINDOW_SECONDS[tf] / 300, `${tf} 应覆盖 ${WINDOW_SECONDS[tf] / 300} 根`);
  }
});

test('窗口边界不随 now 在 candle 内的位置漂移', () => {
  // 用根数而不是"now 减秒数"划界，就是为了这个：
  // now 落在 candle 头部还是尾部，覆盖的根数必须一样
  const early = Math.floor(NOW / 300) * 300 + 1;
  const late = Math.floor(NOW / 300) * 300 + 299;
  for (const tf of TIMEFRAMES) {
    assert.equal(windowStartTs(tf, early), windowStartTs(tf, late), `${tf} 窗口起点不该漂移`);
  }
});

test('low 取窗口内最低的 l，open 取最老那根的 o', () => {
  const candles = series(CUR - 3300, [['10', '8'], ['11', '9'], ['12', '5'], ['13', '11']]);
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  const low = out.find((r) => r.timeframe === '1h' && r.basis === 'low')!;
  const open = out.find((r) => r.timeframe === '1h' && r.basis === 'open')!;
  assert.equal(low.base.toString(), '5');
  assert.equal(low.multiple.toString(), '4');
  assert.equal(open.base.toString(), '10');
  assert.equal(open.multiple.toString(), '2');
});

test('5m 窗口只看当前这一根', () => {
  const candles = series(CUR - 900, [['1', '1'], ['1', '1'], ['1', '1'], ['4', '4']]);
  const out = computeMultiples(candles, new Decimal('8'), NOW);
  const m5 = out.find((r) => r.timeframe === '5m' && r.basis === 'open')!;
  assert.equal(m5.base.toString(), '4', '不该把更早的 candle 算进 5m 窗口');
  assert.equal(m5.multiple.toString(), '2');
});

test('历史不够长时只判得出短窗口，长窗口不产出', () => {
  // 只有一根 candle 的新币：5m 判得了，24h 判不了。
  // 若不做这个判定，会拿 5 分钟的数据算出"24 小时涨了 2 倍"，四个窗口同时触发
  const out = computeMultiples(series(CUR, [['10', '10']]), new Decimal('20'), NOW);
  assert.ok(out.some((r) => r.timeframe === '5m'));
  assert.ok(!out.some((r) => r.timeframe === '24h'), '历史不足 24h，不该产出 24h 结果');
  assert.ok(!out.some((r) => r.timeframe === '1h'), '历史不足 1h，也不该产出');
});

test('历史刚好够时长窗口才开始产出', () => {
  // 12 根 = 1 小时，最老那根正好落在 1h 窗口起点
  const out = computeMultiples(series(CUR - 3300, Array(12).fill(['10', '10'])), new Decimal('20'), NOW);
  assert.ok(out.some((r) => r.timeframe === '1h'), '刚好够 1h 就该产出');
  assert.ok(!out.some((r) => r.timeframe === '6h'), '但还不够 6h');
});

test('中间缺根不影响判定 —— 数据源会省略无成交的 candle', () => {
  // 首尾各一根，中间全空。这在本项目里是常态（见 ath.ts 的同类处理）
  const candles: Candle5m[] = [
    { ts: CUR - 3300, o: '10', l: '10' },
    { ts: CUR, o: '12', l: '12' },
  ];
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  assert.ok(out.some((r) => r.timeframe === '1h'), '只对整体历史长度严格，对中间缺根宽容');
});

test('gaps 说明哪个窗口为什么判不了，供 UI 显示而非静默省略', () => {
  const { results, gaps } = computeMultiplesDetailed(series(CUR, [['10', '10']]), new Decimal('20'), NOW);
  assert.ok(results.some((r) => r.timeframe === '5m'));
  assert.deepEqual(gaps.map((g) => g.timeframe).sort(), ['1h', '24h', '6h']);
  assert.ok(gaps.every((g) => g.reason === 'too_young'));
});

test('完全没有 candle 时四个窗口都标记 no_history', () => {
  const { results, gaps } = computeMultiplesDetailed([], new Decimal('1'), NOW);
  assert.equal(results.length, 0);
  assert.equal(gaps.length, 4);
  assert.ok(gaps.every((g) => g.reason === 'no_history'));
});

test('base 为 0 时跳过，不能除零', () => {
  assert.equal(computeMultiples(series(CUR, [['0', '0']]), new Decimal('20'), NOW).length, 0);
});

test('base 为负数时跳过', () => {
  assert.equal(computeMultiples(series(CUR, [['-1', '-1']]), new Decimal('20'), NOW).length, 0);
});

test('null 价格的 candle 不参与计算', () => {
  const candles: Candle5m[] = [
    { ts: CUR - 300, o: null, l: null },
    { ts: CUR, o: '10', l: '10' },
  ];
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  assert.equal(out.find((r) => r.timeframe === '5m' && r.basis === 'open')!.base.toString(), '10');
});

test('乱序传入的 candle 也能正确求值', () => {
  const candles = series(CUR - 3300, [['10', '8'], ['11', '9'], ['12', '5'], ['13', '11']]).reverse();
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  assert.equal(out.find((r) => r.timeframe === '1h' && r.basis === 'open')!.base.toString(), '10');
});

test('价格低于基准时倍数小于 1，不报错也不截断', () => {
  const out = computeMultiples(series(CUR, [['10', '10']]), new Decimal('5'), NOW);
  assert.equal(out.find((r) => r.basis === 'open')!.multiple.toString(), '0.5');
});

test('memecoin 量级的极小价格不丢精度', () => {
  const out = computeMultiples(
    series(CUR, [['0.000000000001', '0.000000000001']]), new Decimal('0.000000000002'), NOW);
  assert.equal(out.find((r) => r.basis === 'open')!.multiple.toString(), '2');
});

test('不变量：low 基准恒不高于 open 基准，因此 low 倍数恒不低于 open', () => {
  const candles = series(CUR - 3300, [['10', '3'], ['11', '4'], ['9', '2']]);
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  const low = out.find((r) => r.timeframe === '1h' && r.basis === 'low')!;
  const open = out.find((r) => r.timeframe === '1h' && r.basis === 'open')!;
  assert.ok(low.base.lte(open.base));
  assert.ok(low.multiple.gte(open.multiple));
});

test('空 candle 数组返回空结果，不抛错', () => {
  assert.equal(computeMultiples([], new Decimal('1'), NOW).length, 0);
});
