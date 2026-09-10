import { getRawDb } from './index.ts';
import { scrubSecrets } from '../lib/mask.ts';

export interface PumpHealthRow {
  component: 'pump' | 'quote' | 'xxyy-alert';
  scope: string;
  lastRunId: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastValidQuoteAt: number | null;
  requestedCount: number;
  coveredCount: number;
  failedBatchCount: number;
  evalErrorCount: number;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  updatedAt: number;
}

interface RawRow {
  component: 'pump' | 'quote' | 'xxyy-alert'; scope: string; last_run_id: number | null;
  last_started_at: number | null; last_completed_at: number | null;
  last_valid_quote_at: number | null; requested_count: number; covered_count: number;
  failed_batch_count: number; eval_error_count: number; last_error_kind: string | null;
  last_error_message: string | null; updated_at: number;
}

function mapRow(r: RawRow): PumpHealthRow {
  return {
    component: r.component, scope: r.scope, lastRunId: r.last_run_id,
    lastStartedAt: r.last_started_at, lastCompletedAt: r.last_completed_at,
    lastValidQuoteAt: r.last_valid_quote_at, requestedCount: r.requested_count,
    coveredCount: r.covered_count, failedBatchCount: r.failed_batch_count,
    evalErrorCount: r.eval_error_count, lastErrorKind: r.last_error_kind,
    lastErrorMessage: r.last_error_message, updatedAt: r.updated_at,
  };
}

export function beginPumpRun(runId: number, now: number, requested: number): void {
  getRawDb().prepare(
    `INSERT INTO pump_health
       (component, scope, last_run_id, last_started_at, requested_count, updated_at)
     VALUES ('pump', 'all', ?, ?, ?, ?)
     ON CONFLICT(component, scope) DO UPDATE SET
       last_run_id=excluded.last_run_id,
       last_started_at=excluded.last_started_at,
       requested_count=excluded.requested_count,
       covered_count=0,
       failed_batch_count=0,
       eval_error_count=0,
       last_error_kind=NULL,
       last_error_message=NULL,
       updated_at=excluded.updated_at`,
  ).run(runId, now, requested, now);
}

export interface QuoteHealthInput {
  runId: number;
  chain: string;
  now: number;
  requested: number;
  covered: number;
  failedBatches: number;
  errorKind?: string | null;
  errorMessage?: string | null;
}

export function recordQuoteHealth(input: QuoteHealthInput): void {
  const scope = `dexscreener:${input.chain}`;
  const message = input.errorMessage ? scrubSecrets(input.errorMessage).slice(0, 240) : null;
  getRawDb().prepare(
    `INSERT INTO pump_health
       (component, scope, last_run_id, last_started_at, last_completed_at,
        last_valid_quote_at, requested_count, covered_count, failed_batch_count,
        eval_error_count, last_error_kind, last_error_message, updated_at)
     VALUES ('quote', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(component, scope) DO UPDATE SET
       last_run_id=excluded.last_run_id,
       last_started_at=excluded.last_started_at,
       last_completed_at=excluded.last_completed_at,
       last_valid_quote_at=COALESCE(excluded.last_valid_quote_at, last_valid_quote_at),
       requested_count=excluded.requested_count,
       covered_count=excluded.covered_count,
       failed_batch_count=excluded.failed_batch_count,
       last_error_kind=excluded.last_error_kind,
       last_error_message=excluded.last_error_message,
       updated_at=excluded.updated_at`,
  ).run(
    scope, input.runId, input.now, input.now, input.covered > 0 ? input.now : null,
    input.requested, input.covered, input.failedBatches,
    input.errorKind ?? null, message, input.now,
  );
}

export interface CompletePumpInput {
  runId: number;
  now: number;
  requested: number;
  covered: number;
  failedBatches: number;
  evalErrors: number;
  errorKind?: string | null;
  errorMessage?: string | null;
}

export function completePumpRun(input: CompletePumpInput): void {
  const message = input.errorMessage ? scrubSecrets(input.errorMessage).slice(0, 240) : null;
  getRawDb().prepare(
    `UPDATE pump_health SET
       last_completed_at=?, covered_count=?, failed_batch_count=?, eval_error_count=?,
       last_valid_quote_at=CASE WHEN ? > 0 THEN ? ELSE last_valid_quote_at END,
       last_error_kind=?, last_error_message=?, updated_at=?
     WHERE component='pump' AND scope='all' AND last_run_id=?`,
  ).run(
    input.now, input.covered, input.failedBatches, input.evalErrors,
    input.covered, input.now, input.errorKind ?? null, message, input.now, input.runId,
  );
}

export function beginXxyyAlertRun(runId: number, now: number, requested: number): void {
  getRawDb().prepare(
    `INSERT INTO pump_health
       (component, scope, last_run_id, last_started_at, requested_count, updated_at)
     VALUES ('xxyy-alert', 'all', ?, ?, ?, ?)
     ON CONFLICT(component, scope) DO UPDATE SET
       last_run_id=excluded.last_run_id,
       last_started_at=excluded.last_started_at,
       requested_count=excluded.requested_count,
       covered_count=0,
       failed_batch_count=0,
       eval_error_count=0,
       last_error_kind=NULL,
       last_error_message=NULL,
       updated_at=excluded.updated_at`,
  ).run(runId, now, requested, now);
}

export function completeXxyyAlertRun(input: CompletePumpInput): void {
  const message = input.errorMessage ? scrubSecrets(input.errorMessage).slice(0, 240) : null;
  getRawDb().prepare(
    `UPDATE pump_health SET
       last_completed_at=?, covered_count=?, failed_batch_count=?, eval_error_count=?,
       last_valid_quote_at=CASE WHEN ? > 0 THEN ? ELSE last_valid_quote_at END,
       last_error_kind=?, last_error_message=?, updated_at=?
     WHERE component='xxyy-alert' AND scope='all' AND last_run_id=?`,
  ).run(
    input.now, input.covered, input.failedBatches, input.evalErrors,
    input.covered, input.now, input.errorKind ?? null, message, input.now, input.runId,
  );
}

export function pumpHealthRows(): PumpHealthRow[] {
  return (getRawDb().prepare(
    `SELECT * FROM pump_health ORDER BY component, scope`,
  ).all() as RawRow[]).map(mapRow);
}

export function clearPumpHealth(): void {
  getRawDb().prepare(`DELETE FROM pump_health`).run();
}
