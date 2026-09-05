import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  summarizeAth, describeAthScope, pickResolution, sourcesAgree,
  COMPLETENESS_SLACK_SECONDS,
} from './athHistory.ts';
import type { Candle } from '../sources/types.ts';

const DAY = 86400;
const NOW = 1_788_600_000;

const c = (ts: number, close: string | null, high?: string): Candle => ({
  ts, o: null, l: null,
  h: high === undefined ? null : new Decimal(high),
  c: close === null ? null : new Decimal(close),
} as unknown as Candle);

test('取每根的最高价 —— 历史最高本来就是最高价', () => {
  const s = summarizeAth([c(NOW - 3 * DAY, '1'), c(NOW - 2 * DAY, '3'), c(NOW - DAY, '2')], null, NOW);
  assert.equal(s.athPrice!.toString(), '3');
  assert.equal(s.athTs, NOW - 2 * DAY);
});

test('回归：日内尖峰不能被收盘价抹掉 —— Sue 那条假新高就是这么来的', () => {
  // 线上实测：Sue 真实最高 0.006444（当天 11:00），按小时线收盘价算
  // 只有 0.0046575，低 38%。价格到 0.005016 时看着像突破 1.126 倍，
  // 实际离真实高点还差 22%
  const s = summarizeAth([
    c(NOW - 2 * DAY, '0.004', '0.0042'),
    c(NOW - DAY, '0.0046575175', '0.006443578'),   // 收盘远低于当根最高
    c(NOW, '0.0044', '0.0045'),
  ], null, NOW);
  assert.equal(s.athPrice!.toString(), '0.006443578');
  assert.equal(s.athTs, NOW - DAY);
});

test('只有收盘价（残缺的根）时退而用收盘价，不当没有', () => {
  const s = summarizeAth([c(NOW - DAY, '5'), c(NOW, '3', '9')], null, NOW);
  assert.equal(s.athPrice!.toString(), '9');
  const onlyClose = summarizeAth([c(NOW - DAY, '5'), c(NOW, '7')], null, NOW);
  assert.equal(onlyClose.athPrice!.toString(), '7');
});

test('残缺的根跳过，不当成 0', () => {
  const s = summarizeAth([c(NOW - DAY, null), c(NOW, '5')], null, NOW);
  assert.equal(s.athPrice!.toString(), '5');
});

test('空历史返回 null 而不是 0 —— 没有数据和最高价是 0 是两回事', () => {
  const s = summarizeAth([], 1, NOW);
  assert.equal(s.athPrice, null);
  assert.equal(s.athTs, null);
  assert.equal(s.historyStartTs, null);
  assert.equal(s.complete, false);
  assert.equal(s.coverageSeconds, 0);
});

test('历史起点早于建池时间 = 覆盖完整，可以说历史新高', () => {
  const created = NOW - 20 * DAY;
  const s = summarizeAth([c(created, '1'), c(NOW, '2')], created, NOW);
  assert.equal(s.complete, true);
  assert.equal(describeAthScope(s), '历史新高');
});

test('历史起点晚于建池时间 = 不完整，只能说 N 天新高', () => {
  // 币是 90 天前建的池，我们只有最近 6 天
  const s = summarizeAth([c(NOW - 6 * DAY, '1'), c(NOW, '2')], NOW - 90 * DAY, NOW);
  assert.equal(s.complete, false);
  assert.equal(s.coverageSeconds, 6 * DAY);
  assert.equal(describeAthScope(s), '6 天新高');
});

test('建池时间未知时一律判不完整 —— 不知道币多老就没资格说"全部历史"', () => {
  const s = summarizeAth([c(NOW - 100 * DAY, '1')], null, NOW);
  assert.equal(s.complete, false);
  assert.match(describeAthScope(s), /100 天新高/);
});

test('宽限一小时：差几分钟不该被判成不完整', () => {
  // 建池到第一笔成交总有间隔，卡死会让本来完整的历史白白降级
  const created = NOW - 20 * DAY;
  const almost = summarizeAth([c(created + COMPLETENESS_SLACK_SECONDS, '1')], created, NOW);
  assert.equal(almost.complete, true, '正好在宽限内算完整');
  const late = summarizeAth([c(created + COMPLETENESS_SLACK_SECONDS + 1, '1')], created, NOW);
  assert.equal(late.complete, false, '超出宽限就是不完整');
});

test('历史不足一天时用小时说，不能含糊说"新高"', () => {
  const s = summarizeAth([c(NOW - 5 * 3600, '1')], NOW - 90 * DAY, NOW);
  assert.equal(describeAthScope(s), '5 小时新高');
  const tiny = summarizeAth([c(NOW - 600, '1')], NOW - 90 * DAY, NOW);
  assert.equal(describeAthScope(tiny), '新高（历史不足一小时）');
});

test('历史完整但币太年轻时要把年龄说出来', () => {
  // 线上有 67 个币属于这一类。对 2 小时前建池的币说「突破历史新高」
  // 是真话，但听起来像个里程碑，而它的"历史"只有两小时
  const created = NOW - 2 * 3600;
  const young = summarizeAth([c(created, '1'), c(NOW, '2')], created, NOW);
  assert.equal(young.complete, true);
  assert.equal(describeAthScope(young), '上市 2 小时新高');

  const older = summarizeAth([c(NOW - 5 * DAY, '1')], NOW - 5 * DAY, NOW);
  assert.equal(describeAthScope(older), '历史新高', '够老了才配这四个字');
});

test('刚建池不到一小时', () => {
  const created = NOW - 600;
  const s = summarizeAth([c(created, '1')], created, NOW);
  assert.equal(describeAthScope(s), '上市不足一小时新高');
});

test('分辨率按币龄挑：年轻用小时线（精度高），老币只能用日线', () => {
  // GMGN 一次 1000 根：小时线覆盖 41 天，日线 1000 天
  assert.equal(pickResolution(15), '1h', '中位数 15 天的币用小时线');
  assert.equal(pickResolution(40), '1h');
  assert.equal(pickResolution(41), '1d', '超过 41 天小时线就盖不住了');
  assert.equal(pickResolution(2016), '1d');
  assert.equal(pickResolution(null), '1d', '不知道币龄就按最老处理');
});

/* ---------- 长历史与实时价的口径校验 ---------- */

test('两个源量级一致就放行', () => {
  assert.equal(sourcesAgree(new Decimal('1'), new Decimal('1.05'), 10), true);
  assert.equal(sourcesAgree(new Decimal('1'), new Decimal('9.9'), 10), true, '真实大涨不该被误杀');
});

test('Monkey 那条：两个源差 258 倍，必须拦', () => {
  // GMGN 最后一根收盘 1.9951331e-25，DexScreener 现价 5.154e-23
  const gmgn = new Decimal('0.00000000000000000000000019951331');
  const dex = new Decimal('0.00000000000000000000005154');
  assert.equal(sourcesAgree(gmgn, dex, 10), false);
});

test('方向对称 —— 谁大谁小都要拦', () => {
  assert.equal(sourcesAgree(new Decimal('100'), new Decimal('1'), 10), false);
  assert.equal(sourcesAgree(new Decimal('1'), new Decimal('100'), 10), false);
});

test('正好 10 倍放行，超过才拦', () => {
  assert.equal(sourcesAgree(new Decimal('1'), new Decimal('10'), 10), true);
  assert.equal(sourcesAgree(new Decimal('1'), new Decimal('10.1'), 10), false);
});

test('缺一边就无从比较，不拦 —— 别因为拿不到实时价就把所有 ATH 废掉', () => {
  assert.equal(sourcesAgree(null, new Decimal('1'), 10), true);
  assert.equal(sourcesAgree(new Decimal('1'), null, 10), true);
  assert.equal(sourcesAgree(new Decimal('0'), new Decimal('1'), 10), true);
});
