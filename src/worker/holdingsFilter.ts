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
  /**
   * 重新进入监控的快通道：1 小时成交量到这个数就够，不必等 24h 量爬回来。
   *
   * 为什么必须有这条：24h 成交量是**滞后 24 小时**的指标，而「从没人交易
   * 到暴涨」正是它该抓的那件事本身 —— 拿一天的均值守五分钟的行情。
   * FLETCH 9-03 就栽在这里：03:15 因 24h 量不足被降级，14 小时不采价，
   * 17:15 行情起来时 24h 量还差得远，靠它根本回不来。
   *
   * $2,000 的定法：进入线 $10,000 的 1/5。一个币一小时做到两千刀成交，
   * 已经不是"没人要"了；而真正的粉尘币一小时连两百刀都做不到，挡得住。
   * 注意这只放宽**进入**，退出仍然只看 24h 量 —— 不然一阵脉冲成交
   * 就能让币在监控集里进进出出，把状态机反复重置。
   */
  minVolume1hUsd: number;
  /**
   * 持有人数上限。超过就不监控 —— 几十万持有人的币基本都是空投盘，
   * 那种"从 2e-09 涨到 1.6e-06"的曲线是开盘假量，不是行情。
   *
   * 用绝对值而不是比例：实测比例法分不开这两类 —— USDT 的
   * 持有人/24h成交量是 13.0，比 MOONALD 的 2.71 还"差"，
   * 因为稳定币人人持有但人均交易少。
   *
   * 副作用是 USDT(5687万) / WBNB(298万) / CAKE(38万) 这些也会被挡，
   * 但它们本来就不可能涨 2 倍，挡掉没有实际损失。
   */
  maxHolderCount: number;
  /** 退出门槛 = 进入门槛 × 这个比例 */
  exitRatio: number;
  /** 跌破退出门槛后要持续这么久才真的退出 */
  exitSustainSeconds: number;
}

export const DEFAULT_THRESHOLDS: FilterThresholds = {
  minLiquidityUsd: 5000,
  minVolume24hUsd: 10000,
  minVolume1hUsd: 2000,
  maxHolderCount: 100_000,
  exitRatio: 0.6,
  exitSustainSeconds: 1800,
};

export interface FilterInput {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** 1 小时成交量。null = 数据源没给，按 0 当作"没有帮助"，绝不因此踢币 */
  volume1hUsd?: number | null;
  /** null = 还没查到。查不到不等于合格，但也不该因此踢掉已在监控的币 */
  holderCount?: number | null;
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

  // 持有人数超标：直接出局，不进滞回。
  // 这不是"暂时不够格"而是"这个币的性质就不对"，没有回旋余地
  if (q.holderCount !== null && q.holderCount !== undefined && q.holderCount > th.maxHolderCount) {
    const wan = (n: number) => `${(n / 10000).toFixed(1)} 万`;
    return {
      monitored: false, belowSinceTs: null,
      reason: `持有人 ${wan(q.holderCount)} > ${wan(th.maxHolderCount)}，多为空投盘`,
    };
  }

  if (!prev.monitored) {
    const liqOk = liq >= th.minLiquidityUsd;
    // 24h 量够，或者刚醒过来的 1h 量够 —— 满足一个就放进来
    const vol1h = q.volume1hUsd ?? 0;
    const volOk = vol >= th.minVolume24hUsd || vol1h >= th.minVolume1hUsd;
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
