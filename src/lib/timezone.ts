/**
 * 时区换算 —— 日历用。
 *
 * 存储一律 UTC 秒；输入按用户选的时区解释；显示默认北京时间。
 *
 * **必须用 IANA 时区而不是 CET/EST 这类缩写**：缩写不含夏令时信息，
 * CET 冬天是 UTC+1、夏天变 CEST 是 UTC+2。写死偏移量的话一年里有半年差 1 小时，
 * 而且错得很隐蔽 —— mint 时间差一小时就是错过。
 * 用 Intl 配 IANA 时区，夏令时由系统时区库处理。
 */

export const DISPLAY_TZ = 'Asia/Shanghai';

/** 可选输入时区。value 是 IANA 名，label 给人看 */
export const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'Asia/Shanghai', label: '北京时间 (UTC+8)' },
  { value: 'UTC', label: 'UTC / GMT' },
  { value: 'America/New_York', label: '美东 ET (纽约)' },
  { value: 'America/Los_Angeles', label: '美西 PT (洛杉矶)' },
  { value: 'Europe/London', label: '英国 GMT/BST (伦敦)' },
  { value: 'Europe/Berlin', label: '中欧 CET/CEST (柏林)' },
  { value: 'Asia/Tokyo', label: '日本 JST (东京)' },
  { value: 'Asia/Singapore', label: '新加坡 (UTC+8)' },
  { value: 'Asia/Dubai', label: '迪拜 (UTC+4)' },
];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 把某个 UTC 时刻，在指定时区下的「墙上时间」各字段拆出来 */
function partsInZone(utcMs: number, tz: string): Record<string, number> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // Intl 在午夜可能给出 hour=24，归一到 0
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** 该时区在某个 UTC 时刻的偏移量（毫秒，东为正） */
function offsetAt(utcMs: number, tz: string): number {
  const p = partsInZone(utcMs, tz);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - utcMs;
}

/**
 * 把「某时区的墙上时间」转成 UTC 秒。
 *
 * @param wall 形如 "2026-09-03T20:00"（datetime-local 的原生格式）
 * @param tz   IANA 时区名
 *
 * 迭代两次是必要的：偏移量本身依赖时刻，夏令时切换日附近一次算不准。
 */
export function wallTimeToUtcSeconds(wall: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const naiveUtc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0));

  let guess = naiveUtc - offsetAt(naiveUtc, tz);
  guess = naiveUtc - offsetAt(guess, tz);
  return Math.floor(guess / 1000);
}

/** UTC 秒 -> 指定时区的 "YYYY-MM-DD HH:mm" */
export function formatInZone(utcSeconds: number, tz = DISPLAY_TZ): string {
  const p = partsInZone(utcSeconds * 1000, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)} ${pad(p.hour!)}:${pad(p.minute!)}`;
}

/** UTC 秒 -> datetime-local 输入框要的 "YYYY-MM-DDTHH:mm" */
export function toInputValue(utcSeconds: number, tz: string): string {
  return formatInZone(utcSeconds, tz).replace(' ', 'T');
}

/** 该时区当前的 UTC 偏移，用于展示，如 "UTC+8" / "UTC-4" */
export function zoneAbbr(tz: string, atUtcSeconds = Date.now() / 1000): string {
  const mins = offsetAt(atUtcSeconds * 1000, tz) / 60000;
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

/** "还有 3 天 / 还有 2 小时 / 已过去 1 天" */
export function humanUntil(utcSeconds: number, now = Math.floor(Date.now() / 1000)): string {
  const d = utcSeconds - now;
  const abs = Math.abs(d);
  const unit =
    abs < 60 ? `${abs} 秒`
    : abs < 3600 ? `${Math.floor(abs / 60)} 分钟`
    : abs < 86400 ? `${Math.floor(abs / 3600)} 小时`
    : `${Math.floor(abs / 86400)} 天`;
  return d >= 0 ? `还有 ${unit}` : `已过去 ${unit}`;
}
