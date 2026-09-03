import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xxyyUrl, dexscreenerUrl, XXYY_CHAIN, normalizeChain } from './chainLinks.ts';

const CA = '0x3450598e419abb5609f60e4b2fda127ff0897777';

test('XXYY 的链名是逐条验过的，不能想当然', () => {
  // 这几个都在浏览器里真的打开看过：SPA 所有路径都回 200，
  // 光看状态码分不出对错
  assert.equal(XXYY_CHAIN.robinhood, 'robin');
  assert.equal(XXYY_CHAIN.ethereum, 'eth', '写 ethereum 会被踢回 /discover');
  assert.equal(XXYY_CHAIN.solana, 'sol');
});

test('拼出来的 XXYY 地址', () => {
  assert.equal(xxyyUrl('robinhood', CA), `https://pro.xxyy.io/robin/${CA}`);
  assert.equal(xxyyUrl('bsc', CA), `https://pro.xxyy.io/bsc/${CA}`);
});

test('必须是 pro 子域 —— www 上 robinhood 进不去', () => {
  assert.match(xxyyUrl('robinhood', CA) ?? '', /^https:\/\/pro\.xxyy\.io\//);
});

test('拼出来的 DexScreener 地址', () => {
  assert.equal(dexscreenerUrl('base', CA), `https://dexscreener.com/base/${CA}`);
});

test('不认识的链不给按钮 —— 拼一个进不去的地址还不如没有', () => {
  assert.equal(xxyyUrl('arbitrum', CA), null);
  assert.equal(dexscreenerUrl('arbitrum', CA), null);
  assert.equal(xxyyUrl('bsc', ''), null);
});

test('上游的链名要归一 —— 不归一按钮会静默消失', () => {
  // 群聊淘金那个接口回的是 sol，我们内部叫 solana。
  // "没有按钮"和"这个币没绑社交"长得一模一样，不会有人发现
  assert.equal(normalizeChain('sol'), 'solana');
  assert.equal(normalizeChain('eth'), 'ethereum');
  assert.equal(normalizeChain('ROBIN'), 'robinhood');
  assert.equal(xxyyUrl('sol', 'ABC'), 'https://pro.xxyy.io/sol/ABC');
  assert.equal(dexscreenerUrl('sol', 'ABC'), 'https://dexscreener.com/solana/ABC');
});

test('已经是内部名字的原样通过', () => {
  assert.equal(normalizeChain('robinhood'), 'robinhood');
  assert.equal(normalizeChain('bsc'), 'bsc');
});
