import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd, matchesQuery, type HoldingRow } from './HoldingsTable.tsx';

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

/* ---------------- 搜索 ---------------- */

const h = (over: Partial<HoldingRow> = {}): HoldingRow => ({
  tokenId: 'bsc:0xabcdef0123456789abcdef0123456789abcdef01',
  chain: 'bsc', address: '0xabcdef0123456789abcdef0123456789abcdef01',
  symbol: '妙脆角', wallet: 'w', amount: '1', priceUsd: '1', valueUsd: '1',
  monitored: true, filterReason: null, lastQuoteAt: null, decimalsKnown: true, best: null,
  ...over,
});

test('空查询匹配全部', () => {
  assert.equal(matchesQuery(h(), ''), true);
  assert.equal(matchesQuery(h(), '   '), true);
});

test('按完整合约地址搜得到', () => {
  assert.equal(matchesQuery(h(), '0xabcdef0123456789abcdef0123456789abcdef01'), true);
});

test('地址不区分大小写 —— 各处复制来的写法五花八门', () => {
  // EVM 地址常见校验和大小写混写，区分大小写等于搜不到
  assert.equal(matchesQuery(h(), '0xABCDEF0123456789ABCDEF0123456789ABCDEF01'), true);
  assert.equal(matchesQuery(h({ address: '0xAbCdEf0123456789abcdef0123456789abcdef01' }), '0xabcdef01'), true);
});

test('按地址片段搜得到 —— 只记得开头几位也能找', () => {
  assert.equal(matchesQuery(h(), '0xabcdef'), true);
  assert.equal(matchesQuery(h(), 'def01'), true);
});

test('按币名搜得到，中英文都行', () => {
  assert.equal(matchesQuery(h(), '妙脆角'), true);
  assert.equal(matchesQuery(h(), '妙脆'), true);
  assert.equal(matchesQuery(h({ symbol: 'MOSAIC' }), 'mosaic'), true);
  assert.equal(matchesQuery(h({ symbol: 'MOSAIC' }), 'MOS'), true);
});

test('按链名精确匹配', () => {
  assert.equal(matchesQuery(h(), 'bsc'), true);
  assert.equal(matchesQuery(h({ chain: 'robinhood' }), 'bsc'), false);
});

test('不相关的查询不匹配', () => {
  assert.equal(matchesQuery(h(), '0x9999'), false);
  assert.equal(matchesQuery(h(), 'DOGE'), false);
});

test('没有币名时不影响地址搜索', () => {
  assert.equal(matchesQuery(h({ symbol: null }), '0xabcdef'), true);
  assert.equal(matchesQuery(h({ symbol: null }), '妙脆角'), false);
});

test('查询自带空格也能匹配 —— 从别处复制常带空格', () => {
  assert.equal(matchesQuery(h(), '  0xabcdef0123456789abcdef0123456789abcdef01  '), true);
});
