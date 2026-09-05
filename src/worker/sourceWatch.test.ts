process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'pananiu';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import * as wr from '../db/walletRepo.ts';
import {
  recordVerdict, resetWatchState, FAIL_STREAK_BEFORE_ALERT, REALERT_SECONDS,
} from './sourceWatch.ts';

before(() => { runMigrations(); });

let admin = '', normal = '';
beforeEach(() => {
  resetWatchState();
  if (!admin) {
    admin = wr.createUser('pananiu', 'h')!.id;
    normal = wr.createUser('someoneelse', 'h')!.id;
  }
});

const NOW = 1_788_600_000;
const bad = { ok: false, reason: '价格一致率 40%' };
const good = { ok: true, reason: null };
const alerts = (uid: string) =>
  wr.listPumpAlerts(uid, 0).filter((a) => a.kind === 'source-down');

test('单轮不合格不报警 —— 很可能只是两个源采样时刻错开', () => {
  const before0 = alerts(admin).length;
  recordVerdict('xxyy', bad, NOW, '重叠 100/200');
  assert.equal(alerts(admin).length, before0);
});

test('连续多轮不合格才报给管理员', () => {
  const before0 = alerts(admin).length;
  for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT; i++) {
    recordVerdict('xxyy', bad, NOW + i, '重叠 100/200');
  }
  assert.equal(alerts(admin).length, before0 + 1, `第 ${FAIL_STREAK_BEFORE_ALERT} 轮才报`);
});

test('只发给管理员，普通用户收不到', () => {
  for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT; i++) recordVerdict('xxyy', bad, NOW + i, 'x');
  assert.equal(alerts(normal).length, 0);
});

test('中间恢复一次就重新计数', () => {
  const before0 = alerts(admin).length;
  for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT - 1; i++) recordVerdict('xxyy', bad, NOW + i, 'x');
  recordVerdict('xxyy', good, NOW + 10, 'x');            // 恢复
  for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT - 1; i++) recordVerdict('xxyy', bad, NOW + 20 + i, 'x');
  assert.equal(alerts(admin).length, before0, '两次都没连够，不该报');
});

test('一直坏着不刷屏，隔够久才再报一次', () => {
  const fire = (t: number) => {
    for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT; i++) recordVerdict('xxyy', bad, t + i, 'x');
  };
  const before0 = alerts(admin).length;
  fire(NOW);
  assert.equal(alerts(admin).length, before0 + 1);
  fire(NOW + 100);                                        // 仍在冷却期
  assert.equal(alerts(admin).length, before0 + 1);
  fire(NOW + REALERT_SECONDS);
  assert.equal(alerts(admin).length, before0 + 2);
});

test('报警行标成系统消息，不是行情', () => {
  for (let i = 0; i < FAIL_STREAK_BEFORE_ALERT; i++) recordVerdict('xxyy', bad, NOW + i, 'x');
  const a = alerts(admin)[0]!;
  assert.equal(a.kind, 'source-down');
  assert.equal(a.tokenId, 'system:xxyy');
  assert.equal(a.priceUsd, null, '系统消息没有价格');
  assert.equal(a.valueUsd, null);
});
