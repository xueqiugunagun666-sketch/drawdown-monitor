import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainIdOf, supportedChains, parseRpcResponse, parseBatchResponse } from './evmRpc.ts';

test('链名映射到 chain id', () => {
  assert.equal(chainIdOf('ethereum'), 1);
  assert.equal(chainIdOf('bsc'), 56);
  assert.equal(chainIdOf('base'), 8453);
  assert.equal(chainIdOf('robinhood'), 4663);
});

test('solana 返回 null 而不是抛错 —— 本期不做，调用方要能优雅跳过', () => {
  assert.equal(chainIdOf('solana'), null);
  assert.equal(chainIdOf('随便什么'), null);
});

test('supportedChains 不含 solana', () => {
  assert.ok(!supportedChains().includes('solana'));
  assert.equal(supportedChains().length, 4);
});

test('单条响应：正常返回 result', () => {
  assert.equal(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":"0x1237"}'), '0x1237');
});

test('单条响应：错误必须抛出且带上节点原文', () => {
  assert.throws(
    () => parseRpcResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Log response size exceeded"}}'),
    /Log response size exceeded/,
  );
});

test('单条响应：既无 result 也无 error 要抛错，不能返回 undefined', () => {
  assert.throws(() => parseRpcResponse('{"jsonrpc":"2.0","id":1}'), /既无 result 也无 error/);
});

test('result 为 null 是合法的（区块不存在等），不该当成缺失', () => {
  assert.equal(parseRpcResponse<null>('{"jsonrpc":"2.0","id":1,"result":null}'), null);
});

test('非 JSON 响应（网关 502/504）要给出可读错误', () => {
  // 实测：网关过载时返回的是纯文本，直接 JSON.parse 会抛难读的 SyntaxError
  assert.throws(() => parseRpcResponse('error code: 504'), /非 JSON 响应/);
  assert.throws(() => parseRpcResponse('<html>502 Bad Gateway</html>'), /非 JSON 响应/);
});

test('批量响应按 id 归位，不依赖返回顺序', () => {
  const body = '[{"id":2,"result":"0xb"},{"id":1,"result":"0xa"}]';
  assert.deepEqual(parseBatchResponse(body, [1, 2]), [
    { id: 1, result: '0xa', error: null },
    { id: 2, result: '0xb', error: null },
  ]);
});

test('批量响应里单条出错不影响其它条', () => {
  const body = '[{"id":1,"result":"0xa"},{"id":2,"error":{"code":-32000,"message":"execution reverted"}}]';
  const out = parseBatchResponse(body, [1, 2]);
  assert.equal(out[0]?.result, '0xa');
  assert.equal(out[0]?.error, null);
  assert.equal(out[1]?.result, null);
  assert.match(out[1]?.error ?? '', /execution reverted/);
});

test('批量响应缺 id 时该条标记缺失，不静默补零', () => {
  const out = parseBatchResponse('[{"id":1,"result":"0xa"}]', [1, 2]);
  assert.equal(out[1]?.result, null);
  assert.match(out[1]?.error ?? '', /缺少/);
});

test('批量请求返回非数组要抛错', () => {
  assert.throws(() => parseBatchResponse('{"id":1,"result":"0xa"}', [1]), /未返回数组/);
});
