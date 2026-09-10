import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusForPumpHealth, PUMP_HEARTBEAT_TIMEOUT_SECONDS, XXYY_ALERT_HEARTBEAT_TIMEOUT_SECONDS,
} from './pumpHealthStatus.ts';
import type { PumpHealthRow } from '../db/pumpHealthRepo.ts';

function row(over: Partial<PumpHealthRow> = {}): PumpHealthRow {
  return {
    component: 'pump', scope: 'all', lastRunId: 1, lastStartedAt: 100,
    lastCompletedAt: 110, lastValidQuoteAt: 105, requestedCount: 10,
    coveredCount: 10, failedBatchCount: 0, evalErrorCount: 0,
    lastErrorKind: null, lastErrorMessage: null, updatedAt: 110, ...over,
  };
}

test('worker 超过三轮没有完成时即使 SSE 仍开着也判 down', () => {
  const r = row({ lastRunId: 2, lastStartedAt: 200, lastCompletedAt: 110 });
  assert.equal(statusForPumpHealth(r, 200 + PUMP_HEARTBEAT_TIMEOUT_SECONDS + 1, 2).status, 'down');
});

test('完成但有批次或单币错误时是 degraded，不冒充 healthy', () => {
  assert.equal(statusForPumpHealth(row({ failedBatchCount: 1 }), 120, 1).status, 'degraded');
  assert.equal(statusForPumpHealth(row({ evalErrorCount: 1 }), 120, 1).status, 'degraded');
});

test('XXYY 快链路超过 60 秒未完成即判 down', () => {
  const fast = row({
    component: 'xxyy-alert', lastRunId: 3, lastStartedAt: 200, lastCompletedAt: 190,
  });
  assert.equal(
    statusForPumpHealth(fast, 200 + XXYY_ALERT_HEARTBEAT_TIMEOUT_SECONDS + 1, 3).status,
    'down',
  );
});

test('当前轮某链技术失败且有效覆盖为零时判 down', () => {
  const q = row({
    component: 'quote', scope: 'dexscreener:bsc', requestedCount: 1, coveredCount: 0,
    failedBatchCount: 1, lastErrorKind: 'batch-failure', lastCompletedAt: 115,
  });
  assert.equal(statusForPumpHealth(q, 120, 1).status, 'down');
});

test('当前轮未请求的旧链状态是 unknown，不拿旧成功冒充当前健康', () => {
  const q = row({ component: 'quote', scope: 'dexscreener:base', lastRunId: 0 });
  assert.equal(statusForPumpHealth(q, 120, 1).status, 'unknown');
});
