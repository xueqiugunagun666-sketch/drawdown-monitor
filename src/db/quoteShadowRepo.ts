import { getRawDb } from './index.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';
import type { XxyyQuote } from '../sources/xxyy.ts';
import type { QuoteDecision } from '../worker/quoteDecision.ts';
import { align5m } from '../lib/time.ts';

export const QUOTE_SHADOW_RETENTION_SECONDS = 7 * 86400;

export interface QuoteShadowInput {
  tokenId: string;
  observedAt: number;
  ds: BatchQuote | null;
  xxyy: XxyyQuote | null;
  decision: QuoteDecision;
}

/**
 * 同一个币每 5 分钟只保留最后一次影子观察，既能覆盖 72 小时评估，
 * 又不会因一分钟 tick 把 SQLite 无限制写大。
 */
function writeQuoteShadow(input: QuoteShadowInput): void {
  const quoteIdentity = input.ds?.quoteIdentity
    ? JSON.stringify(input.ds.quoteIdentity) : null;
  getRawDb().prepare(
    `INSERT INTO quote_shadow
       (token_id, bucket_ts, observed_at, ds_price_usd, xxyy_price_usd,
        decision, ratio, round_healthy, current_price_usd, current_source,
        hypothetical_price_usd, hypothetical_source, ds_pair_address, ds_dex_id,
        ds_quote_address, ds_quote_identity, xxyy_pair_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id, bucket_ts) DO UPDATE SET
       observed_at=excluded.observed_at,
       ds_price_usd=excluded.ds_price_usd,
       xxyy_price_usd=excluded.xxyy_price_usd,
       decision=excluded.decision,
       ratio=excluded.ratio,
       round_healthy=excluded.round_healthy,
       current_price_usd=excluded.current_price_usd,
       current_source=excluded.current_source,
       hypothetical_price_usd=excluded.hypothetical_price_usd,
       hypothetical_source=excluded.hypothetical_source,
       ds_pair_address=excluded.ds_pair_address,
       ds_dex_id=excluded.ds_dex_id,
       ds_quote_address=excluded.ds_quote_address,
       ds_quote_identity=excluded.ds_quote_identity,
       xxyy_pair_address=excluded.xxyy_pair_address`,
  ).run(
    input.tokenId, align5m(input.observedAt), input.observedAt,
    input.ds?.priceUsd ?? null, input.xxyy?.priceUsd ?? null,
    input.decision.kind, input.decision.ratio, input.decision.roundHealthy ? 1 : 0,
    input.decision.currentPriceUsd, input.decision.currentSource,
    input.decision.hypotheticalPriceUsd, input.decision.hypotheticalSource,
    input.ds?.pairAddress ?? null, input.ds?.dexId ?? null,
    input.ds?.quoteAddress ?? null, quoteIdentity,
    input.xxyy?.pairAddress ?? null,
  );
}

export function recordQuoteShadow(input: QuoteShadowInput): void {
  writeQuoteShadow(input);
}

/** 一轮共用一个事务，避免几千个 token 各自 fsync 把报警轮次拖慢。 */
export function recordQuoteShadows(inputs: QuoteShadowInput[]): void {
  if (inputs.length === 0) return;
  getRawDb().transaction((rows: QuoteShadowInput[]) => {
    for (const row of rows) writeQuoteShadow(row);
  })(inputs);
}

export function pruneQuoteShadow(now: number): number {
  return getRawDb().prepare(
    `DELETE FROM quote_shadow WHERE observed_at < ?`,
  ).run(now - QUOTE_SHADOW_RETENTION_SECONDS).changes;
}
