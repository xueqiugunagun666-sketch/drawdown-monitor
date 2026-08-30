import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  LEVELS, REARM_RATIO, DEDUP_WINDOW_SECONDS,
  initialPumpState, seedPumpState, evaluatePump, pickWinner, suppressedByRecent,
  type PendingFire,
} from './pumpState.ts';

const d = (s: string | number) => new Decimal(s);

test('档位就是 2 / 5 / 10', () => {
  assert.deepEqual([...LEVELS], [2, 5, 10]);
});

test('ARMED 状态下达到档位就触发', () => {
  const r = evaluatePump(initialPumpState(), { multiple: d(2), level: 2, now: 100 });
  assert.equal(r.fire, true);
  assert.equal(r.next.state, 'FIRED');
  assert.equal(r.next.lastFiredAt, 100);
});

test('差一点点不触发', () => {
  const r = evaluatePump(initialPumpState(), { multiple: d('1.999'), level: 2, now: 100 });
  assert.equal(r.fire, false);
  assert.equal(r.next.state, 'ARMED');
});

test('已 FIRED 时继续在高位不重复触发', () => {
  let s = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  for (let t = 200; t < 4000; t += 100) {
    const r = evaluatePump(s, { multiple: d(3), level: 2, now: t });
    assert.equal(r.fire, false, `t=${t} 不该重复触发`);
    s = r.next;
  }
});

test('回落到档位 80% 以上不重新武装（滞回区内）', () => {
  const fired = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  assert.equal(evaluatePump(fired, { multiple: d('1.9'), level: 2, now: 200 }).next.state, 'FIRED');
  assert.equal(evaluatePump(fired, { multiple: d('1.6'), level: 2, now: 200 }).next.state, 'FIRED',
    '正好等于 80% 仍在滞回区内');
});

test('回落到档位 80% 以下才重新武装，且重新武装本身不触发', () => {
  const fired = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  const r = evaluatePump(fired, { multiple: d('1.5'), level: 2, now: 200 });
  assert.equal(r.fire, false);
  assert.equal(r.next.state, 'ARMED');
});

test('重新武装后再涨上去会再次触发', () => {
  let s = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  s = evaluatePump(s, { multiple: d('1.5'), level: 2, now: 200 }).next;
  assert.equal(evaluatePump(s, { multiple: d('2.1'), level: 2, now: 300 }).fire, true);
});

test('在档位附近抖动不会反复触发 —— 滞回的全部意义', () => {
  let s = initialPumpState();
  let fires = 0;
  // 在 1.95 ~ 2.05 之间来回震荡 50 次
  for (let i = 0; i < 50; i++) {
    const m = i % 2 === 0 ? d('2.05') : d('1.95');
    const r = evaluatePump(s, { multiple: m, level: 2, now: 100 + i });
    if (r.fire) fires++;
    s = r.next;
  }
  assert.equal(fires, 1, `震荡 50 次只该触发 1 次，实际 ${fires} 次`);
});

test('REARM_RATIO 就是 0.8', () => {
  assert.equal(REARM_RATIO, 0.8);
});

// ---- 冷启动 seed ----

test('新币首次进入监控时已在 6 倍：2x 与 5x 直接置 FIRED，不补报', () => {
  assert.equal(seedPumpState(d(6), 2).state, 'FIRED');
  assert.equal(seedPumpState(d(6), 5).state, 'FIRED');
  assert.equal(seedPumpState(d(6), 10).state, 'ARMED');
});

test('seed 出来的 FIRED 不带 lastFiredAt —— 它从没真的报过', () => {
  assert.equal(seedPumpState(d(6), 2).lastFiredAt, null);
});

test('seed 成 ARMED 的档位涨上去仍会触发', () => {
  const s = seedPumpState(d(6), 10);
  assert.equal(evaluatePump(s, { multiple: d(11), level: 10, now: 100 }).fire, true,
    '这正是 seed 的目的：不补报旧的，但新的要报');
});

test('回归：已经在 6 倍的币加入后，一次 tick 不产生任何报警', () => {
  // 对应 commit 6699db0 那个"新代币连推 75/80/85"的反向情形
  const fires = LEVELS.map((level) => {
    const s = seedPumpState(d(6), level);
    return evaluatePump(s, { multiple: d(6), level, now: 100 }).fire;
  });
  assert.deepEqual(fires, [false, false, false]);
});

test('seed 后价格继续涨，只有更高的档位会报', () => {
  const states = LEVELS.map((level) => ({ level, s: seedPumpState(d(6), level) }));
  const fires = states.map(({ level, s }) => evaluatePump(s, { multiple: d(12), level, now: 200 }).fire);
  assert.deepEqual(fires, [false, false, true], '只有 10x 档该报');
});

// ---- 去重择优 ----

const fire = (tf: PendingFire['timeframe'], mult: string, level = 2): PendingFire => ({
  tokenId: 't', timeframe: tf, basis: 'low', level, multiple: d(mult), at: 100,
});

test('多条触发里取倍数最高的', () => {
  const w = pickWinner([fire('24h', '3'), fire('1h', '7'), fire('5m', '4')])!;
  assert.equal(w.multiple.toString(), '7');
  assert.equal(w.timeframe, '1h');
});

test('倍数相同时取窗口更短的', () => {
  // 5 分钟涨 2 倍比 24 小时涨 2 倍更值得看
  assert.equal(pickWinner([fire('24h', '5'), fire('5m', '5'), fire('6h', '5')])!.timeframe, '5m');
});

test('单条时原样返回', () => {
  assert.equal(pickWinner([fire('6h', '3')])!.timeframe, '6h');
});

test('空数组返回 null', () => {
  assert.equal(pickWinner([]), null);
});

test('极小倍数差也能正确比较，不因浮点退化', () => {
  const w = pickWinner([fire('5m', '2.0000000000001'), fire('1h', '2.0000000000002')])!;
  assert.equal(w.timeframe, '1h', '第二条更大，即使只差 1e-13');
});

test('30 分钟内已报过就压制', () => {
  assert.equal(DEDUP_WINDOW_SECONDS, 1800);
  assert.equal(suppressedByRecent(1000, 1000 + 1799), true);
  assert.equal(suppressedByRecent(1000, 1000 + 1800), false, '满 30 分钟应放行');
  assert.equal(suppressedByRecent(null, 999999), false, '从没报过不压制');
});
