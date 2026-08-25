/**
 * 日程输入的校验与规范化。纯函数，便于测试。
 */
import { isValidTimezone, wallTimeToUtcSeconds } from './timezone.ts';

export const CATEGORIES = ['mint', 'launch', 'listing', 'ama', 'snapshot', 'other'] as const;
export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  mint: 'Mint', launch: '发行', listing: '上所', ama: 'AMA', snapshot: '快照', other: '其他',
};
export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '重要', normal: '普通', low: '次要',
};

/** 默认提醒：提前 1 天、提前 1 小时、到点 */
export const DEFAULT_REMIND_OFFSETS = [1440, 60, 0];

export interface EventLink { label: string; url: string }

export interface ParsedEvent {
  title: string;
  atTs: number;
  inputTz: string;
  category: Category | null;
  priority: Priority;
  note: string | null;
  links: EventLink[];
  remindOffsets: number[];
}

/**
 * 只放行 http/https。
 * 这些链接会被渲染成可点的 <a>，放行 javascript: 或 data: 就是自己给自己开 XSS。
 */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseEventInput(
  body: Record<string, unknown>,
): { ok: true; value: ParsedEvent } | { ok: false; error: string } {
  const title = String(body.title ?? '').trim().slice(0, 120);
  if (!title) return { ok: false, error: '标题必填' };

  const tz = String(body.inputTz ?? '');
  if (!tz || !isValidTimezone(tz)) return { ok: false, error: `时区无效: ${tz || '(空)'}` };

  const wall = String(body.at ?? '');
  const atTs = wallTimeToUtcSeconds(wall, tz);
  if (atTs === null) return { ok: false, error: `时间格式无法解析: ${wall || '(空)'}` };

  const rawCat = body.category === undefined || body.category === null || body.category === ''
    ? null : String(body.category);
  if (rawCat !== null && !(CATEGORIES as readonly string[]).includes(rawCat)) {
    return { ok: false, error: `未知分类: ${rawCat}` };
  }

  const rawPri = String(body.priority ?? 'normal');
  if (!(PRIORITIES as readonly string[]).includes(rawPri)) {
    return { ok: false, error: `未知重要程度: ${rawPri}` };
  }

  const note = String(body.note ?? '').trim().slice(0, 500) || null;

  const links: EventLink[] = [];
  if (Array.isArray(body.links)) {
    for (const raw of body.links.slice(0, 10)) {
      const l = raw as { label?: unknown; url?: unknown };
      const url = String(l.url ?? '').trim();
      if (!url) continue;
      if (!isSafeUrl(url)) {
        return { ok: false, error: `链接必须以 http:// 或 https:// 开头: ${url.slice(0, 40)}` };
      }
      links.push({ label: String(l.label ?? '').trim().slice(0, 20), url: url.slice(0, 500) });
    }
  }

  let remindOffsets = DEFAULT_REMIND_OFFSETS;
  if (Array.isArray(body.remindOffsets)) {
    const nums = body.remindOffsets
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 30);
    remindOffsets = [...new Set(nums)].sort((a, b) => b - a);
    if (remindOffsets.length === 0) return { ok: false, error: '至少要有一个有效的提醒时间点' };
  }

  return {
    ok: true,
    value: { title, atTs, inputTz: tz, category: rawCat as Category | null,
             priority: rawPri as Priority, note, links, remindOffsets },
  };
}
