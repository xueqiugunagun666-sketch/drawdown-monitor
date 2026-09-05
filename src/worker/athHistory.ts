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
  /**
   * 历史最高价，取每根 K 线的**最高价**（h），不是收盘价。
   *
   * 第一版取收盘价，理由是"单根影线戳出来的高点不算"—— 那个理由对
   * **实时判定**成立（一根影线不该触发报警），对**确立历史最高**是错的：
   * 历史最高本来就是最高价，用收盘价会系统性低估，于是任何一次普通上涨
   * 都像"破新高"。
   *
   * 线上实测（Sue，2026-09-05）：真实最高 0.006444（当天 11:00），
   * 而按小时线收盘价算出来只有 0.0046575 —— 低了 38%。价格涨到 0.005016
   * 时对着这条偏低的线看像突破 1.126 倍，实际离真实高点还差 22%，
   * 报了一条彻头彻尾的假新高。
   *
   * 两处用不同口径是**故意**的，而且方向一致地保守：
   *   参照线取最高价 —— 更难被突破
   *   实时触发取 5 分钟收盘价 —— 需要站稳才算
   * 两边都偏向"不报"，这正是误报最贵的场景该有的偏向。
   */
  athPrice: Decimal | null;
  athTs: number | null;
  historyStartTs: number | null;
  /** 历史覆盖了这个币的全部生命 */
  complete: boolean;
  /**
   * 我们手上有多少秒历史。用秒不用天是因为很多币只有几小时 ——
   * 取整到天会变成 0，说不清楚。
   */
  coverageSeconds: number;
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
    /**
     * 优先用最高价；数据源偶尔只给收盘价（残缺的根），那就退而求其次。
     * 两个都没有就跳过，不拿 0 冒充。
     */
    const peak = c.h ?? c.c;
    if (!peak) continue;
    if (athPrice === null || peak.gt(athPrice)) { athPrice = peak; athTs = c.ts; }
  }

  const complete = start !== null && pairCreatedAt !== null
    && start <= pairCreatedAt + COMPLETENESS_SLACK_SECONDS;

  return {
    athPrice, athTs, historyStartTs: start, complete,
    coverageSeconds: start === null ? 0 : Math.max(0, now - start),
  };
}

/**
 * 「历史完整」但币太年轻时，还要把年龄说出来的分界。
 *
 * 对一个 2 小时前建池的币说「突破历史新高」是真话 —— 我们确实覆盖了它
 * 的全部生命 —— 但听起来像个里程碑，而它的"历史"只有两小时。线上有
 * 67 个币属于这一类（完整但不到 2 天）。说成「上市 2 小时新高」，
 * 读的人才能正确估量这条消息的分量。
 */
export const YOUNG_DAYS = 2;

/**
 * 报警文案里怎么称呼这个高点。
 *
 * 历史不完整时必须把跨度说出来 —— 含糊其辞地说「新高」，读的人默认
 * 理解成历史新高。跨度不足一天就用小时，取整到天会变成 0 说不清楚。
 */
export function describeAthScope(
  s: { complete: boolean; coverageSeconds: number },
): string {
  const hours = Math.floor(s.coverageSeconds / 3600);
  const days = Math.floor(s.coverageSeconds / 86400);

  if (s.complete) {
    if (days >= YOUNG_DAYS) return '历史新高';
    if (hours >= 1) return `上市 ${hours} 小时新高`;
    return '上市不足一小时新高';
  }
  if (days >= 1) return `${days} 天新高`;
  if (hours >= 1) return `${hours} 小时新高`;
  return '新高（历史不足一小时）';
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

/**
 * 长历史与实时报价是不是同一个口径。
 *
 * GMGN 与 DexScreener 会对同一个币给出**完全不同量级**的价格 —— 实测
 * 「不对劲」差 126 倍、「哈夫币」119 倍、「Monkey」258 倍（同一时刻，
 * 不是涨跌）。5 分钟线的回填早就有这道守卫，而我写 ATH 回填时漏了 ——
 * 后果是历史最高从 GMGN 算、实时价从 DexScreener 来，**任何实时价看着
 * 都像天量突破**：Monkey 报了一条「高出 5327%」的假新高。
 *
 * 判据是**最后一根 K 线**对比实时价：两者只相隔几十分钟，本该几乎相等。
 * 用最后一根而不是最高价，所以真实的大涨不会被误杀。
 *
 * 对不上时**不存 ATH**（存 null），而不是存一个错的：没有参照线就不报，
 * 这是诚实的失败方式；存错的会一直推假新高，而工具喊一次狼来了就会被关掉。
 */
export function sourcesAgree(
  lastCandleClose: Decimal | null | undefined,
  livePrice: Decimal | null | undefined,
  maxDeviation: number,
): boolean {
  if (!lastCandleClose || !livePrice) return true;   // 缺一边就无从比较，不拦
  if (lastCandleClose.lte(0) || livePrice.lte(0)) return true;
  const ratio = Decimal.max(
    lastCandleClose.div(livePrice),
    livePrice.div(lastCandleClose),
  );
  return ratio.lte(maxDeviation);
}
