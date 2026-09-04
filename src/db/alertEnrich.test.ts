process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runMigrations } from './migrate.ts';
import { getRawDb } from './index.ts';
import * as wr from './walletRepo.ts';
import { lookupSymbol, enrichAlerts } from './alertEnrich.ts';

before(() => { runMigrations(); });

let seq = 0;
const alert = (tokenId: string): wr.PumpAlertRow => ({
  id: `a${++seq}`, userId: 'u', tokenId, firedAt: 100, timeframe: '1h', basis: 'low',
  level: 2, multiple: '2.4', priceUsd: '1', basePriceUsd: '0.4',
  balance: '100', valueUsd: '100', ackedAt: null, kind: 'level',
});

test('优先从 holdings 取币名', () => {
  const u = wr.createUser(`e${++seq}`, 'h')!;
  const w = wr.addWallet(u.id, 'bsc', `0xe${seq}`, null)!;
  wr.upsertHolding(w.id, 'bsc:0xfromholding', '1', 18, 100);
  wr.setHoldingSymbol('bsc:0xfromholding', '妙脆角');
  assert.equal(lookupSymbol('bsc:0xfromholding'), '妙脆角');
});

test('holdings 没有时退到 token_meta', () => {
  wr.setTokenMeta('bsc:0xfrommeta', 500, 'MOONALD', 100);
  assert.equal(lookupSymbol('bsc:0xfrommeta'), 'MOONALD');
});

test('都没有时返回 null，不抛错', () => {
  assert.equal(lookupSymbol('bsc:0xnowhere'), null);
});

test('enrichAlerts 补出币名、地址与链', () => {
  wr.setTokenMeta('bsc:0xenrich', 100, 'TESTCOIN', 100);
  const [e] = enrichAlerts([alert('bsc:0xenrich')]);
  assert.equal(e?.symbol, 'TESTCOIN');
  assert.equal(e?.address, '0xenrich');
  assert.equal(e?.chain, 'bsc');
});

test('查不到币名时 symbol 为 null，其余字段照常', () => {
  const [e] = enrichAlerts([alert('bsc:0xunknownsym')]);
  assert.equal(e?.symbol, null);
  assert.equal(e?.address, '0xunknownsym');
  assert.equal(e?.multiple, '2.4', '报警本身的字段不能丢');
});

test('同一批里同一个币只查一次', () => {
  wr.setTokenMeta('bsc:0xdup', 1, 'DUP', 100);
  const out = enrichAlerts([alert('bsc:0xdup'), alert('bsc:0xdup'), alert('bsc:0xdup')]);
  assert.equal(out.length, 3);
  assert.ok(out.every((e) => e.symbol === 'DUP'));
});

test('token_id 格式异常时不崩', () => {
  const [e] = enrichAlerts([alert('malformed')]);
  assert.equal(e?.address, null);
  assert.equal(e?.chain, 'malformed');
});

test('空数组返回空数组', () => {
  assert.deepEqual(enrichAlerts([]), []);
});

test('表缺失时降级成没有币名，不让整批报警失败', () => {
  // 币名是锦上添花，报警本身才是关键
  const db = getRawDb();
  db.exec('ALTER TABLE token_meta RENAME TO token_meta_backup');
  try {
    const [e] = enrichAlerts([alert('bsc:0xtablegone')]);
    assert.equal(e?.symbol, null);
    assert.equal(e?.multiple, '2.4', '报警必须照常产出');
  } finally {
    db.exec('ALTER TABLE token_meta_backup RENAME TO token_meta');
  }
});

test('契约：SSE 与页面接口都必须补币名', () => {
  // 这次的 bug 就是两条路径走岔了 —— 页面加载补了，SSE 没补，
  // 于是刷新看历史有名字、实时弹出的通知只有一串 0x。
  // 而通知里没法复制粘贴，一串十六进制等于什么也没说。
  for (const p of [
    'src/app/api/wallet/alerts/route.ts',
    'src/app/api/wallet/stream/route.ts',
  ]) {
    const src = readFileSync(p, 'utf8');
    assert.match(src, /enrichAlerts\(/, `${p} 必须用 enrichAlerts 补币名`);
    assert.ok(
      !/send\('pump',\s*fresh\)/.test(src),
      `${p} 不能直接推未补全的原始行`,
    );
  }
});
