import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventInput, isSafeUrl, DEFAULT_REMIND_OFFSETS } from './eventInput.ts';

const base = { title: 'Foo mint', at: '2026-09-03T20:00', inputTz: 'Asia/Shanghai' };

test('最小输入即可创建，提醒用默认值', () => {
  const r = parseEventInput({ ...base });
  assert.ok(r.ok);
  assert.equal(r.value.title, 'Foo mint');
  assert.deepEqual(r.value.remindOffsets, DEFAULT_REMIND_OFFSETS);
  assert.equal(r.value.priority, 'normal');
});

test('时间按所选时区换算成 UTC', () => {
  const cn = parseEventInput({ ...base });
  const et = parseEventInput({ ...base, inputTz: 'America/New_York' });
  assert.ok(cn.ok && et.ok);
  assert.notEqual(cn.value.atTs, et.value.atTs, '同一墙上时间、不同时区，UTC 必然不同');
});

test('标题必填', () => {
  const r = parseEventInput({ ...base, title: '   ' });
  assert.ok(!r.ok);
  assert.match(r.error, /标题/);
});

test('非法时区被拒', () => {
  const r = parseEventInput({ ...base, inputTz: 'Mars/Olympus' });
  assert.ok(!r.ok);
  assert.match(r.error, /时区/);
});

test('非法时间被拒', () => {
  const r = parseEventInput({ ...base, at: '明天下午' });
  assert.ok(!r.ok);
  assert.match(r.error, /时间/);
});

test('只放行 http/https —— 链接会被渲染成可点的 a 标签', () => {
  assert.equal(isSafeUrl('https://x.com/foo'), true);
  assert.equal(isSafeUrl('http://example.com'), true);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html,<script>'), false);
  assert.equal(isSafeUrl('  not a url  '), false);

  const r = parseEventInput({ ...base, links: [{ label: 'X', url: 'javascript:alert(1)' }] });
  assert.ok(!r.ok);
  assert.match(r.error, /http/);
});

test('链接正常保留标签与地址，空 url 忽略', () => {
  const r = parseEventInput({ ...base, links: [
    { label: 'X', url: 'https://x.com/foo' },
    { label: '', url: 'https://opensea.io/x' },
    { label: 'ignored', url: '' },
  ] });
  assert.ok(r.ok);
  assert.equal(r.value.links.length, 2);
  assert.equal(r.value.links[0]!.label, 'X');
});

test('提醒点去重并降序', () => {
  const r = parseEventInput({ ...base, remindOffsets: [60, 1440, 60, 0] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.remindOffsets, [1440, 60, 0]);
});

test('提醒点全非法时报错而不是静默用默认值', () => {
  const r = parseEventInput({ ...base, remindOffsets: [-5, 999999999] });
  assert.ok(!r.ok);
  assert.match(r.error, /提醒/);
});

test('未知分类与重要程度被拒', () => {
  assert.ok(!parseEventInput({ ...base, category: '乱写' }).ok);
  assert.ok(!parseEventInput({ ...base, priority: 'urgent' }).ok);
});
