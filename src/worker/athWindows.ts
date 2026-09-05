/**
 * ATH 的滚动窗口。
 *
 * 原先只有一个"历史最高"，文案是「历史新高 / N 天新高」，而那个 N 说的是
 * **我们的数据覆盖了多少天** —— 说的是我们的局限，不是行情。改成滚动窗口
 * 之后，报的是它**真的突破了多长时间的高点**：突破 90 天高点和突破 3 天
 * 高点，分量差得远，而这才是读的人要的信息。
 *
 * 窗口按从短到长排列，判定时取**突破的最长那个** —— 一次上涨只说最有分量
 * 的那句话，而不是把七个窗口各报一遍。
 */

export interface AthWindow {
  key: string;
  label: string;
  /** null = 全部历史 */
  seconds: number | null;
}

const DAY = 86400;

export const ATH_WINDOWS: AthWindow[] = [
  { key: '3d', label: '3 天', seconds: 3 * DAY },
  { key: '7d', label: '7 天', seconds: 7 * DAY },
  { key: '30d', label: '30 天', seconds: 30 * DAY },
  { key: '90d', label: '90 天', seconds: 90 * DAY },
  { key: '180d', label: '180 天', seconds: 180 * DAY },
  { key: '360d', label: '360 天', seconds: 360 * DAY },
  { key: 'all', label: '全部', seconds: null },
];

/** 窗口的档次：越大越有分量。报警只在突破**更长**的窗口时才算新消息 */
export function windowRank(key: string): number {
  return ATH_WINDOWS.findIndex((w) => w.key === key);
}

export function windowByKey(key: string): AthWindow | null {
  return ATH_WINDOWS.find((w) => w.key === key) ?? null;
}

/**
 * 一个窗口的高点该不该采信。
 *
 * 我们的历史只覆盖到某个时点，比它更长的窗口是**假的** —— 一个 6 天前
 * 才开始看的币，"360 天新高"只是 6 天新高换个说法。必须按实际覆盖裁掉，
 * 否则文案会把我们的无知说成行情的分量。
 */
export function windowIsCovered(
  w: AthWindow, historyStartTs: number | null, now: number,
): boolean {
  if (historyStartTs === null) return false;
  if (w.seconds === null) return true;          // 「全部」永远等于我们手上的全部
  return now - historyStartTs >= w.seconds;
}

/**
 * 在已覆盖的窗口里，找出被突破的**最长**那个。
 *
 * @param highs 每个窗口的历史高点（key -> 价格），缺的当作没有
 * @param margin 突破幅度门槛，例如 0.10 表示要超出 10%
 */
export function largestBrokenWindow(
  price: { gt(x: unknown): boolean; },
  highs: Map<string, { mul(x: number): unknown; gt(x: unknown): boolean }>,
  historyStartTs: number | null,
  now: number,
  margin: number,
): AthWindow | null {
  let best: AthWindow | null = null;
  for (const w of ATH_WINDOWS) {
    if (!windowIsCovered(w, historyStartTs, now)) continue;
    const h = highs.get(w.key);
    if (!h) continue;
    if (price.gt(h.mul(1 + margin))) best = w;   // 越往后越长，最后一个成立的就是最长的
  }
  return best;
}

/** 「突破 90 天新高」/「突破历史新高」 */
export function describeWindow(w: AthWindow): string {
  return w.seconds === null ? '历史新高' : `${w.label}新高`;
}
