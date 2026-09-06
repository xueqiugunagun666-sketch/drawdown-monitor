import type { PumpHealthRow } from '../db/pumpHealthRepo.ts';

export type PumpRuntimeStatus = 'unknown' | 'healthy' | 'degraded' | 'down';
export const PUMP_HEARTBEAT_TIMEOUT_SECONDS = 180;

export interface PumpHealthView extends PumpHealthRow {
  status: PumpRuntimeStatus;
  ageSeconds: number | null;
}

export function statusForPumpHealth(
  row: PumpHealthRow, now: number, currentRunId: number | null,
): PumpHealthView {
  const completedAge = row.lastCompletedAt === null ? null : Math.max(0, now - row.lastCompletedAt);
  let status: PumpRuntimeStatus = 'unknown';

  if (row.component === 'pump') {
    const stuck = row.lastStartedAt !== null
      && (row.lastCompletedAt === null || row.lastStartedAt > row.lastCompletedAt)
      && now - row.lastStartedAt > PUMP_HEARTBEAT_TIMEOUT_SECONDS;
    if (stuck || (completedAge !== null && completedAge > PUMP_HEARTBEAT_TIMEOUT_SECONDS)) {
      status = 'down';
    } else if (row.lastCompletedAt !== null) {
      status = row.lastErrorKind || row.failedBatchCount > 0 || row.evalErrorCount > 0
        ? 'degraded' : 'healthy';
    }
  } else if (currentRunId === null || row.lastRunId !== currentRunId) {
    status = 'unknown'; // 当前轮没有请求这条链，旧状态不能冒充当前健康或故障
  } else if (row.requestedCount > 0 && row.coveredCount === 0 && row.lastErrorKind) {
    status = 'down';
  } else if (row.requestedCount > 0 && row.coveredCount === 0) {
    status = 'unknown'; // 本轮只含无池粉尘时不能反推数据源宕机
  } else if (row.failedBatchCount > 0 || row.lastErrorKind) {
    status = 'degraded';
  } else if (row.coveredCount > 0) {
    status = 'healthy';
  }

  return { ...row, status, ageSeconds: completedAge };
}

export function pumpHealthSnapshot(rows: PumpHealthRow[], now: number): PumpHealthView[] {
  const pump = rows.find((r) => r.component === 'pump' && r.scope === 'all');
  const runId = pump?.lastRunId ?? null;
  return rows.map((row) => statusForPumpHealth(row, now, runId));
}
