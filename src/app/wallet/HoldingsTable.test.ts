import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd } from './HoldingsTable.tsx';

test('大额加千位分隔符', () => {
  // 合计是这一页最该一眼读懂的数字，$116097.28 要数位数才知道量级
  assert.equal(usd('116097.28'), '$116,097.28');
  assert.equal(usd('1234567.5'), '$1,234,567.50');
  assert.equal(usd('1000'), '$1,000.00');
});

test('不足一千不加分隔符', () => {
  assert.equal(usd('999.99'), '$999.99');
  assert.equal(usd('147.96'), '$147.96');
});

test('小于 1 的用四位小数', () => {
  assert.equal(usd('0.057'), '$0.0570');
  assert.equal(usd('0.00001'), '$0.0000');
});

test('零与空值', () => {
  assert.equal(usd('0'), '$0');
  assert.equal(usd(null), '—');
});

test('极大数值不丢分组', () => {
  assert.equal(usd('1000000000'), '$1,000,000,000.00');
});

test('分组只作用于整数部分，不碰小数', () => {
  // 交给 toLocaleString 会把长小数四舍五入掉，memecoin 价格不能这么处理
  assert.equal(usd('1234.5678'), '$1,234.57');
  assert.ok(!usd('1234.5678').slice(usd('1234.5678').indexOf('.')).includes(','));
});
