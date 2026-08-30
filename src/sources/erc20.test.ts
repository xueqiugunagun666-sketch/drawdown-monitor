import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBalanceOf, padAddress, SELECTOR_BALANCE_OF, SELECTOR_DECIMALS,
  decodeUint256, decodeUint8, toHumanAmount,
} from './erc20.ts';

test('encodeBalanceOf = 4 字节选择器 + 32 字节左补零地址', () => {
  const data = encodeBalanceOf('0x0000000000000000000000000000000000001004');
  assert.equal(data.length, 2 + 8 + 64);
  assert.ok(data.startsWith('0x70a08231'));
  assert.ok(data.endsWith('0000000000000000000000000000000000001004'));
});

test('实测过的 calldata 逐字符对得上', () => {
  // 这条 calldata 实测在 BSC 上对 WBNB 调用返回了正确余额
  assert.equal(
    encodeBalanceOf('0x0000000000000000000000000000000000001004'),
    '0x70a082310000000000000000000000000000000000000000000000000000000000001004',
  );
});

test('地址统一转小写，大小写写法产生相同 calldata', () => {
  assert.equal(
    encodeBalanceOf('0xBB4CdB9CbD36B01bD1cBaEBF2De08d9173bc095c'),
    encodeBalanceOf('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'),
  );
});

test('padAddress 输出 64 字符且不带 0x', () => {
  const p = padAddress('0xbb4CdB9CbD36B01bD1cBaEBF2De08d9173bc095c');
  assert.equal(p.length, 64);
  assert.ok(!p.startsWith('0x'));
});

test('选择器是固定值', () => {
  assert.equal(SELECTOR_BALANCE_OF, '0x70a08231');
  assert.equal(SELECTOR_DECIMALS, '0x313ce567');
});

test('decodeUint256 对超过 2^53 的余额精确 —— 绝不能过 Number', () => {
  // 实测 BSC 上某地址的 CAKE 余额
  const hex = '0x' + (78409586395585725488444n).toString(16).padStart(64, '0');
  assert.equal(decodeUint256(hex), '78409586395585725488444');
  // 反证：走 Number 会失真，说明这个断言确实在测东西
  assert.notEqual(String(Number(hex)), '78409586395585725488444');
});

test('decodeUint256 处理空返回（合约不存在 / 非 ERC20）', () => {
  assert.equal(decodeUint256('0x'), '0');
  assert.equal(decodeUint256(''), '0');
  assert.equal(decodeUint256('乱七八糟'), '0');
});

test('decodeUint8 读 decimals；读不到返回 null 而不是猜 18', () => {
  assert.equal(decodeUint8('0x' + (18).toString(16).padStart(64, '0')), 18);
  assert.equal(decodeUint8('0x' + (6).toString(16).padStart(64, '0')), 6);
  assert.equal(decodeUint8('0x' + (0).toString(16).padStart(64, '0')), 0);
  assert.equal(decodeUint8('0x'), null);
});

test('decodeUint8 超出 uint8 范围时返回 null', () => {
  assert.equal(decodeUint8('0x' + (999).toString(16).padStart(64, '0')), null);
});

test('toHumanAmount 用 Decimal 换算，不经过浮点', () => {
  assert.equal(toHumanAmount('1000000000000000000', 18)?.toString(), '1');
  // 项目全局设了 toExpNeg:-40，小数一律展开成普通记法而不是科学记数法。
  // memecoin 价格在 1e-12 量级，展开是刻意的：科学记数法一旦流进
  // 字符串比较或前端展示就会出乱子。
  assert.equal(toHumanAmount('1', 18)?.toString(), '0.000000000000000001');
  assert.equal(toHumanAmount('78409586395585725488444', 18)?.toString(), '78409.586395585725488444');
  assert.equal(toHumanAmount('1234567', 6)?.toString(), '1.234567');
});

test('toHumanAmount 在 decimals 未知时返回 null，不猜', () => {
  // 猜 18 会让一个 6 位小数的代币余额被算大 10^12 倍，
  // 然后静静进入监控，最后报出荒谬的持仓价值
  assert.equal(toHumanAmount('1000', null), null);
});

test('极小数量不退化成科学记数法', () => {
  const tiny = toHumanAmount('1', 30);
  assert.ok(!tiny!.toString().includes('e'), `不该出现指数记法，实际 ${tiny}`);
});

test('toHumanAmount 处理 decimals 为 0 的代币', () => {
  assert.equal(toHumanAmount('42', 0)?.toString(), '42');
});
