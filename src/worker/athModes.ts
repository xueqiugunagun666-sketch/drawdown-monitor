/**
 * 三种 ATH 模式的窗口切片 —— 规格 §2.1。
 *
 * | 模式          | 序列 | 窗口                  |
 * |---------------|------|-----------------------|
 * | rolling_90d   | 5m   | [now-90d, now]        |
 * | since_added   | 5m   | [token.added_at, now] |
 * | all_time      | 1h   | 全部                  |
 *
 * all_time 的 90 天以内部分**也必须用 5m**，否则会违反
 * 「all_time ⊇ rolling_90d」这个不变量：
 *
 * 1h 的 close 是每小时最后一根 5m 的 close，会漏掉小时内的尖峰；
 * 而 ath_robust 取「第 k 高的 close」，样本从 3250 根降到 271 根后
 * 这个统计量必然更低。线上实测：牛来的 all_time ATH（1h，0.071625）
 * 反而低于 rolling_90d（5m，0.074863），而该代币只有 11 天大 ——
 * 两者覆盖的时间段其实完全相同。
 *
 * 因此 all_time = max(1h 全历史, 5m 近 90 天)，两边各自在自己的粒度内
 * 一致地计算，再取较高者。既保住不变量，又不必为 all_time 拉 52 次 5m。
 */
import { priceFromText } from '../lib/decimal.ts';
import { computeAth, type AthCandle, type AthResult } from './ath.ts';
import * as repo from '../db/repo.ts';

export type AthMode = 'rolling_90d' | 'since_added' | 'all_time';
export type QuoteMode = 'usd' | 'native';

export const ATH_MODES: AthMode[] = ['rolling_90d', 'since_added', 'all_time'];
export const QUOTE_MODES: QuoteMode[] = ['usd', 'native'];

export const ROLLING_WINDOW_SECONDS = 90 * 86400;

interface ModeSpec { timeframe: '5m' | '1h'; tfSeconds: number }

export function specFor(mode: AthMode): ModeSpec {
  return mode === 'all_time' ? { timeframe: '1h', tfSeconds: 3600 } : { timeframe: '5m', tfSeconds: 300 };
}

type CandleRow = ReturnType<typeof repo.getCandles>[number];

/** 按计价模式取出对应的价格列；native 列缺失时该 candle 被跳过，不回退成 USD */
function toAthCandles(rows: CandleRow[], quoteMode: QuoteMode): AthCandle[] {
  const out: AthCandle[] = [];
  for (const r of rows) {
    const h = priceFromText(quoteMode === 'usd' ? r.h : r.hNative);
    const c = priceFromText(quoteMode === 'usd' ? r.c : r.cNative);
    if (!h || !c) continue;
    out.push({ ts: r.ts, h, c, volumeUsd: r.volumeUsd, liquidityTotal: r.liquidityTotal, marketCapUsd: r.marketCapUsd });
  }
  return out;
}

/** 两个候选里取 ath_robust 较高的那个；有 null 就取非 null 的 */
function higher(a: AthResult, b: AthResult): AthResult {
  if (!a.athRobust) return b;
  if (!b.athRobust) return a;
  return b.athRobust.gt(a.athRobust) ? b : a;
}

function computeOne(
  tokenId: string, timeframe: '5m' | '1h', tfSeconds: number,
  quoteMode: QuoteMode, k: number, since: number,
): AthResult {
  return computeAth(toAthCandles(repo.getCandles(tokenId, timeframe, since), quoteMode), k, tfSeconds);
}

/**
 * 计算某个 (mode, quoteMode) 的 ATH。
 * @param addedAt since_added 模式的窗口起点
 * @param now 用于 rolling_90d 的窗口右端
 */
export function computeForMode(
  tokenId: string,
  mode: AthMode,
  quoteMode: QuoteMode,
  k: number,
  addedAt: number,
  now: number,
): AthResult {
  if (mode === 'rolling_90d') {
    return computeOne(tokenId, '5m', 300, quoteMode, k, now - ROLLING_WINDOW_SECONDS);
  }
  if (mode === 'since_added') {
    return computeOne(tokenId, '5m', 300, quoteMode, k, addedAt);
  }
  // all_time：1h 覆盖全历史，5m 覆盖近 90 天且更精细，取较高者
  return higher(
    computeOne(tokenId, '1h', 3600, quoteMode, k, 0),
    computeOne(tokenId, '5m', 300, quoteMode, k, now - ROLLING_WINDOW_SECONDS),
  );
}
