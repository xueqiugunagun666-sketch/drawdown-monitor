/**
 * 暴涨档位配色。
 *
 * 与 severity.ts（回撤）刻意不同色系：那边是黄/红表示"跌得厉害"，
 * 这边是绿表示"涨得厉害"。两者不会同页出现（看板 vs 钱包页），
 * 但仍校验过跨页碰撞。
 *
 * **2x 不上色。** 三级单色相在色觉缺陷空间里挤不开 —— 实测暗绿与中绿
 * 在绿色盲下 ΔE 只有 5.0，而把暗绿调暗到能区分，又会和回撤严重红
 * 在红色盲下撞上（ΔE 9.5）。而且倍数数字本身已经说清了等级，
 * 颜色是冗余编码，遵循 severity.ts 里"颜色从不单独承载信息"的同一条原则。
 *
 * 实测（scripts/check-palette.ts）：三档互相最差 ΔE 16.5（绿色盲），
 * 与既有的 #fab219 / #d03b3b / #3987e5 零碰撞，对比度全部 >= 8:1。
 */
export const PUMP = {
  low: 'text-neutral-300',        // 2x：不上色
  mid: 'text-[#3fbf7f]',          // 5x
  high: 'text-[#7ef2b4]',         // 10x
} as const;

export function pumpClass(level: number): string {
  if (level >= 10) return PUMP.high;
  if (level >= 5) return PUMP.mid;
  return PUMP.low;
}

/** 左缘标识条，与 TokenRow 的严重度色带同一位置语义 */
export function pumpBar(level: number): string {
  if (level >= 10) return 'bg-[#7ef2b4]';
  if (level >= 5) return 'bg-[#3fbf7f]';
  return 'bg-neutral-600';
}

/** 窗口与基准的中文说明 —— 报警里必须说清是"从低点"还是"净涨" */
export function describeBasis(timeframe: string, basis: string): string {
  const tf = { '5m': '5 分钟', '1h': '1 小时', '6h': '6 小时', '24h': '24 小时' }[timeframe] ?? timeframe;
  return basis === 'low' ? `${tf}内从低点` : `${tf}净涨`;
}

/* ---------------- 破新高 ---------------- */

/**
 * 破新高单独一个色系（蓝），不跟暴涨的绿混。
 *
 * 两者是不同的事：暴涨是"从最近低点涨了 N 倍"，破新高是"进入价格发现区"。
 * 用同一套绿色深浅表示，等于让人靠数字大小去猜类型 —— 而列表里一眼扫过去
 * 最先看到的就是颜色。蓝色与既有的 #3fbf7f / #fab219 / #d03b3b 都拉得开。
 */
export const ATH_COLOR = 'text-[#6fb4f0]';
export const ATH_BAR = 'bg-[#6fb4f0]';

export function isAthAlert(kind: string | null | undefined): boolean {
  return kind === 'ath' || kind === 'ath-advance';
}

/** 「高出 12%」—— 破新高看的是超过前高多少，不是涨了几倍 */
export function describeAthDelta(multiple: string): string {
  const pct = (Number(multiple) - 1) * 100;
  if (!Number.isFinite(pct)) return '';
  return `高出 ${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
}
