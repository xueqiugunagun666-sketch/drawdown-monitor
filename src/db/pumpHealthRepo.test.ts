process.env.DATABASE_PATH = ':memory:';

import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import {
  beginPumpRun, beginXxyyAlertRun, clearPumpHealth, completePumpRun,
  completeXxyyAlertRun, pumpHealthRows, recordQuoteHealth,
} from './pumpHealthRepo.ts';
import { registerSecret } from '../lib/mask.ts';

before(() => runMigrations());
beforeEach(() => clearPumpHealth());

test('开始与完成轮次分别持久化，卡住时会留下未完成的新 startedAt', () => {
  beginPumpRun(100, 100, 20);
  let row = pumpHealthRows().find((r) => r.component === 'pump')!;
  assert.equal(row.lastStartedAt, 100);
  assert.equal(row.lastCompletedAt, null);

  completePumpRun({ runId: 100, now: 110, requested: 20, covered: 19, failedBatches: 1, evalErrors: 2 });
  row = pumpHealthRows().find((r) => r.component === 'pump')!;
  assert.equal(row.lastCompletedAt, 110);
  assert.equal(row.coveredCount, 19);
  assert.equal(row.evalErrorCount, 2);

  beginPumpRun(200, 200, 3);
  row = pumpHealthRows().find((r) => r.component === 'pump')!;
  assert.equal(row.lastStartedAt, 200);
  assert.equal(row.lastCompletedAt, 110, '新轮未完成时保留上轮完成时间供超时判断');
});

test('XXYY 快链路有独立心跳与失败计数', () => {
  beginXxyyAlertRun(200, 200, 30);
  completeXxyyAlertRun({
    runId: 200, now: 205, requested: 30, covered: 29,
    failedBatches: 1, evalErrors: 2, errorKind: 'source-failure',
  });
  const row = pumpHealthRows().find((r) => r.component === 'xxyy-alert')!;
  assert.equal(row.lastCompletedAt, 205);
  assert.equal(row.coveredCount, 29);
  assert.equal(row.evalErrorCount, 2);
});

test('每条链独立记录有效覆盖和技术失败，错误内容会掩码', () => {
  registerSecret('secret-value-123456');
  beginPumpRun(100, 100, 10);
  recordQuoteHealth({
    runId: 100, chain: 'bsc', now: 105, requested: 8, covered: 7,
    failedBatches: 1, errorKind: 'batch-failure', errorMessage: 'token=secret-value-123456',
  });
  const row = pumpHealthRows().find((r) => r.scope === 'dexscreener:bsc')!;
  assert.equal(row.coveredCount, 7);
  assert.equal(row.failedBatchCount, 1);
  assert.ok(!row.lastErrorMessage?.includes('secret-value-123456'));
  assert.match(row.lastErrorMessage ?? '', /secr\.\.\.3456/);
});
