/**
 * 离群池剔除 + primary pool 选举 —— 规格 §2.4。
 *
 * 背景：DexScreener 会对某些池给出错误的报价代币定价，使该池的 USD 价格
 * 与 USD 流动性同时虚高约 4950 倍（实测 JUP、BONK）。直接按流动性选主池
 * 会正好选中它 —— JUP 的坏池占 $423M 总流动性中的 $421M。
 *
 * 因此：先用**不加权中位数**做价格交叉验证剔除离群池，再在剩余池中选主池。
 * 中位数不能加权 —— 加权会被坏池的虚高流动性带跑。
 */
import { Decimal } from '../lib/decimal.ts';

export interface SelectablePool {
  priceUsd: Decimal;
  liquidityUsd: number;
}

export interface SelectionResult<T extends SelectablePool> {
  primary: T;
  clean: T[];
  outliers: T[];
  medianPriceUsd: Decimal;
  liquidityTotal: number;
  /** 池数 < 3 时无法交叉验证 */
  crossValidated: boolean;
}

/** 不加权中位数 */
export function medianPrice(prices: Decimal[]): Decimal {
  if (prices.length === 0) throw new Error('medianPrice: 空数组');
  const sorted = [...prices].sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return sorted[mid - 1]!.plus(sorted[mid]!).div(2);
}

/** 价格相对中位数的偏离倍数（始终 >= 1） */
export function deviationFactor(price: Decimal, median: Decimal): Decimal {
  if (median.lte(0) || price.lte(0)) return new Decimal(Infinity);
  const r = price.div(median);
  return r.gte(1) ? r : new Decimal(1).div(r);
}

/**
 * @param pools 该代币作为 base 的全部池（至少 1 个）
 * @param deviationMax 默认 1.5；健康代币跨池真实价差仅 1.0–1.3x，坏池约 4950x
 */
export function selectPools<T extends SelectablePool>(
  pools: T[],
  deviationMax: number,
): SelectionResult<T> {
  if (pools.length === 0) throw new Error('selectPools: 没有可选池');

  const median = medianPrice(pools.map((p) => p.priceUsd));
  const maxDev = new Decimal(deviationMax);

  // 池数 < 3 无法交叉验证：中位数就是池自身（1 个），或两池互差时无从判断谁对
  const crossValidated = pools.length >= 3;

  let clean: T[];
  let outliers: T[];
  if (!crossValidated) {
    clean = [...pools];
    outliers = [];
  } else {
    clean = pools.filter((p) => deviationFactor(p.priceUsd, median).lte(maxDev));
    outliers = pools.filter((p) => deviationFactor(p.priceUsd, median).gt(maxDev));
    // 理论上中位数保证至少一半在范围内；真出现全离群说明数据彻底不可信，
    // 退回全集但不静默 —— 调用方据 crossValidated=false 标注 UI
    if (clean.length === 0) {
      clean = [...pools];
      outliers = [];
    }
  }

  const byLiq = [...clean].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return {
    primary: byLiq[0]!,
    clean,
    outliers,
    medianPriceUsd: median,
    liquidityTotal: clean.reduce((s, p) => s + p.liquidityUsd, 0),
    crossValidated,
  };
}
