/**
 * 决定一个持仓的代币要不要进入价格监控。
 *
 * 这一层是整个功能的生死线，不是优化项：实测拿一个活跃地址查索引器，
 * 返回 7,984 个代币，其中只有 368 个有价格。不过滤，轮询预算当场爆掉，
 * 而且空投垃圾币恰恰是波动最疯的，会占据绝大部分报警名额。
 *
 * 门槛必须有滞回。一个恰好卡在 $5,000 附近的币会反复进出监控集，
 * 而每次重新进入都会触发一次冷启动 seed 把状态机重置 ——
 * 结果是它涨到 2 倍时可能一次都不报，也可能报十次。
 */
export interface FilterThresholds {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /** 退出门槛 = 进入门槛 × 这个比例 */
  exitRatio: number;
  /** 跌破退出门槛后要持续这么久才真的退出 */
  exitSustainSeconds: number;
}

export const DEFAULT_THRESHOLDS: FilterThresholds = {
  minLiquidityUsd: 5000,
  minVolume24hUsd: 10000,
  exitRatio: 0.6,
  exitSustainSeconds: 1800,
};

export interface FilterInput {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

export interface FilterState {
  monitored: boolean;
  belowSinceTs: number | null;
}

export interface FilterResult extends FilterState {
  reason: string | null;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function evaluateFilter(
  prev: FilterState, q: FilterInput, now: number, th: FilterThresholds = DEFAULT_THRESHOLDS,
): FilterResult {
  // 报价缺失：既不当 0 也不当达标，保持原状态并标明。
  // belowSinceTs 也原样保留 —— 接口抖一下不该让已经跌破的币重新开始计时
  if (q.liquidityUsd === null || q.volume24hUsd === null) {
    return {
      monitored: prev.monitored,
      belowSinceTs: prev.belowSinceTs,
      reason: '报价缺失，判定暂缓',
    };
  }

  const { liquidityUsd: liq, volume24hUsd: vol } = q;

  if (!prev.monitored) {
    const liqOk = liq >= th.minLiquidityUsd;
    const volOk = vol >= th.minVolume24hUsd;
    if (liqOk && volOk) return { monitored: true, belowSinceTs: null, reason: null };
    const missing: string[] = [];
    if (!liqOk) missing.push(`流动性 ${usd(liq)} < ${usd(th.minLiquidityUsd)}`);
    if (!volOk) missing.push(`24h 成交 ${usd(vol)} < ${usd(th.minVolume24hUsd)}`);
    return { monitored: false, belowSinceTs: null, reason: missing.join('，') };
  }

  // 已在监控：用更低的退出门槛判，形成滞回区
  const below = liq < th.minLiquidityUsd * th.exitRatio || vol < th.minVolume24hUsd * th.exitRatio;
  if (!below) return { monitored: true, belowSinceTs: null, reason: null };

  const since = prev.belowSinceTs ?? now;
  if (now - since >= th.exitSustainSeconds) {
    return {
      monitored: false, belowSinceTs: null,
      reason: `流动性/成交持续低于退出线超过 ${th.exitSustainSeconds / 60} 分钟`,
    };
  }
  return { monitored: true, belowSinceTs: since, reason: '低于退出线，观察中' };
}
