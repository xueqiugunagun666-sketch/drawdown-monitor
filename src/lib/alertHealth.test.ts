import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  step, activeIssues, initialWatchState, describeIssue,
  GRACE_SECONDS, RENOTIFY_SECONDS, ISSUES, type HealthIssue, type WatchState,
} from './alertHealth.ts';

const none = new Set<HealthIssue>();
const audio = new Set<HealthIssue>(['audio-dead']);
const stream = new Set<HealthIssue>(['stream-down']);
const both = new Set<HealthIssue>(['audio-dead', 'stream-down']);

/** 先让某一项"曾经正常过"，否则一律不提醒 */
function healthy(t = 0): WatchState {
  return step(initialWatchState(), none, t).state;
}

test('从没正常过就不提醒 —— 那是还没开启，不是失效', () => {
  // 页面刚打开、用户从没点过「开启声音」：横幅本来就在说，
  // 而且那时通知权限多半也没给，弹也弹不出来
  let s = initialWatchState();
  for (let t = 0; t < 600; t += 5) {
    const r = step(s, audio, t);
    assert.deepEqual(r.notify, [], `t=${t}`);
    s = r.state;
  }
});

test('本来好好的突然坏了，过了观察期就提醒', () => {
  const s0 = healthy(0);
  const a = step(s0, audio, 100);
  assert.deepEqual(a.notify, [], '刚坏还在观察期，不弹');
  const b = step(a.state, audio, 100 + GRACE_SECONDS - 1);
  assert.deepEqual(b.notify, [], '差一秒也不弹');
  const c = step(b.state, audio, 100 + GRACE_SECONDS);
  assert.deepEqual(c.notify, ['audio-dead'], '满观察期才弹');
});

test('观察期是为了挡住抖动 —— 断 3 秒又回来不弹', () => {
  // EventSource 断开后约 3 秒自动重连，网络抖一下就弹窗的话，
  // 弹几次用户就不看了，等于把这个功能关掉
  const s0 = healthy(0);
  const a = step(s0, stream, 100);
  const b = step(a.state, none, 103);
  const c = step(b.state, stream, 104);
  assert.deepEqual(a.notify, []);
  assert.deepEqual(b.notify, []);
  assert.deepEqual(c.notify, [], '重新开始计时，不是接着上次的');
  assert.deepEqual(step(c.state, stream, 104 + GRACE_SECONDS - 1).notify, []);
});

test('一直坏着不刷屏，但隔够久要再提醒一次', () => {
  let s = healthy(0);
  s = step(s, audio, 0).state;                      // 故障从 t=0 开始
  const first = step(s, audio, GRACE_SECONDS);      // 熬满观察期
  assert.deepEqual(first.notify, ['audio-dead']);
  s = first.state;
  const notifiedAt = GRACE_SECONDS;
  for (const t of [notifiedAt + 60, notifiedAt + 600, notifiedAt + RENOTIFY_SECONDS - 1]) {
    const r = step(s, audio, t);
    assert.deepEqual(r.notify, [], `t=${t} 不该重复弹`);
    s = r.state;
  }
  assert.deepEqual(step(s, audio, notifiedAt + RENOTIFY_SECONDS).notify, ['audio-dead'],
    '隔够久要再提醒一次 —— 一直哑着而人不知道，比多弹一次危险');
});

test('恢复之后再坏，立刻重新计时并提醒，不被上次的去重窗口压着', () => {
  let s = healthy(0);
  s = step(s, audio, GRACE_SECONDS).state;          // 第一次提醒
  s = step(s, none, 100).state;                     // 恢复
  const again = step(s, audio, 200);
  assert.deepEqual(again.notify, [], '重新走观察期');
  assert.deepEqual(step(again.state, audio, 200 + GRACE_SECONDS).notify, ['audio-dead']);
});

test('两项一起坏就一起提醒，各自独立计时', () => {
  const s0 = healthy(0);
  const a = step(s0, audio, 100);
  const b = step(a.state, both, 105);               // 推送稍后才断
  assert.deepEqual(step(b.state, both, 100 + GRACE_SECONDS).notify, ['audio-dead'],
    '声音先到期，推送还没到');
  const c = step(b.state, both, 105 + GRACE_SECONDS);
  assert.deepEqual(c.notify.sort(), ['audio-dead', 'stream-down']);
});

test('一项恢复不影响另一项的提醒状态', () => {
  let s = healthy(0);
  s = step(s, both, 0).state;
  s = step(s, both, GRACE_SECONDS).state;           // 两项都提醒过
  const r = step(s, audio, 100);                    // 推送恢复，声音还坏着
  assert.deepEqual(r.notify, []);
  assert.equal(r.state['stream-down'].since, null);
  assert.equal(r.state['stream-down'].everHealthy, true);
  assert.notEqual(r.state['audio-dead'].since, null);
});

test('activeIssues 只报已过观察期的，用来控制标签页告警', () => {
  const s0 = healthy(0);
  const a = step(s0, audio, 100);
  assert.deepEqual(activeIssues(a.state, 100), [], '观察期内不示警');
  assert.deepEqual(activeIssues(a.state, 100 + GRACE_SECONDS), ['audio-dead']);
  const b = step(a.state, none, 200);
  assert.deepEqual(activeIssues(b.state, 999), [], '恢复后立刻撤掉');
});

test('从没开启过声音时标签页不告警 —— 否则每次刷新都红着，红久了就没人看了', () => {
  // 浏览器要求每次页面加载都重新点一下才允许出声，所以"锁着"是常态，
  // 不是故障。这件事归页面里那个大黄横幅管
  let s = initialWatchState();
  for (let t = 0; t < 3600; t += 30) {
    s = step(s, audio, t).state;
    assert.deepEqual(activeIssues(s, t), [], `t=${t}`);
  }
});

test('每种故障都有说清后果的文案，不能只说"出错了"', () => {
  for (const i of ISSUES) {
    const d = describeIssue(i);
    assert.ok(d.title.length > 0, i);
    assert.ok(d.body.length > 10, `${i} 的正文要说明会漏掉什么`);
  }
});
