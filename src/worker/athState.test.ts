import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  evaluateAth, seedAthState, initialAthState,
  BREAKOUT_MARGIN, REARM_RATIO, ADVANCE_RATIO,
  type AthSnapshot,
} from './athState.ts';

const d = (s: string | number) => new Decimal(s);
const run = (prev: AthSnapshot, price: string | number, ath: string | number | null) =>
  evaluateAth(prev, { price: d(price), ath: ath === null ? null : d(ath) });

test('参数就是 10% / 0.8 / 1.5', () => {
  assert.equal(BREAKOUT_MARGIN, 0.10);
  assert.equal(REARM_RATIO, 0.8);
  assert.equal(ADVANCE_RATIO, 1.5);
});

test('超过 ATH 但不够 10% 不算突破 —— 挡掉贴着高点来回蹭', () => {
  assert.equal(run(initialAthState(), 105, 100).fire, null);
  assert.equal(run(initialAthState(), 110, 100).fire, null, '正好 10% 也不算，要真的超过');
  assert.equal(run(initialAthState(), 110.01, 100).fire, 'breakout');
});

test('单调上涨全程只报一次 —— 这是把 60 条压成 1 条的那一步', () => {
  let s = initialAthState();
  let ath = d(100);
  const fires: (string | null)[] = [];
  // 从 100 一路涨到 145，每次涨一点
  for (const p of [111, 115, 120, 125, 130, 135, 140, 145]) {
    const r = evaluateAth(s, { price: d(p), ath });
    fires.push(r.fire);
    s = r.next;
    if (r.newAth) ath = r.newAth;
  }
  assert.deepEqual(fires, ['breakout', null, null, null, null, null, null, null]);
});

test('涨够 1.5 倍才补一条', () => {
  let s = initialAthState();
  let ath = d(100);
  const step = (p: number) => {
    const r = evaluateAth(s, { price: d(p), ath });
    s = r.next; if (r.newAth) ath = r.newAth;
    return r.fire;
  };
  assert.equal(step(120), 'breakout');          // 报警价 120
  assert.equal(step(160), null, '比 120 涨 33%，不够');
  assert.equal(step(180), 'advance', '比 120 涨 50%，补一条');
  assert.equal(step(250), null, '比 180 涨 39%，不够');
  assert.equal(step(270), 'advance', '比 180 涨 50%');
});

test('ATH 跟着涨，即使没报警 —— 它是事实，与报不报无关', () => {
  const r = evaluateAth({ state: 'FIRED', lastAlertPrice: d(120), refAth: d(100) }, { price: d(150), ath: d(120) });
  assert.equal(r.fire, null, '没涨够补报线');
  assert.equal(r.newAth!.toString(), '150', 'ATH 仍要更新');
});

test('门槛之内创新高也要更新 ATH', () => {
  const r = run(initialAthState(), 105, 100);
  assert.equal(r.fire, null);
  assert.equal(r.newAth!.toString(), '105');
});

test('没创新高时 newAth 是 null，不要白写一次库', () => {
  assert.equal(run(initialAthState(), 90, 100).newAth, null);
});

test('回落到 ATH 的 80% 以下才重新武装', () => {
  const fired: AthSnapshot = { state: 'FIRED', lastAlertPrice: d(120), refAth: d(100) };
  assert.equal(run(fired, 85, 100).next.state, 'FIRED', '滞回区内不重新武装');
  assert.equal(run(fired, 80, 100).next.state, 'FIRED', '正好 80% 也还不算');
  assert.equal(run(fired, 79, 100).next.state, 'ARMED');
});

test('重新武装本身不报警，之后再突破才报', () => {
  const fired: AthSnapshot = { state: 'FIRED', lastAlertPrice: d(120), refAth: d(100) };
  const rearmed = run(fired, 70, 100);
  assert.equal(rearmed.fire, null);
  assert.equal(rearmed.next.lastAlertPrice, null, '重新武装要清掉上次报警价');
  assert.equal(run(rearmed.next, 111, 100).fire, 'breakout');
});

test('在门槛附近抖动不会反复触发 —— 滞回的全部意义', () => {
  let s = initialAthState();
  let ath = d(100);
  let count = 0;
  for (const p of [111, 105, 112, 106, 113, 104, 115]) {
    const r = evaluateAth(s, { price: d(p), ath });
    if (r.fire) count++;
    s = r.next; if (r.newAth) ath = r.newAth;
  }
  assert.equal(count, 1, '只该报第一次突破');
});

test('还不知道 ATH 时什么都不做 —— 没有基准，"突破"无从谈起', () => {
  const r = run(initialAthState(), 999, null);
  assert.equal(r.fire, null);
  assert.equal(r.newAth, null);
  assert.equal(run(initialAthState(), 999, 0).fire, null, 'ATH 为 0 同理');
});

test('冷启动：已经在 ATH 之上的直接置 FIRED，不补报历史', () => {
  const s = seedAthState(d(200), d(100));
  assert.equal(s.state, 'FIRED');
  assert.equal(s.lastAlertPrice!.toString(), '200');
  // 紧接着的一轮不该报
  assert.equal(evaluateAth(s, { price: d(210), ath: d(200) }).fire, null);
});

test('冷启动：在 ATH 之下的保持 ARMED，之后突破会正常报', () => {
  const s = seedAthState(d(50), d(100));
  assert.equal(s.state, 'ARMED');
  assert.equal(evaluateAth(s, { price: d(111), ath: d(100) }).fire, 'breakout');
});

test('冷启动时还没有 ATH 就按 ARMED 处理', () => {
  assert.deepEqual(seedAthState(d(50), null), initialAthState());
});

test('回归：补报不能压在突破门槛后面', () => {
  // 第一版的 bug：突破后 ATH 就等于当前价，price > ath×1.1 要求一轮内
  // 跳涨 10%，平滑上涨里补报分支根本走不到
  let s = initialAthState();
  let ath = d(100);
  const fires: (string | null)[] = [];
  for (const p of [111, 125, 140, 155, 170, 185]) {   // 每步涨 ~11%，不是单轮跳涨
    const r = evaluateAth(s, { price: d(p), ath });
    fires.push(r.fire);
    s = r.next; if (r.newAth) ath = r.newAth;
  }
  // 111 突破；之后涨到 ≥111×1.5=166.5 时补一条
  assert.deepEqual(fires, ['breakout', null, null, null, 'advance', null]);
});

test('回归：从高点回撤不能被当成补报', () => {
  // ATH 长到 1000、上次报警价还是 120，价格跌到 700 —— 那是回撤 30%，
  // 却"比 120 涨了 483%"。必须先判重新武装
  const r = evaluateAth({ state: 'FIRED', lastAlertPrice: d(120), refAth: d(100) },
    { price: d(700), ath: d(1000) });
  assert.equal(r.fire, null, '这是回撤，不是补报');
  assert.equal(r.next.state, 'ARMED');
});

test('一波三倍行情大约 2~3 条，不是几十条', () => {
  let s = initialAthState();
  let ath = d(100);
  let n = 0;
  // 从 100 平滑涨到 330，每轮涨 3%
  let p = d(100);
  for (let i = 0; i < 42; i++) {
    p = p.mul('1.03');
    const r = evaluateAth(s, { price: p, ath });
    if (r.fire) n++;
    s = r.next; if (r.newAth) ath = r.newAth;
  }
  assert.ok(p.gt(330), `最终 ${p.toFixed(0)}`);
  assert.ok(n >= 2 && n <= 3, `报了 ${n} 条`);
});
