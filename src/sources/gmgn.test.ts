import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsChain, MAX_LIMIT } from './gmgn.ts';

test('支持的链与我们的 ChainId 对齐', () => {
  for (const c of ['ethereum', 'base', 'bsc', 'solana', 'robinhood']) {
    assert.equal(supportsChain(c), true, `${c} 应被支持`);
  }
  assert.equal(supportsChain('polygon'), false);
});

test('单次上限与 GeckoTerminal 一致', () => {
  assert.equal(MAX_LIMIT, 1000);
});
