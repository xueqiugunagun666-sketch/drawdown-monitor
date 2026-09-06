import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXxyyPrices,
  supportsChain,
  BATCH_SIZE,
  normalizeMint,
  fetchXxyyPrices,
  fetchXxyyPricesDetailed,
} from './xxyy.ts';

const ok = (rows: unknown[]) => JSON.stringify({ code: 0, msg: null, data: rows });

test('详细 API：后续批次故障不丢此前成功报价，旧 API 仍返回 Map', async () => {
  const addresses = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `0x${i.toString(16)}`);
  const firstAddress = addresses[0]!;
  const failedAddress = addresses[BATCH_SIZE]!;
  const firstBatchBody = ok(addresses.slice(0, BATCH_SIZE).map((mint, i) => ({
    mint, priceUSD: `${i + 1}.25`, marketCap: i + 1, pairAddress: `0xpair${i}`,
  })));
  type StubResponse = { status: number; body: string };
  const scripted = (items: Array<StubResponse | Error>) => async (): Promise<StubResponse> => {
    const next = items.shift();
    if (next === undefined) throw new Error('测试响应已耗尽');
    if (next instanceof Error) throw next;
    return next;
  };

  // 旧函数仍只给成功 Map，且不能因为第二批失败而丢第一批。
  const compatible = await fetchXxyyPrices('bsc', addresses, {
    request: scripted([{ status: 200, body: firstBatchBody }, { status: 503, body: 'busy' }]),
  });
  assert.equal(compatible.size, BATCH_SIZE);
  assert.equal(compatible.get(firstAddress)?.priceUsd, '1.25');

  const cases: Array<{
    label: string;
    failed: StubResponse | Error;
    kind: string;
    reason: RegExp;
    status?: number;
  }> = [
    {
      label: '网络异常', failed: new Error('ECONNRESET'), kind: 'network', reason: /ECONNRESET/,
    },
    {
      label: '坏 JSON', failed: { status: 200, body: '<html>502</html>' },
      kind: 'malformed', reason: /非 JSON/, status: undefined,
    },
    {
      label: '非 200', failed: { status: 502, body: 'bad gateway' },
      kind: 'http_error', reason: /HTTP 502/, status: 502,
    },
    {
      label: '429', failed: { status: 429, body: '' },
      kind: 'rate_limited', reason: /429/, status: 429,
    },
  ];

  for (const c of cases) {
    const result = await fetchXxyyPricesDetailed('bsc', addresses, {
      request: scripted([{ status: 200, body: firstBatchBody }, c.failed]),
    });
    assert.equal(result.quotes.size, BATCH_SIZE, `${c.label} 不能抹掉第一批成功报价`);
    assert.equal(result.quotes.get(firstAddress)?.priceUsd, '1.25');
    assert.equal(result.failures.length, 1);
    assert.deepEqual(result.failures[0]?.addresses, [failedAddress]);
    assert.equal(result.failures[0]?.kind, c.kind);
    assert.match(result.failures[0]?.reason ?? '', c.reason);
    assert.equal(result.failures[0]?.status, c.status);
  }
});

test('解析出价格、市值与池子地址', () => {
  const m = parseXxyyPrices(ok([{
    mint: '0x198dba421a7db566a90da5de7901abe3443b4444',
    priceUSD: 0.004501142640253807, marketCap: 4501142.64, dexId: 'pan2',
    pairAddress: '0XAbC',
  }]), 'bsc', 1_757_000_123);
  const q = m.get('0x198dba421a7db566a90da5de7901abe3443b4444')!;
  assert.equal(q.priceUsd, '0.004501142640253807');
  assert.equal(q.marketCapUsd, 4501142.64);
  assert.equal(q.pairAddress, '0xabc');
  assert.equal(q.chain, 'bsc');
  assert.equal(q.mint, '0x198dba421a7db566a90da5de7901abe3443b4444');
  assert.equal(q.fetchedAt, 1_757_000_123);
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
  const m = parseXxyyPrices(ok([{ mint: '0XABCDEF', priceUSD: 1 }]), 'bsc');
  assert.equal(m.has('0xabcdef'), true);
  assert.equal(m.get('0xabcdef')?.mint, '0xabcdef');
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
