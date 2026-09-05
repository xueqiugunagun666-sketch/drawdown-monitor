import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { isWakeUp, wakeUpLevel, WOKE_UP_AFTER_SECONDS } from './wakeUp.ts';

const NOW = 1_788_600_000;
const LEVELS = [2, 3, 5, 10] as const;

test('刚扫到的持仓算新加钱包，不补报', () => {
  // 新加一个钱包，里面一堆早就涨过的币 —— 不该炸一串历史报警
  assert.equal(isWakeUp(NOW, NOW), false);
  assert.equal(isWakeUp(NOW - 600, NOW), false);
  assert.equal(isWakeUp(NOW - WOKE_UP_AFTER_SECONDS + 1, NOW), false);
});

test('待了一阵子的持仓首次进监控 = 沉睡的币醒了，该补报', () => {
  // KANSO：持仓自 8-30 就在，9-06 拉盘才被纳入监控
  assert.equal(isWakeUp(NOW - WOKE_UP_AFTER_SECONDS, NOW), true);
  assert.equal(isWakeUp(NOW - 7 * 86400, NOW), true);
});

test('没有首次时刻就不补报 —— 拿不准就用保守的那条', () => {
  assert.equal(isWakeUp(null, NOW), false);
});

test('报已达到的最高档，不是最低档', () => {
  // 进来就 3.55 倍，说它"涨了 2 倍"是把信息说小了
  assert.equal(wakeUpLevel(new Decimal('3.55'), LEVELS), 3);
  assert.equal(wakeUpLevel(new Decimal('8.64'), LEVELS), 5);
  assert.equal(wakeUpLevel(new Decimal('15'), LEVELS), 10);
});

test('正好等于档位算达到', () => {
  assert.equal(wakeUpLevel(new Decimal('2'), LEVELS), 2);
  assert.equal(wakeUpLevel(new Decimal('1.99'), LEVELS), null);
});

test('连最低档都没到就返回 null，按普通冷启动静默处理', () => {
  assert.equal(wakeUpLevel(new Decimal('1.5'), LEVELS), null);
  assert.equal(wakeUpLevel(new Decimal('1'), LEVELS), null);
});
