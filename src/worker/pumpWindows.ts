/**
 * 在 5m candle 序列上求四个窗口 × 两个基准的涨幅倍数。
 *
 * 窗口定义：以当前这根（未收盘的）5m candle 为终点，往回数
 * WINDOW_SECONDS/300 根。因此 5m 窗口就是当前这一根自己。
 *
 * 为什么用根数而不是"now 减去秒数"划界：后者会让窗口覆盖的 candle
 * 数量随 now 落在 candle 内的位置摇摆（同一个 24h 窗口时而 288 根
 * 时而 289 根），基准价跟着跳，报警就会在边界上抖。
 *
 * 覆盖度：一个窗口只有在该币的历史真的够长时才求值。只有 5 分钟历史的
 * 新币，24h 窗口会拿这 5 分钟算出"24 小时涨了 2 倍"，而且四个窗口同时触发。
 * 判据是该币最老的一根 candle 是否早于窗口起点 —— 这样对"中间缺根"
 * 是宽容的（数据源会省略无成交的 candle，这在本项目里是常态），
 * 只对"整体历史不够长"严格。
 *
 * 两个基准：
 *   low  —— 窗口内的低点，"从低点拉起了几倍"
 *   open —— 窗口内最老那根的开盘价，"这段时间净涨了几倍"
 * low 基准恒不高于 open 基准，所以 low 的倍数恒不低于 open 的。
 *
 * low 取的是**第 k 低**而不是最低，用来剔除孤立的异常值 ——
 * 实测线上 DexScreener 有一个 tick 给 USDG 返回了 5.56e-24，
 * 成了 1h 窗口的最低点，算出 5.96e21 倍并真的推了报警。
 * 这与 ath.ts 里 ath_robust 用第 k 高而非最高是同一个道理。
 *
 * k 随窗口内 candle 数量分档：孤立点要剔，持续的低位不能剔 ——
 * MOONALD 开盘后连续八根都在 2e-09 量级且每根都有真实成交，
 * 那 772 倍是真的行情。
 */
import { Decimal } from '../lib/decimal.ts';

export type PumpTimeframe = '5m' | '1h' | '6h' | '24h';
export type PumpBasis = 'low' | 'open';

export const WINDOW_SECONDS: Record<PumpTimeframe, number> = {
  '5m': 300, '1h': 3600, '6h': 21600, '24h': 86400,
};

export const TIMEFRAMES: PumpTimeframe[] = ['5m', '1h', '6h', '24h'];

const SLOT = 300;

export interface Candle5m { ts: number; o: string | null; l: string | null }

export interface WindowResult {
  timeframe: PumpTimeframe;
  basis: PumpBasis;
  base: Decimal;
  multiple: Decimal;
}

/** 历史不足以覆盖某个窗口时的说明，供 UI 显示"数据不足"而不是静默省略 */
export interface WindowGap { timeframe: PumpTimeframe; reason: 'no_history' | 'too_young' }

/** 窗口起点（含）。终点恒为当前这根 candle。 */
export function windowStartTs(tf: PumpTimeframe, now: number): number {
  const current = Math.floor(now / SLOT) * SLOT;
  return current - (WINDOW_SECONDS[tf] - SLOT);
}

/**
 * 第 k 低的价格。k 随样本量分档：
 *   >= 12 根 -> 第 3 低（剔除两个孤立异常值）
 *   >= 6 根  -> 第 2 低
 *   否则     -> 最低（样本太少，剔了就没数据了）
 */
export function kthLowest(values: Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const k = values.length >= 12 ? 3 : values.length >= 6 ? 2 : 1;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return sorted[Math.min(k, sorted.length) - 1] ?? null;
}

export function computeMultiples(
  candles: Candle5m[], price: Decimal, now: number,
): WindowResult[] {
  return computeMultiplesDetailed(candles, price, now).results;
}

export function computeMultiplesDetailed(
  candles: Candle5m[], price: Decimal, now: number,
): { results: WindowResult[]; gaps: WindowGap[] } {
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const out: WindowResult[] = [];
  const gaps: WindowGap[] = [];
  const oldestTs = sorted[0]?.ts ?? null;

  for (const tf of TIMEFRAMES) {
    const start = windowStartTs(tf, now);

    // 没数据就不判，而不是判成 0 —— 判成 0 会让新币立刻报出无穷大倍数
    if (oldestTs === null) { gaps.push({ timeframe: tf, reason: 'no_history' }); continue; }
    // 历史不够长：该币最老的 candle 都还在窗口起点之后，
    // 拿这点数据算出来的"24h 涨幅"其实是 5 分钟涨幅
    if (oldestTs > start) { gaps.push({ timeframe: tf, reason: 'too_young' }); continue; }

    const inWindow = sorted.filter((c) => c.ts >= start);
    if (inWindow.length === 0) { gaps.push({ timeframe: tf, reason: 'no_history' }); continue; }

    const firstWithOpen = inWindow.find((c) => c.o !== null && c.o !== '');
    if (firstWithOpen?.o) {
      const base = new Decimal(firstWithOpen.o);
      if (base.gt(0)) out.push({ timeframe: tf, basis: 'open', base, multiple: price.div(base) });
    }

    const lows: Decimal[] = [];
    for (const c of inWindow) {
      if (c.l === null || c.l === '') continue;
      const v = new Decimal(c.l);
      if (!v.gt(0)) continue;                    // 0 或负数不是有效价格
      lows.push(v);
    }
    const low = kthLowest(lows);
    if (low) out.push({ timeframe: tf, basis: 'low', base: low, multiple: price.div(low) });
  }

  return { results: out, gaps };
}
