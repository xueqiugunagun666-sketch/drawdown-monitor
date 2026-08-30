import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertName, type AlertRow } from './AlertFeed.tsx';

const base: AlertRow = {
  id: 'a', tokenId: 'bsc:0xe9337dde3dd9e97f1f45a56412767ce5098e7777', firedAt: 100,
  timeframe: '24h', basis: 'open', level: 2, multiple: '2.08',
  priceUsd: '1', basePriceUsd: '0.5', valueUsd: '10',
  symbol: null, address: '0xe9337dde3dd9e97f1f45a56412767ce5098e7777', chain: 'bsc',
};

test('有币名就显示币名', () => {
  assert.equal(alertName({ ...base, symbol: '币有' }), '币有');
});

test('没有币名退回缩略地址，而不是显示整串十六进制', () => {
  // 用户听到播报打开页面，看到一串完整合约地址等于没说
  const n = alertName(base);
  assert.equal(n, '0xe933…7777');
  assert.ok(n.length < 20, '要短到能一眼扫过');
});

test('address 缺失时从 tokenId 里取', () => {
  assert.equal(alertName({ ...base, address: null }), '0xe933…7777');
});

test('什么都没有时给出可读的占位，不是空白', () => {
  assert.equal(alertName({ ...base, address: null, tokenId: 'bsc:' }), '未知代币');
});
