/**
 * 钱包币的历史最高价：从长历史 K 线算出 ATH，并判断我们的历史够不够完整。
 *
 * **为什么要判断完整性**：我们的 5 分钟线只从开始监控那天算起（实时回填
 * 也只有 24 小时）。对一个 8 月 30 日加进来的币，"历史最高"只是 6 天的
 * 最高 —— 而它三个月前可能高得多。把 6 天新高说成历史新高，是这个系统
 * 最该避免的那类谎（第 4 条铁律：静默的错误比误报危险）。
 *
 * 判据不用猜：DexScreener 的 pairCreatedAt 给了建池时间，我们的历史起点
 * 早于它就说明覆盖了这个币的全部生命。
 *
 * 实测（2026-09-05，451 个监控币）：币龄中位数 15 天，近 70% 不到 41 天。
 * 所以日线一次拉 1000 根，绝大多数币能一次覆盖全生命。
 */
import { Decimal } from '../lib/decimal.ts';
import type { Candle } from '../sources/types.ts';

/**
 * 建池时间的宽限。
 *
 * 数据源之间对"第一根 K 线"的定义差几分钟很正常（建池到第一笔成交总有
 * 间隔，而 K 线是按成交产生的）。卡死会让本来完整的历史被判成不完整，
 * 白白降级成「N 天新高」。放一小时，宁可偶尔把接近完整的当成完整 ——
 * 差这一小时的价格波动，对"是不是历史新高"这个判断没有实质影响。
 */
export const COMPLETENESS_SLACK_SECONDS = 3600;

export interface AthSummary {
  /** 最高收盘价。用收盘不用最高 —— 单根影线戳出来的高点不算 */
  athPrice: Decimal | null;
  athTs: number | null;
  historyStartTs: number | null;
  /** 历史覆盖了这个币的全部生命 */
  complete: boolean;
  /** 我们手上有多少天历史。报警文案要用它说「N 天新高」 */
  coverageDays: number;
}

/**
 * 从一串 K 线算出 ATH 摘要。
 *
 * @param pairCreatedAt 建池时间（秒）。为 null 时一律判为不完整 ——
 *   不知道这个币多老，就没有资格说"覆盖了全部历史"。
 */
export function summarizeAth(
  candles: Candle[], pairCreatedAt: number | null, now: number,
): AthSummary {
  let athPrice: Decimal | null = null;
  let athTs: number | null = null;
  let start: number | null = null;

  for (const c of candles) {
    if (start === null || c.ts < start) start = c.ts;
    // c 可能是 null（数据源偶尔给残缺的根），跳过而不是当 0
    if (!c.c) continue;
    if (athPrice === null || c.c.gt(athPrice)) { athPrice = c.c; athTs = c.ts; }
  }

  const complete = start !== null && pairCreatedAt !== null
    && start <= pairCreatedAt + COMPLETENESS_SLACK_SECONDS;

  return {
    athPrice, athTs, historyStartTs: start, complete,
    coverageDays: start === null ? 0 : Math.max(0, Math.floor((now - start) / 86400)),
  };
}

/**
 * 报警文案里怎么称呼这个高点。
 *
 * 历史不完整时必须把天数说出来，而且要点明"不代表历史最高" ——
 * 含糊其辞地说「新高」，读的人默认理解成历史新高。
 */
export function describeAthScope(s: Pick<AthSummary, 'complete' | 'coverageDays'>): string {
  if (s.complete) return '历史新高';
  if (s.coverageDays <= 0) return '新高（历史不足一天）';
  return `${s.coverageDays} 天新高`;
}

/**
 * 长历史该用哪个分辨率。
 *
 * GMGN 一次最多 1000 根：日线覆盖 1000 天，小时线 41 天，5 分钟线 3.5 天。
 * 先按币龄挑最省的那个 —— 年轻的币用小时线，精度高又够覆盖；
 * 老币只能用日线。
 *
 * @param ageDays 币龄；null（拿不到建池时间）时按最老处理，用日线
 */
export function pickResolution(ageDays: number | null): '1h' | '1d' {
  if (ageDays === null) return '1d';
  return ageDays <= 40 ? '1h' : '1d';
}
