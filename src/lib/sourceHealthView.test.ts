import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORICAL_FAILURE_SECONDS, sourceHealthPriority, sourceHealthView,
} from './sourceHealthView.ts';

const NOW = 1_800_000_000;

function row(sourceId: string, failures: number, lastFailAt = NOW - 30) {
  return {
    sourceId, consecutiveFailures: failures, lastOkAt: NOW - 60,
    lastFailAt, lastFailMessage: failures ? 'fetch failed' : null,
  };
}

test('XXYY 报警价单次失败也按关键故障显示', () => {
  const view = sourceHealthView(row('xxyy-alerts:bsc', 1), NOW);
  assert.equal(view.critical, true);
  assert.equal(view.state, 'outage');
  assert.match(view.purpose, /暴涨/);
});

test('非关键源 1-4 次近期失败显示正在重试，不伪装成正常', () => {
  const view = sourceHealthView(row('dexscreener:bsc', 3), NOW);
  assert.equal(view.critical, false);
  assert.equal(view.state, 'retrying');
  assert.match(view.text, /3 次/);
});

test('非关键源近期连续 5 次才升级为服务异常', () => {
  assert.equal(sourceHealthView(row('xxyy-solana-rpc', 5), NOW).state, 'outage');
});

test('一小时前遗留且没有复测的失败明确标成历史故障', () => {
  const view = sourceHealthView(
    row('gmgn', 12, NOW - HISTORICAL_FAILURE_SECONDS), NOW,
  );
  assert.equal(view.state, 'historical');
  assert.match(view.text, /等待下次复测/);
});

test('恢复后的失败次数为零才显示正常', () => {
  assert.equal(sourceHealthView(row('dexscreener:bsc', 0), NOW).state, 'healthy');
});

test('排序把当前报警价格源放在辅助源前面', () => {
  assert.ok(sourceHealthPriority('xxyy-alerts:bsc') < sourceHealthPriority('dexscreener:bsc'));
  assert.ok(sourceHealthPriority('dexscreener:bsc') < sourceHealthPriority('gmgn'));
});
