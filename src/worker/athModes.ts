/**
 * 三种 ATH 模式的窗口切片 —— 规格 §2.1。
 *
 * | 模式          | 序列 | 窗口                  |
 * |---------------|------|-----------------------|
 * | rolling_90d   | 5m   | [now-90d, now]        |
 * | since_added   | 5m   | [token.added_at, now] |
 * | all_time      | 1h   | 全部                  |
 *
 * all_time 用 1h 而非 5m：5m 覆盖 180 天要 52 次 GT 请求，
 * 而找历史最高点用小时级足够。rolling_90d 必须用 5m ——
 * 与实时段粒度一致，否则窗口滑动时 ATH 严格度会悄悄改变（§2.2）。
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
    out.push({ ts: r.ts, h, c, volumeUsd: r.volumeUsd, liquidityTotal: r.liquidityTotal });
  }
  return out;
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
  const spec = specFor(mode);
  const since =
    mode === 'rolling_90d' ? now - ROLLING_WINDOW_SECONDS
    : mode === 'since_added' ? addedAt
    : 0;
  const rows = repo.getCandles(tokenId, spec.timeframe, since);
  return computeAth(toAthCandles(rows, quoteMode), k, spec.tfSeconds);
}
