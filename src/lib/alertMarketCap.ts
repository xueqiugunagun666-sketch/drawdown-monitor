/**
 * 报警起点的市值。
 *
 * **由已有的三个数精确反推**，不需要多存一列：市值 = 价格 × 供应量，
 * 而供应量在这段时间里不变，所以
 *   起点市值 = 现市值 × 基准价 ÷ 现价
 *
 * 这正是要的那个读法：「79.8K → 162.4K」比单看「162.4K」多说了一件事
 * —— 它是从多大涨过来的。而人判断一次上涨值不值得看，靠的正是这个跨度。
 */
import { Decimal } from './decimal.ts';

export function baseMarketCap(
  marketCapUsd: number | null | undefined,
  priceUsd: string | null | undefined,
  basePriceUsd: string | null | undefined,
): number | null {
  if (marketCapUsd == null || !Number.isFinite(marketCapUsd)) return null;
  if (!priceUsd || !basePriceUsd) return null;
  let now: Decimal, base: Decimal;
  try {
    now = new Decimal(priceUsd);
    base = new Decimal(basePriceUsd);
  } catch {
    return null;
  }
  if (now.lte(0) || base.lte(0)) return null;
  /**
   * 比例用 Decimal 算再落回 number：市值是展示用的量级数字，不参与阈值
   * 判定；但价格常是 1e-25 这种量级，比例若用 number 算会直接塌成 0。
   */
  return Number(base.div(now).mul(marketCapUsd).toString());
}
