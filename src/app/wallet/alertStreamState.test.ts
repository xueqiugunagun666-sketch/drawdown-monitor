import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertStreamUrl, mergeAlertRows } from './alertStreamState.ts';
import type { AlertRow } from './AlertFeed.tsx';

function row(id: string, seq: number, firedAt = 100): AlertRow {
  return {
    id, seq, firedAt, tokenId: `bsc:0x${id}`, timeframe: '5m', basis: 'open',
    level: 2, multiple: '2', priceUsd: '2', basePriceUsd: '1', valueUsd: null,
    symbol: id, address: `0x${id}`, chain: 'bsc',
  };
}

test('旧历史响应不会覆盖已经先到达的 SSE 报警', () => {
  const live = row('live-101', 101);
  const oldHistory = row('history-100', 100);
  const merged = mergeAlertRows([live], [oldHistory]);
  assert.deepEqual(merged.map((x) => x.seq), [101, 100]);
});

test('同秒多条按 seq 保留并排序，重复 id 只留一条', () => {
  const merged = mergeAlertRows([row('a', 101)], [row('a', 101), row('b', 102)]);
  assert.deepEqual(merged.map((x) => x.id), ['b', 'a']);
});

test('空库快照也明确从 since=0 建立 SSE', () => {
  assert.equal(alertStreamUrl(0), '/api/wallet/stream?since=0');
  assert.equal(alertStreamUrl(101), '/api/wallet/stream?since=101');
});
