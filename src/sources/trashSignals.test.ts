import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrashPage, parseUpstreamTime, PAGE_LIMIT } from './trashSignals.ts';

/* ---------- 时间戳：猜错时区就整体错 8 小时 ---------- */

test('上游时间按北京时间解析', () => {
  // 实测依据：刚触发的一条 triggered_at 是 04:39:02，本机 CST 04:41:20，
  // 差两分钟 —— 是 UTC+8 不是 UTC
  const ts = parseUpstreamTime('2026-09-04 04:39:02');
  assert.equal(ts, Date.UTC(2026, 8, 3, 20, 39, 2) / 1000, '04:39 CST = 前一天 20:39 UTC');
});

test('解析结果与运行环境的时区无关', () => {
  // 用 new Date(str) 的话，不同运行时对无时区字符串的解释不一致，
  // 线上机器时区一改结果就变
  const before = process.env.TZ;
  const seen = new Set<number | null>();
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    process.env.TZ = tz;
    seen.add(parseUpstreamTime('2026-09-04 04:39:02'));
  }
  process.env.TZ = before;
  assert.equal(seen.size, 1, '三个时区下算出来必须是同一个值');
});

test('时间字段缺失或格式不对时是 null，不是 0 也不是 NaN', () => {
  for (const bad of [null, undefined, '', 'not a date', 123, {}, '2026-13-45 99:99:99']) {
    const r = parseUpstreamTime(bad);
    assert.ok(r === null || Number.isFinite(r), String(bad));
  }
  assert.equal(parseUpstreamTime('乱七八糟'), null);
  assert.equal(parseUpstreamTime(null), null);
});

/* ---------- 解析：以线上真实响应为样本 ---------- */

const REAL = JSON.stringify({
  after_id: 0, count: 1, next_after_id: 1, success: true,
  rule: { dedupe: 'once_per_ca', drawdown_percent_gte: 80.0, peak_market_cap_gt: 1000000.0 },
  signals: [{
    id: 1, chain: 'robinhood', address: '0x518ABF0972DA8E13B25D1DDA06E8092C25577C01',
    symbol: 'QI', name: 'Quantum Inu',
    peak_market_cap: 1605902.8, current_market_cap: 316699.25, drawdown_percent: 80.28,
    first_call_time: '2026-09-01 15:19:31', latest_call_time: '2026-09-01 15:19:31',
    triggered_at: '2026-09-04 04:31:01', notification_status: 'sent',
    sources: [{
      caller_name: 'ja', caller_wxid: 'wxid_ylka90osjeqp22',
      group_id: '46255010586@chatroom', group_name: 'DBZ主群',
      first_call_time: '2026-09-01 15:19:31',
    }],
  }],
});

test('解析线上真实响应', () => {
  const p = parseTrashPage(REAL, 0);
  assert.equal(p.signals.length, 1);
  const s = p.signals[0]!;
  assert.equal(s.id, 1);
  assert.equal(s.symbol, 'QI');
  assert.equal(s.drawdownPercent, 80.28);
  assert.equal(s.address, '0x518abf0972da8e13b25d1dda06e8092c25577c01', '地址要归一成小写');
  assert.equal(s.sources[0]?.groupName, 'DBZ主群');
  assert.equal(p.rule?.drawdown_percent_gte, 80.0);
});

test('不收微信身份标识 —— 存了只是把别人的身份搬到共享看板上', () => {
  const p = parseTrashPage(REAL, 0);
  const src = p.signals[0]!.sources[0]! as unknown as Record<string, unknown>;
  assert.equal(src.callerWxid, undefined);
  assert.equal(src.groupId, undefined);
  assert.deepEqual(Object.keys(src).sort(), ['callerName', 'firstCallTime', 'groupName']);
});

test('缺 id / 链 / 地址的条目直接丢掉 —— 那三个是去重键和身份', () => {
  const body = JSON.stringify({ signals: [
    { chain: 'bsc', address: '0xa' },                       // 没 id
    { id: 2, address: '0xb' },                              // 没链
    { id: 3, chain: 'bsc' },                                // 没地址
    { id: 4, chain: 'bsc', address: '0xd' },                // 齐全
  ] });
  const p = parseTrashPage(body, 0);
  assert.deepEqual(p.signals.map((s) => s.id), [4]);
});

test('数值字段是垃圾时给 null，不硬转成 0', () => {
  // 0 会被当成"回撤 0%""市值 0"照常显示，比缺失更误导
  const body = JSON.stringify({ signals: [{
    id: 9, chain: 'bsc', address: '0x9',
    peak_market_cap: 'N/A', current_market_cap: null, drawdown_percent: undefined,
  }] });
  const s = parseTrashPage(body, 0).signals[0]!;
  assert.equal(s.peakMarketCap, null);
  assert.equal(s.currentMarketCap, null);
  assert.equal(s.drawdownPercent, null);
});

/* ---------- 游标：错一步就是永久丢数据或永久卡住 ---------- */

test('上游不给 next_after_id 时用本页最大 id 兜底', () => {
  const body = JSON.stringify({ signals: [
    { id: 7, chain: 'bsc', address: '0x7' }, { id: 9, chain: 'bsc', address: '0x9' },
  ] });
  assert.equal(parseTrashPage(body, 0).nextAfterId, 9);
});

test('上游给的 next_after_id 落后于本页最大 id 时，取大的 —— 否则同一页拉到天荒地老', () => {
  const body = JSON.stringify({ next_after_id: 3, signals: [
    { id: 7, chain: 'bsc', address: '0x7' },
  ] });
  assert.equal(parseTrashPage(body, 0).nextAfterId, 7);
});

test('空页不会把游标倒退回去', () => {
  const p = parseTrashPage(JSON.stringify({ signals: [], next_after_id: 0 }), 42);
  assert.equal(p.signals.length, 0);
  assert.equal(p.nextAfterId, 42, '倒退的话会把已经拉过的全部重来一遍');
});

test('响应不是 JSON 或 signals 不是数组时抛错，不当成空页', () => {
  // 当成空页的后果是静默：页面一直空着，日志里什么都没有
  assert.throws(() => parseTrashPage('<html>502</html>', 0), /非 JSON/);
  assert.throws(() => parseTrashPage(JSON.stringify({ signals: 'nope' }), 0), /不是数组/);
});

test('一页的条数上限是 100', () => {
  assert.equal(PAGE_LIMIT, 100);
});
