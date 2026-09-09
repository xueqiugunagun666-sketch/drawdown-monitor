import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTokenInfo, parseTokenInfo, supportsChain } from './gmgnTokenInfo.ts';
import { SourceError } from '../lib/errors.ts';

test('解析出 symbol 与 holder_count', () => {
  // 实测 MOONALD 的响应形状
  const r = parseTokenInfo(JSON.stringify({
    code: 0, data: { symbol: 'MOONALD', holder_count: 705786, decimals: 18 },
  }));
  assert.equal(r?.symbol, 'MOONALD');
  assert.equal(r?.holderCount, 705786);
});

test('holder_count 为 0 时保留 0，不当成缺失', () => {
  // 新币可能真的还没有持有人；用 || 兜底会把 0 变成 null，判定就错了
  const r = parseTokenInfo(JSON.stringify({ code: 0, data: { symbol: 'NEW', holder_count: 0 } }));
  assert.equal(r?.holderCount, 0);
});

test('缺 holder_count 字段返回 null', () => {
  assert.equal(parseTokenInfo(JSON.stringify({ code: 0, data: { symbol: 'X' } }))?.holderCount, null);
});

test('code 非 0 视为无结果', () => {
  assert.equal(parseTokenInfo(JSON.stringify({ code: 1, msg: 'not found' })), null);
});

test('非 JSON 不抛错', () => {
  assert.equal(parseTokenInfo('<html>502</html>'), null);
  assert.equal(parseTokenInfo(''), null);
});

test('四条 EVM 链都支持', () => {
  for (const c of ['ethereum', 'bsc', 'base', 'robinhood']) {
    assert.ok(supportsChain(c), `${c} 应支持`);
  }
});

test('网络失败显式抛出，不能伪装成查不到代币', async () => {
  await assert.rejects(
    fetchTokenInfo('bsc', '0xabc', {
      apiKey: 'test-key',
      request: async () => { throw new Error('socket timeout'); },
    }),
    (err: unknown) => err instanceof SourceError && err.kind === 'network',
  );
});

test('429 与其它非 200 有明确失败分类', async () => {
  await assert.rejects(
    fetchTokenInfo('bsc', '0xabc', {
      apiKey: 'test-key', request: async () => ({ status: 429, body: '' }),
    }),
    (err: unknown) => err instanceof SourceError && err.kind === 'rate_limited',
  );
  await assert.rejects(
    fetchTokenInfo('bsc', '0xabc', {
      apiKey: 'test-key', request: async () => ({ status: 503, body: '' }),
    }),
    (err: unknown) => err instanceof SourceError && err.kind === 'http_error',
  );
});
