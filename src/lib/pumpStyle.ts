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
