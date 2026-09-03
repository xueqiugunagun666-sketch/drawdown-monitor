import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesFilter, isDefault, DEFAULT_FILTER,
  UPSTREAM_MIN_DRAWDOWN, UPSTREAM_MIN_PEAK, type TrashFilter,
} from './filters.ts';

const NOW = 1_788_480_000;
const row = (over: Partial<Parameters<typeof matchesFilter>[0]> = {}) => ({
  triggeredAt: NOW - 3600, drawdownPercent: 85, peakMarketCap: 2_000_000, ...over,
});
const f = (over: Partial<TrashFilter> = {}): TrashFilter => ({ ...DEFAULT_FILTER, ...over });

test('默认不筛掉任何上游来的信号', () => {
  assert.equal(UPSTREAM_MIN_DRAWDOWN, 80);
  assert.equal(UPSTREAM_MIN_PEAK, 1_000_000);
  assert.equal(matchesFilter(row({ drawdownPercent: 80, peakMarketCap: 1_000_000 }), f(), NOW), true);
  assert.equal(isDefault(DEFAULT_FILTER), true);
});

test('天数按触发时间算', () => {
  assert.equal(matchesFilter(row({ triggeredAt: NOW - 86400 * 2 }), f({ days: 3 }), NOW), true);
  assert.equal(matchesFilter(row({ triggeredAt: NOW - 86400 * 4 }), f({ days: 3 }), NOW), false);
  assert.equal(matchesFilter(row({ triggeredAt: NOW - 86400 * 4 }), f({ days: null }), NOW), true);
});

test('没有触发时间的不被天数筛掉 —— 字段缺失不该让币静静消失', () => {
  // "被筛掉"和"本来就没有"长得一模一样，宁可多显示一条
  assert.equal(matchesFilter(row({ triggeredAt: null }), f({ days: 1 }), NOW), true);
});

test('跌幅与峰值只能往严了收', () => {
  assert.equal(matchesFilter(row({ drawdownPercent: 82 }), f({ minDrawdown: 90 }), NOW), false);
  assert.equal(matchesFilter(row({ drawdownPercent: 95 }), f({ minDrawdown: 90 }), NOW), true);
  assert.equal(matchesFilter(row({ peakMarketCap: 1_200_000 }), f({ minPeak: 5_000_000 }), NOW), false);
  assert.equal(matchesFilter(row({ peakMarketCap: 8_000_000 }), f({ minPeak: 5_000_000 }), NOW), true);
});

test('数值缺失的不被数值条件筛掉', () => {
  assert.equal(matchesFilter(row({ drawdownPercent: null }), f({ minDrawdown: 99 }), NOW), true);
  assert.equal(matchesFilter(row({ peakMarketCap: null }), f({ minPeak: 9e9 }), NOW), true);
});

test('多个条件是与关系', () => {
  const r = row({ triggeredAt: NOW - 86400 * 5, drawdownPercent: 99, peakMarketCap: 9e6 });
  assert.equal(matchesFilter(r, f({ days: 3, minDrawdown: 90, minPeak: 5e6 }), NOW), false, '天数不满足就出局');
});

test('isDefault 认得出任何一项被改过', () => {
  assert.equal(isDefault(f({ days: 7 })), false);
  assert.equal(isDefault(f({ minDrawdown: 90 })), false);
  assert.equal(isDefault(f({ minPeak: 5e6 })), false);
});
