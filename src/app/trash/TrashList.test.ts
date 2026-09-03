import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, parseSources, drawdownText } from './TrashList.tsx';

test('市值按量级缩写 —— 这一栏的数字是拿来互相比较的', () => {
  assert.equal(money(1_605_902.8), '$1.61M');
  assert.equal(money(316_699.25), '$316.7K');
  assert.equal(money(1000), '$1.0K');
  assert.equal(money(842), '$842');
});

test('市值缺失显示破折号，不显示 $0', () => {
  // $0 会被读成"归零了"，而实际是"没拿到数据"，两者天差地别
  assert.equal(money(null), '—');
  assert.equal(money(Number.NaN), '—');
  assert.equal(money(Number.POSITIVE_INFINITY), '—');
});

test('sources 存坏了不让整页白屏', () => {
  assert.deepEqual(parseSources(null), []);
  assert.deepEqual(parseSources('不是 JSON'), []);
  assert.deepEqual(parseSources('{"不是":"数组"}'), []);
});

test('正常解析 sources', () => {
  const raw = JSON.stringify([{ callerName: 'ja', groupName: 'DBZ主群', firstCallTime: 100 }]);
  assert.deepEqual(parseSources(raw), [{ callerName: 'ja', groupName: 'DBZ主群', firstCallTime: 100 }]);
});

test('跌幅截断显示 —— 四舍五入会和筛选对不上', () => {
  // 80.95 四舍五入成 81.0，用户填「≥81」看到 81.0 的被筛掉只会觉得是筛错了
  assert.equal(drawdownText(80.95), '-80.9%');
  assert.equal(drawdownText(81.13), '-81.1%');
  assert.equal(drawdownText(80), '-80.0%');
});

test('跌幅缺失显示破折号', () => {
  assert.equal(drawdownText(null), '—');
  assert.equal(drawdownText(Number.NaN), '—');
});
