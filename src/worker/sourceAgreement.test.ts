import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareQuotes, judge, PRICE_TOLERANCE, MIN_AGREEMENT_RATE } from './sourceAgreement.ts';

const m = (o: Record<string, string>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, { priceUsd: v }]));

test('价格接近算一致 —— 采样时刻不同本来就有小差', () => {
  const r = compareQuotes(m({ a: '1', b: '2' }), m({ a: '1.05', b: '1.9' }));
  assert.equal(r.compared, 2);
  assert.equal(r.agreed, 2);
  assert.equal(r.rate, 1);
});

test('超出容差算不一致，并记下偏离最大的几个', () => {
  const r = compareQuotes(m({ a: '1', b: '1', c: '1' }), m({ a: '1', b: '5', c: '100' }));
  assert.equal(r.agreed, 1);
  assert.equal(r.worst[0]!.key, 'c', '最离谱的排在前面');
  assert.equal(r.worst[0]!.ratio, 100);
});

test('新源缺的币单独计数，不算成不一致', () => {
  // 缺数据和数据错是两种问题，混在一起会掩盖真正的口径错误
  const r = compareQuotes(m({ a: '1', b: '1' }), m({ a: '1' }));
  assert.equal(r.compared, 1);
  assert.equal(r.missingInB, 1);
  assert.equal(r.rate, 1);
});

test('没有可比的币时一致率是 null，不是 0', () => {
  // 当成 0% 会在"这一轮恰好没有重叠"时误报源已损坏
  const r = compareQuotes(m({}), m({}));
  assert.equal(r.rate, null);
  assert.equal(judge(r, 0).ok, true);
});

test('非法或非正价格跳过，不参与统计', () => {
  const r = compareQuotes(m({ a: '0', b: '乱写', c: '1' }), m({ a: '1', b: '1', c: '1' }));
  assert.equal(r.compared, 1);
});

test('容差就是 1.10', () => {
  assert.equal(PRICE_TOLERANCE, 1.10);
  assert.equal(compareQuotes(m({ a: '1' }), m({ a: '1.10' })).agreed, 1);
  assert.equal(compareQuotes(m({ a: '1' }), m({ a: '1.11' })).agreed, 0);
});

/* ---------- 判定 ---------- */

test('一致率掉到九成以下判为坏了', () => {
  const r = compareQuotes(
    m({ a: '1', b: '1', c: '1', d: '1', e: '1', f: '1', g: '1', h: '1', i: '1', j: '1' }),
    m({ a: '1', b: '1', c: '1', d: '1', e: '1', f: '1', g: '1', h: '1', i: '50', j: '50' }));
  const v = judge(r, 10);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /一致率/);
  assert.equal(MIN_AGREEMENT_RATE, 0.9);
});

test('大面积缺数据也算坏了 —— 它照样返回 200，只是里面空的', () => {
  const r = compareQuotes(m({ a: '1', b: '1', c: '1', d: '1' }), m({ a: '1' }));
  const v = judge(r, 4);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /覆盖率/);
});

test('都正常时判定通过', () => {
  const r = compareQuotes(m({ a: '1', b: '2' }), m({ a: '1', b: '2' }));
  assert.equal(judge(r, 2).ok, true);
  assert.equal(judge(r, 2).reason, null);
});

test('预期数为 0 时不判定 —— 没有样本就没有结论', () => {
  assert.equal(judge(compareQuotes(m({}), m({})), 0).ok, true);
});
