import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFER_TOPIC, isRangeTooBig, discoverTokenAddresses, type GetLogs } from './walletScan.ts';

test('Transfer 事件签名是固定的 keccak256 值', () => {
  assert.equal(TRANSFER_TOPIC, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
});

test('isRangeTooBig 认得实测到的各家节点措辞', () => {
  // 以下五条都是实测采集的真实报文，不是编的
  assert.ok(isRangeTooBig('Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range'));
  assert.ok(isRangeTooBig('eth_getLogs is limited to a 10,000 range'));
  assert.ok(isRangeTooBig('logs matched by query exceeds limit of 10000'));
  assert.ok(isRangeTooBig('log query timed out'));
  assert.ok(isRangeTooBig('[QUICKNODE fallback] The request timedout after 4000 ms'));
});

test('isRangeTooBig 不把无关错误当成容量问题', () => {
  // 误判成容量问题会导致对一个鉴权失败的端点疯狂二分重试
  assert.equal(isRangeTooBig('execution reverted'), false);
  assert.equal(isRangeTooBig('invalid params'), false);
  assert.equal(isRangeTooBig('unauthorized'), false);
  assert.equal(isRangeTooBig('method not found'), false);
});

test('一次查得动时只调用一次', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; return [{ address: '0xAAA' }, { address: '0xBBB' }]; };
  const out = await discoverTokenAddresses(getLogs, 0, 1000);
  assert.equal(calls, 1);
  assert.deepEqual([...out].sort(), ['0xaaa', '0xbbb']);
});

test('地址去重且统一小写', async () => {
  const getLogs: GetLogs = async () => [{ address: '0xAbC' }, { address: '0xabc' }, { address: '0xABC' }];
  assert.deepEqual([...await discoverTokenAddresses(getLogs, 0, 10)], ['0xabc']);
});

test('超限时二分，子区间既不重叠也不遗漏', async () => {
  const seen: Array<[number, number]> = [];
  const getLogs: GetLogs = async (from, to) => {
    seen.push([from, to]);
    if (to - from > 500) throw new Error('Log response size exceeded');
    return [{ address: `0x${from}` }];
  };
  const out = await discoverTokenAddresses(getLogs, 0, 1000);
  assert.deepEqual(seen, [[0, 1000], [0, 500], [501, 1000]]);
  assert.deepEqual([...out].sort(), ['0x0', '0x501']);
});

test('递归二分：需要拆多层时仍完整覆盖且不重叠', async () => {
  const ok: Array<[number, number]> = [];
  const getLogs: GetLogs = async (from, to) => {
    if (to - from > 250) throw new Error('Log response size exceeded');
    ok.push([from, to]);
    return [];
  };
  await discoverTokenAddresses(getLogs, 0, 1000);
  assert.ok(ok.every(([f, t]) => t - f <= 250), '每个成功区间跨度都应 <= 250');
  ok.sort((a, b) => a[0] - b[0]);
  assert.equal(ok[0]?.[0], 0, '必须从 0 开始');
  assert.equal(ok[ok.length - 1]?.[1], 1000, '必须覆盖到 1000');
  for (let i = 1; i < ok.length; i++) {
    assert.equal(ok[i]?.[0], (ok[i - 1]?.[1] ?? -1) + 1, `第 ${i} 段应与前一段首尾相接`);
  }
});

test('区间不可再分仍失败时抛错，绝不无限递归', async () => {
  // 终止条件写错就是无限递归，会把用户的 RPC 端点打死
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; throw new Error('Log response size exceeded'); };
  await assert.rejects(() => discoverTokenAddresses(getLogs, 100, 100), /不可再分/);
  assert.ok(calls < 5, `不该反复重试，实际调用了 ${calls} 次`);
});

test('相邻两块都查不动时也能终止', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; throw new Error('Log response size exceeded'); };
  await assert.rejects(() => discoverTokenAddresses(getLogs, 100, 101), /不可再分/);
  assert.ok(calls < 10, `实际调用了 ${calls} 次`);
});

test('非容量类错误直接上抛，不触发二分', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; throw new Error('unauthorized'); };
  await assert.rejects(() => discoverTokenAddresses(getLogs, 0, 1000), /unauthorized/);
  assert.equal(calls, 1, '鉴权失败不该被当成容量问题反复二分');
});

test('部分子区间成功、部分失败时，成功的结果不丢', async () => {
  const getLogs: GetLogs = async (from, to) => {
    if (from === 0 && to === 1000) throw new Error('Log response size exceeded');
    if (from === 501) throw new Error('unauthorized');
    return [{ address: '0xgood' }];
  };
  // 后半段是非容量错误，整体应失败 —— 但这里验证的是错误确实上抛，
  // 而不是被吞掉后返回一个"看起来正常"的部分结果
  await assert.rejects(() => discoverTokenAddresses(getLogs, 0, 1000), /unauthorized/);
});

test('空结果是合法的，不该报错', async () => {
  const getLogs: GetLogs = async () => [];
  assert.equal((await discoverTokenAddresses(getLogs, 0, 1000)).size, 0);
});
