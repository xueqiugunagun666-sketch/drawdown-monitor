/**
 * setTabAlarm 依赖 document。这里用最小的 DOM 桩，只覆盖仲裁逻辑 ——
 * 那是测试按钮当场抓出来的那个 bug 所在（看门狗每秒把测试告警刷掉）。
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const els = new Map<string, { id: string; remove: () => void }>();
before(() => {
  (globalThis as unknown as { document: unknown }).document = {
    title: 'Show Tools',
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => {
      const el = { id: '', rel: '', type: '', href: '', remove: () => els.delete(el.id) };
      return el;
    },
    head: { appendChild: (el: { id: string; remove: () => void }) => els.set(el.id, el) },
  };
});

const { setTabAlarm, holdTabAlarm, releaseTabAlarm, tabAlarmActive } =
  await import('./tabAlarm.ts');

const doc = () => (globalThis as unknown as { document: { title: string } }).document;

beforeEach(() => { releaseTabAlarm(); els.clear(); doc().title = 'Show Tools'; });

test('设告警会改标题并插红图标', () => {
  setTabAlarm('提示音已失效');
  assert.equal(doc().title, '⚠️ 提示音已失效 — Show Tools');
  assert.equal(tabAlarmActive(), true);
});

test('清告警会还原标题并撤掉图标', () => {
  setTabAlarm('提示音已失效');
  setTabAlarm(null);
  assert.equal(doc().title, 'Show Tools');
  assert.equal(tabAlarmActive(), false);
});

test('占用期内看门狗的常规刷新覆盖不掉测试告警', () => {
  // 这就是测试按钮当场抓到的 bug：看门狗每秒 tick 一次无条件写标题，
  // 测试刚设上的告警不到一秒就被刷掉，而按钮还报告"✓"
  holdTabAlarm('这是一条测试告警', 5000);
  for (let i = 0; i < 10; i++) setTabAlarm(null);          // 模拟看门狗的 tick
  assert.equal(doc().title, '⚠️ 这是一条测试告警 — Show Tools');
  assert.equal(tabAlarmActive(), true);
});

test('占用期一过，看门狗就能把它刷掉', () => {
  holdTabAlarm('这是一条测试告警', 0);
  setTabAlarm(null);
  assert.equal(doc().title, 'Show Tools');
});

test('release 立刻结束占用 —— 组件卸载时不能把标题留在告警状态', () => {
  holdTabAlarm('这是一条测试告警', 60_000);
  releaseTabAlarm();
  assert.equal(doc().title, 'Show Tools');
  assert.equal(tabAlarmActive(), false);
});

test('重复设同一条告警不会插两个图标', () => {
  setTabAlarm('A');
  setTabAlarm('B');
  assert.equal(els.size, 1);
});

test('tabAlarmActive 要标题与图标都在才算 —— 只有一个说明状态不一致', () => {
  setTabAlarm('X');
  els.clear();                                             // 图标被别处移掉
  assert.equal(tabAlarmActive(), false);
});
