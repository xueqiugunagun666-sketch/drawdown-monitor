import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  ATH_WINDOWS, windowRank, windowByKey, windowIsCovered,
  largestBrokenWindow, describeWindow,
} from './athWindows.ts';

const DAY = 86400;
const NOW = 1_788_600_000;
const d = (s: string | number) => new Decimal(s);

test('窗口从短到长排列 —— largestBrokenWindow 靠这个顺序取最长的', () => {
  assert.deepEqual(ATH_WINDOWS.map((w) => w.key),
    ['3d', '7d', '30d', '90d', '180d', '360d', 'all']);
  for (let i = 1; i < ATH_WINDOWS.length - 1; i++) {
    assert.ok(ATH_WINDOWS[i]!.seconds! > ATH_WINDOWS[i - 1]!.seconds!, `${i} 该比前一个长`);
  }
  assert.equal(ATH_WINDOWS[ATH_WINDOWS.length - 1]!.seconds, null, '最后一个是「全部」');
});

test('档次越大越有分量', () => {
  assert.ok(windowRank('all') > windowRank('360d'));
  assert.ok(windowRank('90d') > windowRank('7d'));
  assert.equal(windowRank('不存在'), -1);
});

test('历史覆盖不到的窗口是假的，必须裁掉', () => {
  // 6 天前才开始看的币，"360 天新高"只是 6 天新高换个说法
  const start = NOW - 6 * DAY;
  assert.equal(windowIsCovered(windowByKey('3d')!, start, NOW), true);
  assert.equal(windowIsCovered(windowByKey('7d')!, start, NOW), false, '只看了 6 天');
  assert.equal(windowIsCovered(windowByKey('360d')!, start, NOW), false);
  assert.equal(windowIsCovered(windowByKey('all')!, start, NOW), true, '「全部」永远等于手上的全部');
});

test('没有历史起点时一个窗口都不采信', () => {
  for (const w of ATH_WINDOWS) {
    if (w.key === 'all') continue;
    assert.equal(windowIsCovered(w, null, NOW), false, w.key);
  }
});

test('取突破的最长窗口 —— 一次上涨只说最有分量的那句', () => {
  const start = NOW - 400 * DAY;
  const highs = new Map([
    ['3d', d(10)], ['7d', d(12)], ['30d', d(15)],
    ['90d', d(20)], ['180d', d(50)], ['360d', d(80)], ['all', d(100)],
  ]);
  // 价 24：超过 90d(20)×1.1=22，但不到 180d(50)×1.1
  const w = largestBrokenWindow(d(24), highs, start, NOW, 0.10);
  assert.equal(w?.key, '90d');
  assert.equal(describeWindow(w!), '90 天新高');
});

test('突破全部历史时报「历史新高」', () => {
  const highs = new Map([['3d', d(10)], ['all', d(100)]]);
  const w = largestBrokenWindow(d(120), highs, NOW - 400 * DAY, NOW, 0.10);
  assert.equal(w?.key, 'all');
  assert.equal(describeWindow(w!), '历史新高');
});

test('只突破最短窗口时就只报它', () => {
  const highs = new Map([['3d', d(10)], ['7d', d(50)], ['all', d(100)]]);
  const w = largestBrokenWindow(d(12), highs, NOW - 400 * DAY, NOW, 0.10);
  assert.equal(w?.key, '3d');
});

test('一个都没突破就返回 null', () => {
  const highs = new Map([['3d', d(10)], ['all', d(100)]]);
  assert.equal(largestBrokenWindow(d(10.5), highs, NOW - 400 * DAY, NOW, 0.10), null,
    '超过 3d 高点但不足 10%');
});

test('覆盖不到的窗口即使"突破"了也不算 —— 否则把无知说成分量', () => {
  const start = NOW - 5 * DAY;            // 只看了 5 天
  const highs = new Map([
    ['3d', d(10)], ['7d', d(10)], ['360d', d(10)], ['all', d(10)],
  ]);
  const w = largestBrokenWindow(d(20), highs, start, NOW, 0.10);
  assert.equal(w?.key, 'all', '只有 3d 和 all 被覆盖，取更长的 all');
});

test('缺高点数据的窗口跳过，不当成 0', () => {
  const highs = new Map([['3d', d(10)]]);   // 只有 3d 有数据
  const w = largestBrokenWindow(d(100), highs, NOW - 400 * DAY, NOW, 0.10);
  assert.equal(w?.key, '3d', '别把没数据的窗口当成"高点是 0，随便就突破"');
});
