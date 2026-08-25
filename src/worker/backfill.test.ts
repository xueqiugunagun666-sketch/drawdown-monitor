import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import { magnitudeMismatch } from './backfill.ts';

const D = (s: string) => new Decimal(s);

test('量级一致时放行', () => {
  assert.equal(magnitudeMismatch(D('0.042'), D('0.0422')), null);
  assert.equal(magnitudeMismatch(D('0.042'), D('0.038')), null);
});

test('剧烈但合理的波动仍放行（回填与实时之间可能隔了几分钟）', () => {
  assert.equal(magnitudeMismatch(D('0.042'), D('0.21')), null);    // 5x
  assert.equal(magnitudeMismatch(D('0.042'), D('0.0084')), null);  // 1/5
});

test('牛来场景：GT 与 DexScreener 的 base/quote 判定相反，取到对手方价格', () => {
  // 实测：实时价 0.04201，回填回来 708.34（QQQB 的价格），差 16861 倍
  const msg = magnitudeMismatch(D('0.04201'), D('708.341042377765'));
  assert.ok(msg, '必须拦下');
  assert.match(msg!, /相差/);
  assert.match(msg!, /16[0-9]{3}/, `原因里应带出倍数，实际: ${msg}`);
});

test('反方向同样拦截', () => {
  assert.ok(magnitudeMismatch(D('700'), D('0.042')));
});

test('没有参照物时不拦（新币还没取到实时价）', () => {
  assert.equal(magnitudeMismatch(null, D('123')), null);
  assert.equal(magnitudeMismatch(D('0'), D('123')), null);
});

test('memecoin 量级下依然可用', () => {
  assert.equal(magnitudeMismatch(D('0.000000000001234'), D('0.000000000001250')), null);
  assert.ok(magnitudeMismatch(D('0.000000000001234'), D('0.0000000001234')));  // 100x
});
