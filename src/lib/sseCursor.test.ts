import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCursor } from './sseCursor.ts';

const NOW = 1_788_450_000;

test('都不带就从此刻开始 —— 首连不该把历史从 SSE 再灌一遍', () => {
  assert.equal(resolveCursor(null, null, NOW), NOW);
});

test('Last-Event-ID 优先于 ?since —— 自动重连带的才是最新的', () => {
  assert.equal(resolveCursor('1788440000', '1788400000', NOW), 1788440000);
});

test('只有 ?since 时用 ?since —— 主动重建连接走这条', () => {
  assert.equal(resolveCursor(null, '1788400000', NOW), 1788400000);
});

test('垃圾值一律当作没给，绝不回退成 0', () => {
  // 回退成 0 会把七天的历史报警全部重播一遍，比丢一条还糟
  for (const junk of ['', '  ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
    assert.equal(resolveCursor(junk, null, NOW), NOW, `Last-Event-ID=${JSON.stringify(junk)}`);
    assert.equal(resolveCursor(null, junk, NOW), NOW, `since=${JSON.stringify(junk)}`);
  }
});

test('Last-Event-ID 是垃圾时退到 ?since，而不是直接跳到此刻', () => {
  assert.equal(resolveCursor('abc', '1788400000', NOW), 1788400000);
});

test('小数截断成整秒', () => {
  assert.equal(resolveCursor('1788440000.9', null, NOW), 1788440000);
});
