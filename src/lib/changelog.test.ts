import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASES, CURRENT_VERSION } from './changelog.ts';

test('至少有一条版本记录', () => {
  assert.ok(RELEASES.length > 0);
});

test('版本号格式统一', () => {
  for (const r of RELEASES) assert.match(r.version, /^v\d+\.\d+$/, `${r.version} 格式不对`);
});

test('版本号不重复', () => {
  const vs = RELEASES.map((r) => r.version);
  assert.equal(new Set(vs).size, vs.length);
});

test('按时间倒序排列 —— 最新的在最前', () => {
  for (let i = 1; i < RELEASES.length; i++) {
    assert.ok(RELEASES[i - 1]!.date >= RELEASES[i]!.date,
      `${RELEASES[i - 1]!.version} (${RELEASES[i - 1]!.date}) 应不早于 ${RELEASES[i]!.version} (${RELEASES[i]!.date})`);
  }
});

test('版本号也是递减的', () => {
  const num = (v: string) => {
    const [a, b] = v.slice(1).split('.').map(Number);
    return (a ?? 0) * 1000 + (b ?? 0);
  };
  for (let i = 1; i < RELEASES.length; i++) {
    assert.ok(num(RELEASES[i - 1]!.version) > num(RELEASES[i]!.version),
      `${RELEASES[i - 1]!.version} 应大于 ${RELEASES[i]!.version}`);
  }
});

test('日期格式合法且不是未来', () => {
  // 公告里写的是北京日期，不能拿 toISOString() 的 UTC 日期比 ——
  // 北京时间 8/31 凌晨时，UTC 还是 8/30，会把当天的版本误判成"未来"
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} 日期格式不对`);
    assert.ok(r.date <= today, `${r.version} 的日期 ${r.date} 在未来`);
  }
});

test('每个版本都有标题和至少一条改动', () => {
  for (const r of RELEASES) {
    assert.ok(r.headline.length > 0, `${r.version} 缺标题`);
    assert.ok(r.changes.length > 0, `${r.version} 没有改动条目`);
  }
});

test('改动类型只有三种', () => {
  for (const r of RELEASES) {
    for (const c of r.changes) {
      assert.ok(['new', 'fix', 'change'].includes(c.kind), `${r.version} 有未知类型 ${c.kind}`);
      assert.ok(c.title.length > 0, `${r.version} 有空标题`);
    }
  }
});

test('CURRENT_VERSION 就是最新那条', () => {
  assert.equal(CURRENT_VERSION, RELEASES[0]?.version);
});
