/**
 * 长历史的按天高点。见 schema.ts 的 athDaily 说明。
 */
import { sql } from 'drizzle-orm';
import { getDb, getRawDb } from './index.ts';
import { Decimal } from '../lib/decimal.ts';

export const DAY = 86400;

/** 把任意时刻归到它所属的自然日（UTC） */
export function toDay(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

/**
 * 整批替换一个币的按天高点。
 *
 * 用替换而不是增量合并：回填拿到的是完整序列，而旧行可能是按错误口径
 * （比如取收盘价那一版）算出来的 —— 留着会让窗口高点一直偏低。
 */
export function replaceDailyHighs(
  tokenId: string, rows: Array<{ day: number; high: string }>,
): void {
  const db = getRawDb();
  const tx = db.transaction((list: typeof rows) => {
    db.prepare(`DELETE FROM ath_daily WHERE token_id = ?`).run(tokenId);
    const st = db.prepare(
      `INSERT OR REPLACE INTO ath_daily (token_id, day, high) VALUES (?, ?, ?)`);
    for (const r of list) st.run(tokenId, r.day, r.high);
  });
  tx(rows);
}

/**
 * 5 分钟数据参与混合的最大回溯。
 *
 * 长窗口（90 天以上）的高点主要由 ath_daily 提供；再往回扫 5m 表意义不大，
 * 却要多读十万行。限定 30 天，既保住"最近创的新高立刻计入任何窗口"这件事
 * （它落在 30 天内），又把每次重算的行数压到可接受。
 */
const CANDLE_BLEND_SECONDS = 30 * DAY;

/**
 * 取一条 SQL 的最高价，**返回原始字符串**。
 *
 * 排序用 CAST(... AS REAL) 只是为了让数据库挑出那一行 —— 双精度在这个
 * 量级上排序是可靠的；但**返回的是原始文本**，价格全程不经过 JS number
 * （decimal.js 铁律）。
 */
function topPrice(stmt: { get(...a: unknown[]): unknown }, ...args: unknown[]): Decimal | null {
  const r = stmt.get(...args) as { v: string | null } | undefined;
  if (!r?.v) return null;
  try {
    const d = new Decimal(r.v);
    return d.gt(0) ? d : null;
  } catch {
    return null;
  }
}

/**
 * 一个币在各个窗口里的历史高点。
 *
 * **两个来源取大**：ath_daily 是回填的长历史（按天，可能几天前才刷新），
 * candles 是我们自己每轮攒的 5 分钟数据（新鲜）。短窗口靠后者才准 ——
 * 一个"3 天高点"如果来自一周前刷新的快照，说的根本是另一段时间。
 */
export function windowHighs(
  tokenId: string, windows: Array<{ key: string; seconds: number | null }>, now: number,
): Map<string, Decimal> {
  const db = getRawDb();
  const out = new Map<string, Decimal>();

  const daily = db.prepare(
    `SELECT high AS v FROM ath_daily WHERE token_id = ? AND day >= ?
     ORDER BY CAST(high AS REAL) DESC LIMIT 1`);
  const dailyAll = db.prepare(
    `SELECT high AS v FROM ath_daily WHERE token_id = ?
     ORDER BY CAST(high AS REAL) DESC LIMIT 1`);
  const candle = db.prepare(
    `SELECT h AS v FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ? AND h IS NOT NULL
     ORDER BY CAST(h AS REAL) DESC LIMIT 1`);

  for (const w of windows) {
    const a = w.seconds === null
      ? topPrice(dailyAll, tokenId)
      : topPrice(daily, tokenId, toDay(now - w.seconds));

    const candleSince = w.seconds === null
      ? now - CANDLE_BLEND_SECONDS
      : Math.max(now - w.seconds, now - CANDLE_BLEND_SECONDS);
    const b = topPrice(candle, tokenId, candleSince);

    const best = a && b ? (a.gt(b) ? a : b) : (a ?? b);
    if (best) out.set(w.key, best);
  }
  return out;
}

/** 我们对这个币最早的数据在什么时候 —— 决定哪些窗口是可信的 */
export function historyStart(tokenId: string): number | null {
  const r = getRawDb().prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT MIN(day) AS t FROM ath_daily WHERE token_id = ?
       UNION ALL
       SELECT MIN(ts) AS t FROM candles WHERE token_id = ? AND timeframe = '5m'
     ) WHERE t IS NOT NULL`,
  ).get(tokenId, tokenId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/** 清空一个币的长历史（口径不符时用） */
export function clearDailyHighs(tokenId: string): void {
  getDb().run(sql`DELETE FROM ath_daily WHERE token_id = ${tokenId}`);
}
