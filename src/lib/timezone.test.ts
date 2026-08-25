import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wallTimeToUtcSeconds, formatInZone, zoneAbbr, humanUntil, isValidTimezone, TIMEZONES,
} from './timezone.ts';

test('北京时间转 UTC', () => {
  // 2026-09-03 20:00 北京 = 12:00 UTC
  const ts = wallTimeToUtcSeconds('2026-09-03T20:00', 'Asia/Shanghai')!;
  assert.equal(new Date(ts * 1000).toISOString(), '2026-09-03T12:00:00.000Z');
});

test('UTC 输入原样返回', () => {
  const ts = wallTimeToUtcSeconds('2026-09-03T12:00', 'UTC')!;
  assert.equal(new Date(ts * 1000).toISOString(), '2026-09-03T12:00:00.000Z');
});

test('夏令时：中欧夏季是 CEST(UTC+2)，冬季是 CET(UTC+1)', () => {
  // 7 月 -> CEST，20:00 柏林 = 18:00 UTC
  const summer = wallTimeToUtcSeconds('2026-07-15T20:00', 'Europe/Berlin')!;
  assert.equal(new Date(summer * 1000).toISOString(), '2026-07-15T18:00:00.000Z');
  // 1 月 -> CET，20:00 柏林 = 19:00 UTC
  const winter = wallTimeToUtcSeconds('2026-01-15T20:00', 'Europe/Berlin')!;
  assert.equal(new Date(winter * 1000).toISOString(), '2026-01-15T19:00:00.000Z');
});

test('夏令时：美东夏季 EDT(UTC-4)，冬季 EST(UTC-5)', () => {
  const summer = wallTimeToUtcSeconds('2026-07-15T12:00', 'America/New_York')!;
  assert.equal(new Date(summer * 1000).toISOString(), '2026-07-15T16:00:00.000Z');
  const winter = wallTimeToUtcSeconds('2026-01-15T12:00', 'America/New_York')!;
  assert.equal(new Date(winter * 1000).toISOString(), '2026-01-15T17:00:00.000Z');
});

test('换算后显示成北京时间 —— 这是这个功能的全部意义', () => {
  // NFT 项目常按美东公告：mint 在 2026-07-15 12:00 ET
  const ts = wallTimeToUtcSeconds('2026-07-15T12:00', 'America/New_York')!;
  // 对应北京时间 2026-07-16 00:00
  assert.equal(formatInZone(ts, 'Asia/Shanghai'), '2026-07-16 00:00');
});

test('往返一致', () => {
  for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/Berlin']) {
    const ts = wallTimeToUtcSeconds('2026-09-03T20:00', tz)!;
    assert.equal(formatInZone(ts, tz), '2026-09-03 20:00', `${tz} 往返应一致`);
  }
});

test('偏移展示', () => {
  const july = Date.UTC(2026, 6, 15) / 1000;
  const jan = Date.UTC(2026, 0, 15) / 1000;
  assert.equal(zoneAbbr('Asia/Shanghai', july), 'UTC+8');
  assert.equal(zoneAbbr('Europe/Berlin', july), 'UTC+2');
  assert.equal(zoneAbbr('Europe/Berlin', jan), 'UTC+1');
  assert.equal(zoneAbbr('America/New_York', july), 'UTC-4');
});

test('非法输入返回 null，不抛错', () => {
  assert.equal(wallTimeToUtcSeconds('乱七八糟', 'UTC'), null);
  assert.equal(wallTimeToUtcSeconds('', 'UTC'), null);
});

test('时区列表全部合法', () => {
  for (const t of TIMEZONES) assert.ok(isValidTimezone(t.value), `${t.value} 应合法`);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
});

test('倒计时文案', () => {
  const now = 1_800_000_000;
  assert.equal(humanUntil(now + 3 * 86400, now), '还有 3 天');
  assert.equal(humanUntil(now + 7200, now), '还有 2 小时');
  assert.equal(humanUntil(now - 86400, now), '已过去 1 天');
});
