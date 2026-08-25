export const FIVE_MIN = 300;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 把秒级时间戳对齐到所属 5m 格 */
export function align5m(tsSeconds: number): number {
  return Math.floor(tsSeconds / FIVE_MIN) * FIVE_MIN;
}

export function fmtUtc(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** "3 天前" / "4 小时前" */
export function humanAgo(tsSeconds: number, now = nowSec()): string {
  const d = Math.max(0, now - tsSeconds);
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}
