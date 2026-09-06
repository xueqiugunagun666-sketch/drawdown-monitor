import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCursor, MAX_PLAUSIBLE_SEQ, cursorAfterSend } from './sseCursor.ts';

const MAX_SEQ = 41230;

test('都不带就从当前最大序号开始 —— 新连接不重播历史', () => {
  assert.equal(resolveCursor(null, null, MAX_SEQ), MAX_SEQ);
});

test('Last-Event-ID 优先于 ?since —— 自动重连带的才是最新的', () => {
  assert.equal(resolveCursor('41000', '40000', MAX_SEQ), 41000);
});

test('只有 ?since 时用 ?since —— 主动重建连接走这条', () => {
  assert.equal(resolveCursor(null, '40000', MAX_SEQ), 40000);
});

test('0 是合法游标 —— 库里一条都还没有时就是 0', () => {
  assert.equal(resolveCursor('0', null, MAX_SEQ), 0);
});

test('旧客户端留下的时间戳游标当作没给，而不是当序号用', () => {
  // 拿 1788427454 当 rowid 去比，`rowid > 17亿` 永远为空，
  // 这个连接从此一条报警都收不到 —— 比不续传还糟
  assert.equal(resolveCursor('1788427454', null, MAX_SEQ), MAX_SEQ);
  assert.equal(resolveCursor(null, '1788427454', MAX_SEQ), MAX_SEQ);
  assert.equal(resolveCursor(String(MAX_PLAUSIBLE_SEQ), null, MAX_SEQ), MAX_SEQ);
});

test('垃圾值一律当作没给', () => {
  for (const junk of ['', '  ', 'abc', '-1', 'NaN', 'Infinity']) {
    assert.equal(resolveCursor(junk, null, MAX_SEQ), MAX_SEQ, `Last-Event-ID=${JSON.stringify(junk)}`);
    assert.equal(resolveCursor(null, junk, MAX_SEQ), MAX_SEQ, `since=${JSON.stringify(junk)}`);
  }
});

test('Last-Event-ID 是垃圾时退到 ?since，而不是直接跳到最新', () => {
  assert.equal(resolveCursor('abc', '40000', MAX_SEQ), 40000);
});

test('小数截断成整数', () => {
  assert.equal(resolveCursor('40000.9', null, MAX_SEQ), 40000);
});

test('发送成功后才推进游标，失败时保留原位置供重试', () => {
  assert.equal(cursorAfterSend(100, 101, false), 100);
  assert.equal(cursorAfterSend(100, 101, true), 101);
});
