import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXxyyPrices, supportsChain, BATCH_SIZE, normalizeMint } from './xxyy.ts';

const ok = (rows: unknown[]) => JSON.stringify({ code: 0, msg: null, data: rows });

test('解析出价格、市值与池子地址', () => {
  const m = parseXxyyPrices(ok([{
    mint: '0x198dba421a7db566a90da5de7901abe3443b4444',
    priceUSD: 0.004501142640253807, marketCap: 4501142.64, dexId: 'pan2',
    pairAddress: '0xabc',
  }]), 'bsc');
  const q = m.get('0x198dba421a7db566a90da5de7901abe3443b4444')!;
  assert.equal(q.priceUsd, '0.004501142640253807');
  assert.equal(q.marketCapUsd, 4501142.64);
  assert.equal(q.pairAddress, '0xabc');
});

test('priceUSD 为 0 当成「没数据」而不是「价格是零」', () => {
  // 实测主流币（USDT / WBNB / USDC）一律回 0，显然不是真的不值钱。
  // 当成价格会算出无穷大的倍数
  const m = parseXxyyPrices(ok([
    { mint: '0xusdt', priceUSD: 0, marketCap: 0 },
    { mint: '0xreal', priceUSD: 1.5, marketCap: 100 },
  ]), 'bsc');
  assert.equal(m.has('0xusdt'), false);
  assert.equal(m.size, 1);
});

test('负数与非数字同样丢弃', () => {
  const m = parseXxyyPrices(ok([
    { mint: '0xa', priceUSD: -1 },
    { mint: '0xb', priceUSD: 'nope' },
    { mint: '0xc', priceUSD: null },
  ]), 'bsc');
  assert.equal(m.size, 0);
});

test('地址统一小写 —— 上游大小写不定，键要能对上', () => {
  const m = parseXxyyPrices(ok([{ mint: '0xABCDEF', priceUSD: 1 }]), 'bsc');
  assert.equal(m.has('0xabcdef'), true);
});

test('Solana mint 保留大小写', () => {
  const mint = 'AbCdEf123xyz';
  const m = parseXxyyPrices(ok([{ mint, priceUSD: '0.125' }]), 'solana');
  assert.equal(m.has(mint), true);
  assert.equal(normalizeMint('solana', mint), mint);
});

test('市值为 0 或缺失时记 null，不拿 0 冒充', () => {
  const m = parseXxyyPrices(ok([
    { mint: '0xa', priceUSD: 1, marketCap: 0 },
    { mint: '0xb', priceUSD: 1 },
  ]), 'bsc');
  assert.equal(m.get('0xa')!.marketCapUsd, null);
  assert.equal(m.get('0xb')!.marketCapUsd, null);
});

test('价格保持字符串 —— 不让它停留在 number 上', () => {
  const m = parseXxyyPrices(ok([{ mint: '0xa', priceUSD: 0.00000000000000000001234 }]), 'bsc');
  assert.equal(typeof m.get('0xa')!.priceUsd, 'string');
});

test('code 非 0 时抛错，不当成空结果', () => {
  // 静默当成"这批没数据"会让所有币看起来同时失去报价
  assert.throws(() => parseXxyyPrices(JSON.stringify({ code: 401, msg: 'unauthorized' }), 'bsc'), /401/);
});

test('data 不是数组时抛错', () => {
  assert.throws(() => parseXxyyPrices(JSON.stringify({ code: 0, data: 'nope' }), 'bsc'), /数组/);
});

test('非 JSON 时抛错并带上原文开头，便于排查', () => {
  assert.throws(() => parseXxyyPrices('<html>502</html>', 'bsc'), /非 JSON/);
});

test('链名映射：robinhood 要写 robin', () => {
  assert.equal(supportsChain('robinhood'), true);
  assert.equal(supportsChain('bsc'), true);
  assert.equal(supportsChain('arbitrum'), false);
});

test('单批规模保守取 500 —— 私有接口不撑到极限', () => {
  assert.equal(BATCH_SIZE, 500);
});
