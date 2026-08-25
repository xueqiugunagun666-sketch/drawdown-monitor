/**
 * 日程提醒 —— 到点推 Telegram。
 *
 * 每个事件有一组提醒偏移（分钟，0 = 到点）。已发出的记在 remindedOffsets 里去重，
 * 这样 worker 重启也不会重复推。
 *
 * **过期太久的不补推**：与 §8.3 报警补发同理 —— 错过的 mint 时间点，
 * 事后几小时再推没有价值，只会制造噪音。
 */
import { nowSec } from '../lib/time.ts';
import { formatInZone, humanUntil, zoneAbbr, DISPLAY_TZ } from '../lib/timezone.ts';
import { makeLogger } from '../lib/log.ts';
import * as repo from '../db/repo.ts';
import type { EventRow } from '../db/repo.ts';

const log = makeLogger('reminders');

/** 超过这个时长的提醒点就不补推了 */
const STALE_REMINDER_SECONDS = 30 * 60;

const PRIORITY_PREFIX: Record<string, string> = {
  high: '[重要] ', normal: '', low: '',
};

const CATEGORY_LABEL: Record<string, string> = {
  mint: 'Mint', launch: '发行', listing: '上所', ama: 'AMA', snapshot: '快照', other: '',
};

function parseNums(json: string | null): number[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

interface Link { label?: string; url?: string }

export function buildReminderMessage(e: EventRow, offsetMinutes: number, now = nowSec()): string {
  const lines: string[] = [];
  const cat = e.category ? CATEGORY_LABEL[e.category] ?? e.category : '';
  const head = offsetMinutes === 0 ? '现在开始' : `${humanUntil(e.atTs, now)}`;

  lines.push(`${PRIORITY_PREFIX[e.priority] ?? ''}${e.title}${cat ? `  (${cat})` : ''}`);
  lines.push('');
  lines.push(`时间   ${formatInZone(e.atTs, DISPLAY_TZ)}  北京时间`);
  // 录入时区与显示时区不同的话，把原始时间也带上 —— 便于和项目公告核对
  if (e.inputTz !== DISPLAY_TZ) {
    lines.push(`原始   ${formatInZone(e.atTs, e.inputTz)}  ${e.inputTz} (${zoneAbbr(e.inputTz, e.atTs)})`);
  }
  lines.push(`距离   ${head}`);

  if (e.note) {
    lines.push('');
    lines.push(`备注: ${e.note}`);
  }

  let links: Link[] = [];
  try {
    links = e.links ? (JSON.parse(e.links) as Link[]) : [];
  } catch { /* 链接坏了不影响提醒本身 */ }
  const valid = links.filter((l) => l.url);
  if (valid.length > 0) {
    lines.push('');
    for (const l of valid) lines.push(`${l.label ? l.label + ': ' : ''}${l.url}`);
  }

  if (e.createdBy) {
    lines.push('');
    lines.push(`由 ${e.createdBy} 添加`);
  }
  return lines.join('\n');
}

/**
 * 找出此刻该发的提醒。
 * @returns 每项 { event, offset, message }
 */
export function dueReminders(now = nowSec()): Array<{ event: EventRow; offset: number; message: string }> {
  const out: Array<{ event: EventRow; offset: number; message: string }> = [];
  for (const e of repo.listEventsForReminder()) {
    const wanted = parseNums(e.remindOffsets);
    const done = new Set(parseNums(e.remindedOffsets));
    for (const off of wanted) {
      if (done.has(off)) continue;
      const fireAt = e.atTs - off * 60;
      if (now < fireAt) continue;                       // 还没到
      if (now - fireAt > STALE_REMINDER_SECONDS) {
        // 错过太久：标记为已发但不推，避免下次又来一遍
        done.add(off);
        repo.markReminded(e.id, [...done]);
        log.info(`${e.title} 的「提前 ${off} 分钟」提醒已过期 ${Math.floor((now - fireAt) / 60)} 分钟，跳过不补推`);
        continue;
      }
      out.push({ event: e, offset: off, message: buildReminderMessage(e, off, now) });
    }
  }
  return out;
}

/** 记录某个提醒点已发出 */
export function confirmSent(e: EventRow, offset: number): void {
  const done = new Set(parseNums(e.remindedOffsets));
  done.add(offset);
  repo.markReminded(e.id, [...done]);
}
