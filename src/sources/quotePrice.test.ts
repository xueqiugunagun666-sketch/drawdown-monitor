import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  isMajorQuote, quoteIdentityStatus, impliedQuoteUsd, correctPrice, DEVIATION_THRESHOLD, scaleMarketCap,
} from './quotePrice.ts';

test('主流计价资产不分大小写', () => {
  for (const s of ['USDT', 'usdt', 'WBNB', 'weth', 'BTCB']) {
    assert.equal(isMajorQuote(s), true, s);
  }
  for (const s of ['GMEB', 'USDG', 'SOXLB', 'MRNAB', '', null, undefined]) {
    assert.equal(isMajorQuote(s), false, String(s));
  }
});

test('精确计价币身份判定独立于旧的符号兼容判断', () => {
  assert.equal(
    quoteIdentityStatus('ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'WETH'),
    'trusted',
  );
  assert.equal(
    quoteIdentityStatus('ethereum', '0x0000000000000000000000000000000000000001', 'USDT'),
    'unknown',
  );
  assert.equal(
    quoteIdentityStatus('robinhood', '0x0000000000000000000000000000000000000001', 'USDT'),
    'unknown',
  );
  // 正式校正仍由原有 isMajorQuote/correctPrice 路径决定，本测试只验证可调用元数据判定。
  assert.equal(isMajorQuote('USDT'), true);
});

test('反推池子隐含的计价代币单价', () => {
  // 线上真实数据：不对劲/GMEB，priceUsd 0.003683、priceNative 0.000001596
  const implied = impliedQuoteUsd('0.003683', '0.000001596')!;
  assert.ok(implied.gt(2300) && implied.lt(2320), `实际 ${implied.toString()}`);
});

test('缺值或非正数一律返回 null，不做除零', () => {
  assert.equal(impliedQuoteUsd(null, '1'), null);
  assert.equal(impliedQuoteUsd('1', null), null);
  assert.equal(impliedQuoteUsd('0', '1'), null);
  assert.equal(impliedQuoteUsd('1', '0'), null);
  assert.equal(impliedQuoteUsd('乱写', '1'), null);
  assert.equal(impliedQuoteUsd('-1', '1'), null);
});

test('GMEB 那批：虚高 120 倍，要按真实计价单价重算', () => {
  // 不对劲：池子认为 GMEB=$2307，实际 GMEB/USDT 池是 $19.16
  const r = correctPrice('0.003683', '0.000001596', new Decimal('19.16'));
  assert.equal(r.corrected, true);
  assert.ok(r.deviation!.gt(120) && r.deviation!.lt(121), `偏离 ${r.deviation!.toString()}`);
  // 0.000001596 × 19.16 = 0.0000305794…
  assert.ok(new Decimal(r.priceUsd).lt('0.0000306'));
  assert.ok(new Decimal(r.priceUsd).gt('0.0000305'));
});

test('utility 那条：$44,833 的持仓应该只值 $373', () => {
  const r = correctPrice('0.1829', '0.00007929', new Decimal('19.16'));
  assert.equal(r.corrected, true);
  const amount = new Decimal('245120.364957014008492140');
  const value = amount.mul(r.priceUsd);
  assert.ok(value.gt(370) && value.lt(376), `重算后 $${value.toFixed(2)}`);
});

test('差距在阈值以内不动 —— 正常价差不该被当成错误', () => {
  // 池子认为 $20，实际 $19.16，差 4%
  const r = correctPrice('0.003832', '0.0001916', new Decimal('19.16'));
  assert.equal(r.corrected, false);
  assert.equal(r.priceUsd, '0.003832', '原样返回');
});

test('阈值边界：达到 3 倍就改，差一点就不改', () => {
  const real = new Decimal('10');
  assert.equal(correctPrice('29.9', '1', real).corrected, false, '2.99 倍属于正常价差');
  assert.equal(correctPrice('30', '1', real).corrected, true, '正好 3 倍就动手');
  assert.equal(DEVIATION_THRESHOLD, 3);
});

test('低估同样要校正 —— 方向不该有偏袒', () => {
  // 池子认为计价代币值 $1，实际 $100
  const r = correctPrice('1', '1', new Decimal('100'));
  assert.equal(r.corrected, true);
  assert.equal(r.priceUsd, '100');
});

test('查不到计价代币的独立报价时原样返回 —— 不知道对不对就别动', () => {
  const r = correctPrice('0.003683', '0.000001596', null);
  assert.equal(r.corrected, false);
  assert.equal(r.priceUsd, '0.003683');
});

test('计价代币价格为 0 或负数时也不动', () => {
  assert.equal(correctPrice('1', '1', new Decimal('0')).corrected, false);
  assert.equal(correctPrice('1', '1', new Decimal('-5')).corrected, false);
});

test('没有 priceNative 就无从校正', () => {
  const r = correctPrice('0.003683', null, new Decimal('19.16'));
  assert.equal(r.corrected, false);
  assert.equal(r.priceUsd, '0.003683');
});

test('校正后的价格保持十进制字符串，不经过 Number', () => {
  const r = correctPrice('0.003683', '0.000001596', new Decimal('19.16'));
  assert.equal(typeof r.priceUsd, 'string');
  assert.doesNotMatch(r.priceUsd, /e[+-]/i, '不能退化成科学计数法');
});

/* ---------- 市值跟着实际用的价走 ---------- */

test('价格被校正后市值按同比例缩放 —— 供应量不变', () => {
  // GMEB 那批：价格 ÷120，市值也该 ÷120
  const mc = scaleMarketCap(3_683_132, '0.003683', '0.00003057936');
  assert.ok(mc !== null && mc > 30_000 && mc < 31_000, `实际 ${mc}`);
});

test('价格没变时市值原样返回', () => {
  assert.equal(scaleMarketCap(1_000_000, '0.5', '0.5'), 1_000_000);
});

test('Monkey 那种池间差异：换成正常池的价，市值也要跟着换', () => {
  // 离群 XAUt 池报 $50,548,989 / 价 7.321e-24；正常池价 2.03e-25
  const mc = scaleMarketCap(50_548_989, '0.000000000000000000000007321',
    '0.0000000000000000000000002030');
  assert.ok(mc !== null && mc > 1_350_000 && mc < 1_450_000, `实际 ${mc}`);
});

test('缺值时原样返回，不编造', () => {
  assert.equal(scaleMarketCap(null, '1', '2'), null);
  assert.equal(scaleMarketCap(1000, null, '2'), 1000);
  assert.equal(scaleMarketCap(1000, '1', null), 1000);
  assert.equal(scaleMarketCap(1000, '0', '2'), 1000, '除零不做');
  assert.equal(scaleMarketCap(1000, '乱写', '2'), 1000);
});

test('极小价格上不塌精度 —— 比例用 Decimal 算', () => {
  const mc = scaleMarketCap(1_000_000,
    '0.00000000000000000000000001', '0.00000000000000000000000002');
  assert.ok(mc !== null && Math.abs(mc - 2_000_000) < 1, `实际 ${mc}`);
});
