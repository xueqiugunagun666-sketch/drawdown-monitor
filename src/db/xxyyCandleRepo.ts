import { getRawDb } from './index.ts';
import { Decimal } from '../lib/decimal.ts';
import { align5m } from '../lib/time.ts';

export const XXYY_PRICE_REGIME = 'xxyy-live-v1';
// 暴涨最长只看 24h；保留 8 天便于复盘。更长 ATH 只需要按天高点，另表长期存。
export const XXYY_CANDLE_RETENTION_SECONDS = 8 * 86400;
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
    `SELECT high, high_ts FROM wallet_xxyy_daily_highs WHERE token_id = ? AND day = ?`,
  ).get(tokenId, day) as { high: string; high_ts: number | null } | undefined;
  const dayHigh = old ? Decimal.max(new Decimal(old.high), price).toString() : raw;
  const highTs = !old || price.gt(new Decimal(old.high)) ? fetchedAt : (old.high_ts ?? fetchedAt);
  db.prepare(
    `INSERT INTO wallet_xxyy_daily_highs (token_id, day, high, high_ts, price_regime)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token_id, day) DO UPDATE SET
       high = excluded.high, high_ts = excluded.high_ts,
       price_regime = excluded.price_regime`,
  ).run(tokenId, day, dayHigh, highTs, XXYY_PRICE_REGIME);
  db.prepare(
    `INSERT INTO wallet_xxyy_history_meta (token_id, first_observed_at) VALUES (?, ?)
     ON CONFLICT(token_id) DO UPDATE SET
       first_observed_at = MIN(first_observed_at, excluded.first_observed_at)`,
  ).run(tokenId, fetchedAt);
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

/**
 * 迁移前影子运行已经积累的 XXYY 共识观察可直接作为同源历史。
 *
 * 生产有数百万行 quote_shadow，绝不能逐行做多次 SQL；这里用两条集合 SQL
 * 一次完成，并且默认只导入当前 monitored 的去重币。共识行已被 DS 在 10%
 * 内交叉确认，适合做安全起步历史；冲突与 XXYY-only 行不导入。
 */
export function bootstrapXxyyCandlesFromShadow(
  monitoredOnly = true, now = Math.floor(Date.now() / 1000),
): { attempted: number; accepted: number } {
  const db = getRawDb();
  const scope = monitoredOnly
    ? `AND EXISTS (
         SELECT 1 FROM holdings h
          WHERE h.token_id = q.token_id AND h.monitored = 1
       )`
    : '';
  let accepted = 0;
  const since = now - XXYY_CANDLE_RETENTION_SECONDS;
  const firstDay = Math.floor(since / 86400) * 86400;
  for (let dayStart = firstDay; dayStart < now; dayStart += 86400) {
    const sliceStart = Math.max(since, dayStart);
    const sliceEnd = Math.min(now + 1, dayStart + 86400);
    accepted += db.transaction(() => {
      const inserted = db.prepare(
      `INSERT OR IGNORE INTO wallet_xxyy_candles
         (token_id, timeframe, ts, o, h, l, c, market_cap_usd,
          quote_fetched_at, price_regime)
       SELECT q.token_id, '5m', q.bucket_ts,
              q.xxyy_price_usd, q.xxyy_price_usd, q.xxyy_price_usd, q.xxyy_price_usd,
              NULL, q.observed_at, ?
         FROM quote_shadow q
        WHERE q.decision = 'consensus' AND q.xxyy_price_usd IS NOT NULL
          AND q.xxyy_price_usd <> '0'
          AND q.observed_at >= ? AND q.observed_at < ?
          ${scope}`,
      ).run(XXYY_PRICE_REGIME, sliceStart, sliceEnd).changes;
    if (inserted > 0) {
      const rows = db.prepare(
        `SELECT token_id, h, quote_fetched_at FROM wallet_xxyy_candles
         WHERE price_regime = ? AND ts >= ? AND ts < ?`,
      ).all(XXYY_PRICE_REGIME, dayStart, dayStart + 86400) as Array<{
        token_id: string; h: string; quote_fetched_at: number;
      }>;
      const highs = new Map<string, { price: Decimal; ts: number }>();
      for (const row of rows) {
        const price = positiveDecimal(row.h);
        if (!price) continue;
        const old = highs.get(row.token_id);
        if (!old || price.gt(old.price)) highs.set(row.token_id, { price, ts: row.quote_fetched_at });
      }
      const readDay = db.prepare(
        `SELECT high FROM wallet_xxyy_daily_highs WHERE token_id = ? AND day = ?`,
      );
      const insertDay = db.prepare(
        `INSERT INTO wallet_xxyy_daily_highs
           (token_id, day, high, high_ts, price_regime) VALUES (?, ?, ?, ?, ?)`,
      );
      const updateDay = db.prepare(
        `UPDATE wallet_xxyy_daily_highs SET high = ?, high_ts = ?, price_regime = ?
          WHERE token_id = ? AND day = ?`,
      );
      for (const [tokenId, high] of highs) {
        const old = readDay.get(tokenId, dayStart) as { high: string } | undefined;
        const oldPrice = old ? positiveDecimal(old.high) : null;
        if (!old) {
          insertDay.run(tokenId, dayStart, high.price.toString(), high.ts, XXYY_PRICE_REGIME);
        } else if (!oldPrice || high.price.gt(oldPrice)) {
          updateDay.run(high.price.toString(), high.ts, XXYY_PRICE_REGIME, tokenId, dayStart);
        }
      }
    }
    return inserted;
    })();
  }
  db.prepare(
    `INSERT INTO wallet_xxyy_history_meta (token_id, first_observed_at)
     SELECT token_id, MIN(quote_fetched_at) FROM wallet_xxyy_candles GROUP BY token_id
     ON CONFLICT(token_id) DO UPDATE SET
       first_observed_at = MIN(first_observed_at, excluded.first_observed_at)`,
  ).run();
  return { attempted: accepted, accepted };
}

export function pruneXxyyCandles(now: number): number {
  return getRawDb().prepare(
    `DELETE FROM wallet_xxyy_candles WHERE ts < ?`,
  ).run(now - XXYY_CANDLE_RETENTION_SECONDS).changes;
}

/** XXYY 专用序列的最早覆盖时间。 */
export function xxyyHistoryStart(tokenId: string): number | null {
  const row = getRawDb().prepare(
    `SELECT first_observed_at AS t FROM wallet_xxyy_history_meta WHERE token_id = ?`,
  ).get(tokenId) as { t: number | null } | undefined;
  return row?.t ?? null;
}

export interface XxyyHighPoint { price: Decimal; ts: number | null }

function highestRow(rows: Array<{ v: string; t: number | null }>): XxyyHighPoint | null {
  let best: XxyyHighPoint | null = null;
  for (const row of rows) {
    const price = positiveDecimal(row.v);
    if (price && (!best || price.gt(best.price))) best = { price, ts: row.t };
  }
  return best;
}

/** 在写入本轮价格前调用，返回纯 XXYY 历史高点。 */
export function xxyyWindowHighsBefore(
  tokenId: string, windows: Array<{ key: string; seconds: number | null }>,
  now: number,
): Map<string, XxyyHighPoint> {
  const db = getRawDb();
  const out = new Map<string, XxyyHighPoint>();
  for (const window of windows) {
    const since = window.seconds === null ? null : now - window.seconds;
    let rows: Array<{ v: string; t: number | null }>;
    if (since === null) {
      rows = db.prepare(
        `SELECT high AS v, high_ts AS t FROM wallet_xxyy_daily_highs
         WHERE token_id = ?`,
      ).all(tokenId) as Array<{ v: string; t: number | null }>;
    } else if (window.seconds! <= XXYY_CANDLE_RETENTION_SECONDS) {
      rows = db.prepare(
        `SELECT h AS v, ts AS t FROM wallet_xxyy_candles
         WHERE token_id = ? AND timeframe = '5m' AND ts >= ?`,
      ).all(tokenId, since) as Array<{ v: string; t: number | null }>;
    } else {
      // 边界日没有分钟级历史时整日排除，宁可少报一档，也不把窗口外高点算进来。
      const boundaryDay = Math.floor(since / 86400) * 86400;
      rows = db.prepare(
        `SELECT high AS v, high_ts AS t FROM wallet_xxyy_daily_highs
         WHERE token_id = ? AND day > ?`,
      ).all(tokenId, boundaryDay) as Array<{ v: string; t: number | null }>;
    }
    const best = highestRow(rows);
    if (best) out.set(window.key, best);
  }
  return out;
}
