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

const recent = (at: number, level: number) => ({ at, level });

test('30 分钟内同档已报过就压制', () => {
  assert.equal(DEDUP_WINDOW_SECONDS, 1800);
  assert.equal(suppressedByRecent(recent(1000, 2), 1000 + 1799, 2), true);
  assert.equal(suppressedByRecent(recent(1000, 2), 1000 + 1800, 2), false, '满 30 分钟应放行');
  assert.equal(suppressedByRecent(null, 999999, 2), false, '从没报过不压制');
});

test('更高的档位不受去重窗口限制 —— PICKLES 那次就是这么丢的', () => {
  // 2026-09-04：04:34 报了 2 倍档，04:48 穿 5 倍、05:03 穿 10 倍，
  // 两条都落在压制窗口里一条没发；而状态机已经把这两档置成 FIRED，
  // 于是永久消耗掉 —— 不是延迟，是再也不会报了
  const twoX = recent(1000, 2);
  assert.equal(suppressedByRecent(twoX, 1000 + 840, 5), false, '5 倍档比 2 倍高，要放行');
  assert.equal(suppressedByRecent(twoX, 1000 + 1740, 10), false, '10 倍档更要放行');
});

test('同档或更低的仍然压制 —— 那才是"同一件事反复说"', () => {
  const tenX = recent(1000, 10);
  assert.equal(suppressedByRecent(tenX, 1000 + 60, 10), true, '同档重复');
  assert.equal(suppressedByRecent(tenX, 1000 + 60, 5), true, '已经报过 10 倍了，5 倍不算新消息');
  assert.equal(suppressedByRecent(tenX, 1000 + 60, 2), true);
});

test('窗口过后连更低的档位也放行', () => {
  const tenX = recent(1000, 10);
  assert.equal(suppressedByRecent(tenX, 1000 + 1800, 2), false);
});

test('倍数并列时选更高的档位 —— 冲到 11 倍不该被标成「2x 档」', () => {
  // 同一个窗口的 2/5/10 三档算出来的 multiple 完全一样（倍数是窗口的属性，
  // 不是档位的），原先只比倍数就三档并列，随便挑一个
  const w = pickWinner([
    { tokenId: 't', timeframe: '6h', basis: 'low', level: 2,  multiple: new Decimal('11'), at: 0 },
    { tokenId: 't', timeframe: '6h', basis: 'low', level: 10, multiple: new Decimal('11'), at: 0 },
    { tokenId: 't', timeframe: '6h', basis: 'low', level: 5,  multiple: new Decimal('11'), at: 0 },
  ])!;
  assert.equal(w.level, 10);
});

test('倍数更大的仍然优先于档位更高的', () => {
  const w = pickWinner([
    { tokenId: 't', timeframe: '6h', basis: 'low', level: 10, multiple: new Decimal('10'), at: 0 },
    { tokenId: 't', timeframe: '5m', basis: 'low', level: 2,  multiple: new Decimal('50'), at: 0 },
  ])!;
  assert.equal(w.multiple.toString(), '50');
});

test('倍数与档位都并列时，窗口短的优先', () => {
  const w = pickWinner([
    { tokenId: 't', timeframe: '24h', basis: 'low', level: 2, multiple: new Decimal('3'), at: 0 },
    { tokenId: 't', timeframe: '5m',  basis: 'low', level: 2, multiple: new Decimal('3'), at: 0 },
  ])!;
  assert.equal(w.timeframe, '5m', '5 分钟涨 3 倍比 24 小时涨 3 倍更值得说');
});
