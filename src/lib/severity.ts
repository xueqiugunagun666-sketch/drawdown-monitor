/**
 * 回撤严重度配色 —— 规格 §9.1 的颜色梯度。
 *
 * 三档而非四档：黄红两档的区分度经校验很高（CVD ΔE 24.4、正常视觉 28.4，
 * 对比度均过 3:1）。更细的分档反而让相邻两档难以分辨。
 *
 * **颜色从不单独承载信息** —— 百分比数字始终显示在旁边。
 */
export const SEVERITY = {
  none: 'text-neutral-400',
  warning: 'text-[#fab219]',
  critical: 'text-[#d03b3b]',
} as const;

/** 阈值取自规格：0~50 中性 / 50~80 警告 / >=80 严重 */
export function severityClass(drawdownPct: number | null): string {
  if (drawdownPct === null) return 'text-neutral-600';
  if (drawdownPct >= 80) return SEVERITY.critical;
  if (drawdownPct >= 50) return SEVERITY.warning;
  return SEVERITY.none;
}

/** 进度条用的背景色（同一套语义） */
export function severityBar(drawdownPct: number | null): string {
  if (drawdownPct === null) return 'bg-neutral-800';
  if (drawdownPct >= 80) return 'bg-[#d03b3b]';
  if (drawdownPct >= 50) return 'bg-[#fab219]';
  return 'bg-neutral-600';
}
