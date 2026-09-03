/**
 * 群聊淘金的筛选。纯函数放这里，好测 —— 筛错的表现是"某个币不见了"，
 * 而那和"本来就没有"长得一模一样。
 */

export interface TrashFilter {
  /** 只看最近多少天（按触发时间）。null = 全部 */
  days: number | null;
  /** 最小跌幅（%）。上游只产出 ≥80% 的，所以这里只能往严了收 */
  minDrawdown: number;
  /** 最小峰值市值（美元）。上游只产出 >100 万的，同样只能往严了收 */
  minPeak: number;
}

/**
 * 上游写死的规则。页面上的输入框拿它当下限提示 ——
 * 填 50% 是没有意义的：那种信号上游压根不会产出，
 * 不说清楚的话用户会以为是我们漏了。
 */
export const UPSTREAM_MIN_DRAWDOWN = 80;
export const UPSTREAM_MIN_PEAK = 1_000_000;

export const DEFAULT_FILTER: TrashFilter = {
  days: null,
  minDrawdown: UPSTREAM_MIN_DRAWDOWN,
  minPeak: UPSTREAM_MIN_PEAK,
};

export interface Filterable {
  triggeredAt: number | null;
  drawdownPercent: number | null;
  peakMarketCap: number | null;
}

export function matchesFilter(r: Filterable, f: TrashFilter, now: number): boolean {
  if (f.days !== null) {
    // 没有触发时间的按"不确定"处理：留着。宁可多显示一条，
    // 也不要因为字段缺失而让一个币静静消失
    if (r.triggeredAt !== null && now - r.triggeredAt > f.days * 86400) return false;
  }
  if (r.drawdownPercent !== null && r.drawdownPercent < f.minDrawdown) return false;
  if (r.peakMarketCap !== null && r.peakMarketCap < f.minPeak) return false;
  return true;
}

/** 与默认值一致就是"没筛"，界面上不必显示"已过滤 0" */
export function isDefault(f: TrashFilter): boolean {
  return f.days === DEFAULT_FILTER.days
    && f.minDrawdown === DEFAULT_FILTER.minDrawdown
    && f.minPeak === DEFAULT_FILTER.minPeak;
}

const KEY = 'trash-filter-v1';

/**
 * 存在浏览器本地。
 *
 * 没做成服务端每人一份：这只是"我这会儿想看哪些"，不影响任何人、
 * 也不驱动报警，为它加一张表和一套接口不值。代价是换设备要重设一次。
 */
export function loadFilter(): TrashFilter {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_FILTER;
    const v = JSON.parse(raw) as Partial<TrashFilter>;
    return {
      days: typeof v.days === 'number' && v.days > 0 ? v.days : null,
      minDrawdown: num(v.minDrawdown, DEFAULT_FILTER.minDrawdown),
      minPeak: num(v.minPeak, DEFAULT_FILTER.minPeak),
    };
  } catch {
    return DEFAULT_FILTER;      // 存坏了退回默认，不能让整页打不开
  }
}

export function saveFilter(f: TrashFilter): void {
  try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* 无痕模式等，忽略 */ }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}
