import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { evaluate, initialState, seedState, type EvalParams, type StateSnapshot } from './stateMachine.ts';

const base = (over: Partial<EvalParams> = {}): EvalParams => ({
  drawdown: new Decimal(85), price: new Decimal('0.001'), liquidityTotal: 100000,
  level: 80, confirmTicks: 2, hysteresis: 15, rearmMinutes: 60,
  minLiquidityUsd: 5000, cooldownMinutes: 30, lastAnyFiredAt: null, now: 1_000_000,
  ...over,
});

test('需连续 confirm_ticks 次才触发', () => {
  let st: StateSnapshot = initialState();
  let r = evaluate(st, base());
  assert.equal(r.fire, false);
  assert.equal(r.blockedBy, 'confirming');
  assert.equal(r.next.hitCount, 1);

  r = evaluate(r.next, base({ now: 1_000_030 }));
  assert.equal(r.fire, true);
  assert.equal(r.next.state, 'FIRED');
  assert.equal(r.next.localLow?.toString(), '0.001');
});

test('中途回落会清零确认计数', () => {
  let r = evaluate(initialState(), base());
  assert.equal(r.next.hitCount, 1);
  r = evaluate(r.next, base({ drawdown: new Decimal(70) }));
  assert.equal(r.next.hitCount, 0);
  assert.equal(r.fire, false);
});

test('流动性不足时不触发，且给出原因', () => {
  let r = evaluate(initialState(), base({ liquidityTotal: 1000 }));
  assert.equal(r.fire, false);
  assert.equal(r.blockedBy, 'liquidity');
  r = evaluate(r.next, base({ liquidityTotal: 1000, now: 1_000_030 }));
  assert.equal(r.fire, false);
});

test('cooldown 内不触发，但保留确认计数，结束后立刻触发', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030, lastAnyFiredAt: 1_000_000 }));
  assert.equal(r.fire, false);
  assert.equal(r.blockedBy, 'cooldown');
  assert.equal(r.next.hitCount, 2, 'cooldown 不应清零确认计数');

  // cooldown 结束（30 分钟后）
  r = evaluate(r.next, base({ now: 1_000_000 + 31 * 60, lastAnyFiredAt: 1_000_000 }));
  assert.equal(r.fire, true);
});

test('FIRED 后不重复触发', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030 }));
  assert.equal(r.fire, true);
  for (let i = 0; i < 10; i++) {
    r = evaluate(r.next, base({ now: 1_000_060 + i * 30 }));
    assert.equal(r.fire, false, '不得重复刷屏');
  }
});

test('局部低点持续追踪（供 bounce）', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030 }));
  r = evaluate(r.next, base({ now: 1_000_060, price: new Decimal('0.0008') }));
  assert.equal(r.next.localLow?.toString(), '0.0008');
  r = evaluate(r.next, base({ now: 1_000_090, price: new Decimal('0.0009') }));
  assert.equal(r.next.localLow?.toString(), '0.0008', '低点不应被回升覆盖');
});

test('重新武装需回落超过 hysteresis 且持续 rearm_minutes', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030 }));
  assert.equal(r.next.state, 'FIRED');

  // 回撤降到 64%（<= 80-15），开始计时但未满 60 分钟
  r = evaluate(r.next, base({ now: 1_000_060, drawdown: new Decimal(64) }));
  assert.equal(r.next.state, 'FIRED');
  assert.equal(r.next.rearmSinceTs, 1_000_060);

  r = evaluate(r.next, base({ now: 1_000_060 + 59 * 60, drawdown: new Decimal(64) }));
  assert.equal(r.next.state, 'FIRED', '未满 rearm_minutes 不得武装');

  r = evaluate(r.next, base({ now: 1_000_060 + 60 * 60, drawdown: new Decimal(64) }));
  assert.equal(r.next.state, 'ARMED');
  assert.equal(r.next.hitCount, 0);
});

test('回落未超过 hysteresis 不重新武装（迟滞带内）', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030 }));
  // 70% 在 [65, 80) 迟滞带内
  r = evaluate(r.next, base({ now: 1_000_060, drawdown: new Decimal(70) }));
  assert.equal(r.next.rearmSinceTs, null);
  r = evaluate(r.next, base({ now: 1_000_060 + 3600 * 5, drawdown: new Decimal(70) }));
  assert.equal(r.next.state, 'FIRED');
});

test('重新武装计时被中断后需重新累计', () => {
  let r = evaluate(initialState(), base());
  r = evaluate(r.next, base({ now: 1_000_030 }));
  r = evaluate(r.next, base({ now: 1_000_060, drawdown: new Decimal(64) }));
  // 中途反弹回 82%，打断计时
  r = evaluate(r.next, base({ now: 1_000_060 + 30 * 60, drawdown: new Decimal(82) }));
  assert.equal(r.next.rearmSinceTs, null);
  // 再次回落，计时从头开始
  r = evaluate(r.next, base({ now: 1_000_060 + 31 * 60, drawdown: new Decimal(64) }));
  assert.equal(r.next.rearmSinceTs, 1_000_060 + 31 * 60);
});

test('阈值边界：79.98 / 80.02 不因浮点抖动', () => {
  const st = initialState();
  assert.equal(evaluate(st, base({ drawdown: new Decimal('79.98') })).next.hitCount, 0);
  assert.equal(evaluate(st, base({ drawdown: new Decimal('80.00') })).next.hitCount, 1);
  assert.equal(evaluate(st, base({ drawdown: new Decimal('80.02') })).next.hitCount, 1);
});

test('新加入时已跌破的档位不追溯报警', () => {
  // 加一个已经 -91% 的币：70/80/85/90 四档都满足条件
  const dd = new Decimal(91);
  const price = new Decimal('0.001');
  for (const level of [70, 80, 85, 90]) {
    const s = seedState(dd, level, price, 1_000_000);
    assert.equal(s.state, 'FIRED', `${level}% 档应视为加入前已触发`);
    assert.equal(s.lastFiredAt, null, '并未真的推送过，不应占用 cooldown 配额');
    assert.equal(s.localLow?.toString(), '0.001', '应开始追踪局部低点');
  }
  // 95 档尚未跌破，正常武装
  const s95 = seedState(dd, 95, price, 1_000_000);
  assert.equal(s95.state, 'ARMED');
});

test('被 seed 成 FIRED 的档位不会立刻推送', () => {
  const dd = new Decimal(91);
  const price = new Decimal('0.001');
  const st = seedState(dd, 80, price, 1_000_000);
  for (let i = 0; i < 10; i++) {
    const r = evaluate(st, base({ drawdown: dd, price, now: 1_000_000 + i * 30 }));
    assert.equal(r.fire, false, '加入前就跌破的档位不该报警');
  }
});

test('seed 成 FIRED 后，回升越过迟滞带再跌破会正常报警', () => {
  const price = new Decimal('0.001');
  let st = seedState(new Decimal(91), 80, price, 1_000_000);
  assert.equal(st.state, 'FIRED');

  // 回升到 -60%（<= 80-15），持续满 rearm_minutes 后重新武装
  let r = evaluate(st, base({ drawdown: new Decimal(60), now: 1_000_100 }));
  r = evaluate(r.next, base({ drawdown: new Decimal(60), now: 1_000_100 + 3600 }));
  assert.equal(r.next.state, 'ARMED', '回升够久应重新武装');

  // 再次跌破，连续两次确认后触发 —— 这才是新信息
  r = evaluate(r.next, base({ drawdown: new Decimal(85), now: 1_000_100 + 3700 }));
  assert.equal(r.fire, false, '第一次只确认');
  r = evaluate(r.next, base({ drawdown: new Decimal(85), now: 1_000_100 + 3730 }));
  assert.equal(r.fire, true, '第二次确认后应正常报警');
});
