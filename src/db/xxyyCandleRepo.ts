import { getRawDb } from './index.ts';
import { Decimal } from '../lib/decimal.ts';
import { align5m } from '../lib/time.ts';

export const XXYY_PRICE_REGIME = 'xxyy-live-v1';
export const XXYY_CANDLE_RETENTION_SECONDS = 31 * 86400;
export const EXTREME_JUMP_RATIO = new Decimal('1000');
export const EXTREME_CONFIRM_TOLERANCE = new Decimal('1.10');

export type XxyyCandleWriteResult =
  | { status: 'accepted'; reason: null }
  | { status: 'pending-confirmation'; reason: string }
  | { status: 'rejected'; reason: string };

function positiveDecimal(raw: string): Decimal | null {
  try {
    const value = new Decimal(raw);
    return value.isFinite() && value.gt(0) ? value : null;
  } catch {
    return null;
  }
}

function marketCapText(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return new Decimal(String(value)).toString();
}

function writeAccepted(
  tokenId: string, price: Decimal, marketCapUsd: string | null, fetchedAt: number,
): void {
  const db = getRawDb();
  const ts = align5m(fetchedAt);
  const raw = price.toString();
  const existing = db.prepare(
    `SELECT h, l FROM wallet_xxyy_candles
     WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
  ).get(tokenId, ts) as { h: string; l: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO wallet_xxyy_candles
         (token_id, timeframe, ts, o, h, l, c, market_cap_usd,
          quote_fetched_at, price_regime)
       VALUES (?, '5m', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(tokenId, ts, raw, raw, raw, raw, marketCapUsd, fetchedAt, XXYY_PRICE_REGIME);
  } else {
    const high = Decimal.max(new Decimal(existing.h), price).toString();
    const low = Decimal.min(new Decimal(existing.l), price).toString();
    db.prepare(
      `UPDATE wallet_xxyy_candles
          SET h = ?, l = ?, c = ?, market_cap_usd = COALESCE(?, market_cap_usd),
              quote_fetched_at = ?, price_regime = ?
        WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
    ).run(high, low, raw, marketCapUsd, fetchedAt, XXYY_PRICE_REGIME, tokenId, ts);
  }

  const day = Math.floor(fetchedAt / 86400) * 86400;
  const old = db.prepare(
    `SELECT high FROM wallet_xxyy_daily_highs WHERE token_id = ? AND day = ?`,
  ).get(tokenId, day) as { high: string } | undefined;
  const dayHigh = old ? Decimal.max(new Decimal(old.high), price).toString() : raw;
  db.prepare(
    `INSERT INTO wallet_xxyy_daily_highs (token_id, day, high, price_regime)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token_id, day) DO UPDATE SET
       high = excluded.high, price_regime = excluded.price_regime`,
  ).run(tokenId, day, dayHigh, XXYY_PRICE_REGIME);
  db.prepare(`DELETE FROM wallet_xxyy_pending_quotes WHERE token_id = ?`).run(tokenId);
}

/**
 * 写入 XXYY 5m candle。普通涨跌立即接受；超过 1000x 的极端跳变只要求
 * 下一次 XXYY 报价在 10% 内复核，避免坏点污染，也不会把真实暴涨永久锁死。
 */
export function upsertXxyyCandle(
  tokenId: string, priceUsd: string, marketCapUsd: number | null, fetchedAt: number,
): XxyyCandleWriteResult {
  const price = positiveDecimal(priceUsd);
  if (!price) return { status: 'rejected', reason: 'XXYY 价格不是有限正数' };
  const db = getRawDb();
  const previous = db.prepare(
    `SELECT c FROM wallet_xxyy_candles
     WHERE token_id = ? AND timeframe = '5m' ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId) as { c: string } | undefined;

  if (previous) {
    const accepted = positiveDecimal(previous.c);
    if (accepted) {
      const ratio = Decimal.max(accepted.div(price), price.div(accepted));
      if (ratio.gt(EXTREME_JUMP_RATIO)) {
        const pending = db.prepare(
          `SELECT price_usd FROM wallet_xxyy_pending_quotes WHERE token_id = ?`,
        ).get(tokenId) as { price_usd: string } | undefined;
        const pendingPrice = pending ? positiveDecimal(pending.price_usd) : null;
        const confirmed = pendingPrice
          ? Decimal.max(pendingPrice.div(price), price.div(pendingPrice)).lte(EXTREME_CONFIRM_TOLERANCE)
          : false;
        if (!confirmed) {
          db.prepare(
            `INSERT INTO wallet_xxyy_pending_quotes
               (token_id, price_usd, market_cap_usd, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(token_id) DO UPDATE SET
               price_usd = excluded.price_usd,
               market_cap_usd = excluded.market_cap_usd,
               last_seen_at = excluded.last_seen_at`,
          ).run(tokenId, price.toString(), marketCapText(marketCapUsd), fetchedAt, fetchedAt);
          return {
            status: 'pending-confirmation',
            reason: `XXYY 极端跳变 ${ratio.toSignificantDigits(8).toString()}x，等待下一次报价确认`,
          };
        }
      }
    }
  }

  writeAccepted(tokenId, price, marketCapText(marketCapUsd), fetchedAt);
  return { status: 'accepted', reason: null };
}

export function loadXxyy5mCandles(tokenId: string, sinceTs: number) {
  return getRawDb().prepare(
    `SELECT ts, o, l FROM wallet_xxyy_candles
     WHERE token_id = ? AND timeframe = '5m' AND ts >= ? ORDER BY ts`,
  ).all(tokenId, sinceTs) as Array<{ ts: number; o: string; l: string }>;
}

/** 迁移前影子运行已经积累的 XXYY 观察可直接作为同源历史，不复制 DS 数据。 */
export function bootstrapXxyyCandlesFromShadow(): { attempted: number; accepted: number } {
  const rows = getRawDb().prepare(
    `SELECT token_id, observed_at, xxyy_price_usd
       FROM quote_shadow
      WHERE xxyy_price_usd IS NOT NULL
      ORDER BY observed_at, token_id`,
  ).all() as Array<{ token_id: string; observed_at: number; xxyy_price_usd: string }>;
  let accepted = 0;
  for (const row of rows) {
    if (upsertXxyyCandle(row.token_id, row.xxyy_price_usd, null, row.observed_at).status === 'accepted') {
      accepted++;
    }
  }
  return { attempted: rows.length, accepted };
}

export function pruneXxyyCandles(now: number): number {
  return getRawDb().prepare(
    `DELETE FROM wallet_xxyy_candles WHERE ts < ?`,
  ).run(now - XXYY_CANDLE_RETENTION_SECONDS).changes;
}

/** XXYY 专用序列的最早覆盖时间。 */
export function xxyyHistoryStart(tokenId: string): number | null {
  const row = getRawDb().prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT MIN(day) AS t FROM wallet_xxyy_daily_highs WHERE token_id = ?
       UNION ALL
       SELECT MIN(ts) AS t FROM wallet_xxyy_candles WHERE token_id = ? AND timeframe = '5m'
     ) WHERE t IS NOT NULL`,
  ).get(tokenId, tokenId) as { t: number | null } | undefined;
  return row?.t ?? null;
}

/** 在写入本轮价格前调用，返回纯 XXYY 历史高点。 */
export function xxyyWindowHighsBefore(
  tokenId: string, windows: Array<{ key: string; seconds: number | null }>,
  now: number,
): Map<string, Decimal> {
  const db = getRawDb();
  const out = new Map<string, Decimal>();
  for (const window of windows) {
    const since = window.seconds === null ? null : now - window.seconds;
    const row = since === null
      ? db.prepare(
        `SELECT high AS v FROM wallet_xxyy_daily_highs WHERE token_id = ?
         ORDER BY CAST(high AS REAL) DESC LIMIT 1`,
      ).get(tokenId)
      : db.prepare(
        `SELECT high AS v FROM wallet_xxyy_daily_highs
         WHERE token_id = ? AND day >= ?
         ORDER BY CAST(high AS REAL) DESC LIMIT 1`,
      ).get(tokenId, Math.floor(since / 86400) * 86400);
    const value = (row as { v?: string } | undefined)?.v;
    const parsed = value ? positiveDecimal(value) : null;
    if (parsed) out.set(window.key, parsed);
  }
  return out;
}
