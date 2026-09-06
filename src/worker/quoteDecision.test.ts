import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';
import type { XxyyQuote } from '../sources/xxyy.ts';
import { decideQuote } from './quoteDecision.ts';

const ds = (priceUsd: string): BatchQuote => ({
  priceUsd, priceSource: 'dexscreener', liquidityUsd: 1, volume24hUsd: 1,
  volume1hUsd: 1, marketCapUsd: null, symbol: null, priceNative: null,
  quoteSymbol: null, quoteAddress: null, priceCorrected: false,
  pairCreatedAt: null, imageUrl: null, websiteUrl: null, twitterUrl: null,
  telegramUrl: null,
});
const xx = (priceUsd: string): XxyyQuote => ({
  priceUsd, marketCapUsd: null, pairAddress: null,
});

test('一致且整轮健康时，当前与影子规则都取较低价', () => {
  const r = decideQuote(ds('1.05'), xx('1'), true);
  assert.equal(r.kind, 'consensus');
  assert.equal(r.currentPriceUsd, '1');
  assert.equal(r.currentSource, 'xxyy');
  assert.equal(r.hypotheticalPriceUsd, '1');
});

test('一致但整轮不健康时，当前回退 DS，影子保留逐币共识', () => {
  const r = decideQuote(ds('1.05'), xx('1'), false);
  assert.equal(r.kind, 'consensus');
  assert.equal(r.currentPriceUsd, '1.05');
  assert.equal(r.currentSource, 'dexscreener');
  assert.equal(r.hypotheticalPriceUsd, '1');
});

test('冲突时当前行为仍用 DS，影子规则暂停', () => {
  const r = decideQuote(ds('100'), xx('1'), true);
  assert.equal(r.kind, 'conflict');
  assert.equal(r.currentPriceUsd, '100');
  assert.equal(r.hypotheticalPriceUsd, null);
  assert.equal(r.ratio, '100');
});

test('只有 DS 可继续，只有候选源不可脱离元数据独立使用', () => {
  assert.equal(decideQuote(ds('2'), null, true).hypotheticalPriceUsd, '2');
  const xxyyOnly = decideQuote(null, xx('2'), true);
  assert.equal(xxyyOnly.kind, 'xxyy-only');
  assert.equal(xxyyOnly.currentPriceUsd, null);
  assert.equal(xxyyOnly.hypotheticalPriceUsd, null);
});

test('非有限或非正价格按不可用处理', () => {
  assert.equal(decideQuote(ds('Infinity'), xx('0'), true).kind, 'unavailable');
});
