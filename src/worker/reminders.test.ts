import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ddm-rem-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CONFIG_PATH = './config.default.json';

const { runMigrations } = await import('../db/migrate.ts');
const repo = await import('../db/repo.ts');
const { dueReminders, confirmSent, buildReminderMessage } = await import('./reminders.ts');
const { wallTimeToUtcSeconds } = await import('../lib/timezone.ts');

const NOW = 1_800_000_000;

function mkEvent(id: string, atTs: number, offsets: number[], extra: Record<string, unknown> = {}) {
  repo.upsertEvent({
    id, title: `事件${id}`, atTs, inputTz: 'Asia/Shanghai',
    category: 'mint', priority: 'normal', note: null, links: null,
    remindOffsets: JSON.stringify(offsets), remindedOffsets: null,
    createdBy: '老王', createdAt: NOW, enabled: 1, ...extra,
  });
  return repo.getEvent(id)!;
}

before(() => runMigrations());
after(() => rmSync(dir, { recursive: true, force: true }));

test('时间未到不提醒', () => {
  mkEvent('a', NOW + 7200, [60, 0]);
  assert.equal(dueReminders(NOW).length, 0, '还有 2 小时，提前 60 分钟的点还没到');
});

test('到点触发，且只触发该提醒点', () => {
  repo.deleteEvent('a');
  mkEvent('b', NOW + 3600, [1440, 60, 0]);
  const due = dueReminders(NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.offset, 60, '此刻正好是「提前 60 分钟」');
});

test('发过的不再发', () => {
  const e = repo.getEvent('b')!;
  confirmSent(e, 60);
  assert.equal(dueReminders(NOW).length, 0);
});

test('多个提醒点分别独立触发', () => {
  repo.deleteEvent('b');
  const e = mkEvent('c', NOW + 60, [60, 0]);
  // 此刻距事件 1 分钟：60 分钟前那个点早过了但在容忍窗口外？——它是 59 分钟前，超过 30 分钟容忍
  const due = dueReminders(NOW);
  assert.equal(due.length, 0, '提前 60 分钟那个点已过期 59 分钟，应跳过不补推');
  // 到点后触发 offset=0
  const due2 = dueReminders(NOW + 60);
  assert.equal(due2.length, 1);
  assert.equal(due2[0]!.offset, 0);
  assert.ok(e);
});

test('过期太久的提醒被标记为已发但不推送', () => {
  repo.deleteEvent('c');
  mkEvent('d', NOW - 7200, [0]);   // 事件在 2 小时前
  assert.equal(dueReminders(NOW).length, 0, '错过的 mint 时间点事后补推没有价值');
  // 且已被标记，下次不会重复处理
  const after1 = repo.getEvent('d')!;
  assert.deepEqual(JSON.parse(after1.remindedOffsets ?? '[]'), [0]);
});

test('消息内容：北京时间 + 原始时区 + 链接 + 署名', () => {
  repo.deleteEvent('d');
  // 项目按美东公告 mint 时间
  const at = wallTimeToUtcSeconds('2026-07-15T12:00', 'America/New_York')!;
  const e = mkEvent('e', at, [60], {
    title: 'Foo NFT 公售',
    inputTz: 'America/New_York',
    priority: 'high',
    note: '白名单已拿到',
    links: JSON.stringify([
      { label: 'X', url: 'https://x.com/foo' },
      { label: 'OpenSea', url: 'https://opensea.io/collection/foo' },
    ]),
  });
  const msg = buildReminderMessage(e, 60, at - 3600);
  assert.match(msg, /\[重要\] Foo NFT 公售/);
  assert.match(msg, /2026-07-16 00:00  北京时间/, '必须换算成北京时间');
  assert.match(msg, /2026-07-15 12:00  America\/New_York/, '保留原始时区便于核对公告');
  assert.match(msg, /还有 1 小时/);
  assert.match(msg, /白名单已拿到/);
  assert.match(msg, /X: https:\/\/x\.com\/foo/);
  assert.match(msg, /OpenSea: https:\/\/opensea\.io/);
  assert.match(msg, /由 老王 添加/);
});

test('停用的事件不提醒', () => {
  repo.deleteEvent('e');
  mkEvent('f', NOW + 60, [0], { enabled: 0 });
  assert.equal(dueReminders(NOW + 60).length, 0);
});
