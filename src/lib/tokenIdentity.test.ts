import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedQuoteIdentity,
  makeQuoteIdentity,
  normalizeAddress,
  quoteCacheKey,
  tokenKey,
} from './tokenIdentity.ts';

test('EVM 0x/0X 地址统一小写，Solana mint 保留大小写', () => {
  assert.equal(normalizeAddress('bsc', '0XAbCd'), '0xabcd');
  assert.equal(normalizeAddress('Ethereum', '0xAbCd'), '0xabcd');
  assert.equal(normalizeAddress('solana', 'AbCdEf123'), 'AbCdEf123');
});

test('tokenKey 同时包含规范化链和地址', () => {
  assert.equal(tokenKey('BSC', '0XAbCd'), 'bsc:0xabcd');
  assert.notEqual(tokenKey('ethereum', '0xabc'), tokenKey('bsc', '0xabc'));
  assert.notEqual(tokenKey('solana', 'AbCd'), tokenKey('solana', 'abcd'));
});

test('quoteCacheKey 隔离来源、链和地址', () => {
  const a = quoteCacheKey('DexScreener', 'ethereum', '0XAbCd');
  assert.equal(a, 'dexscreener:ethereum:0xabcd');
  assert.notEqual(a, quoteCacheKey('xxyy', 'ethereum', '0xAbCd'));
  assert.notEqual(a, quoteCacheKey('dexscreener', 'bsc', '0xAbCd'));
  assert.notEqual(a, quoteCacheKey('dexscreener', 'ethereum', '0xAbCe'));
});

test('已登记主流计价币必须同时匹配链、精确地址和 symbol', () => {
  assert.equal(
    isTrustedQuoteIdentity('ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'weth'),
    'trusted',
  );
  assert.equal(
    isTrustedQuoteIdentity('bsc', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'),
    'trusted',
  );
  assert.equal(
    isTrustedQuoteIdentity('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDT'),
    'mismatch',
  );
  assert.equal(
    isTrustedQuoteIdentity('ethereum', '0x0000000000000000000000000000000000000001', 'USDT'),
    'unknown',
  );
});

test('Robinhood 没有确认地址时只返回 unknown，不按符号猜测', () => {
  assert.equal(isTrustedQuoteIdentity('robinhood', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'), 'unknown');
  assert.equal(isTrustedQuoteIdentity('robinhood', '0xabc', 'USDT'), 'unknown');
});

test('quoteIdentity 元数据保留规范化身份和判定，不改变价格', () => {
  assert.deepEqual(
    makeQuoteIdentity('BSC', '0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D', 'USDC'),
    {
      chain: 'bsc',
      address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      symbol: 'USDC',
      trust: 'trusted',
    },
  );
  assert.deepEqual(makeQuoteIdentity('robinhood', null, 'USDT'), {
    chain: 'robinhood', address: null, symbol: 'USDT', trust: 'unknown',
  });
});
