import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, evaluateFilter, type FilterState } from './holdingsFilter.ts';

const armed: FilterState = { monitored: true, belowSinceTs: null };
const idle: FilterState = { monitored: false, belowSinceTs: null };
const th = DEFAULT_THRESHOLDS;

test('默认门槛是 $5,000 流动性 + $10,000 日成交', () => {
  assert.equal(th.minLiquidityUsd, 5000);
  assert.equal(th.minVolume24hUsd, 10000);
});

test('两个条件都达标才进入监控', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 6000, volume24hUsd: 12000 }, 100, th);
  assert.equal(r.monitored, true);
  assert.equal(r.reason, null);
});

test('正好等于门槛就算达标', () => {
  assert.equal(evaluateFilter(idle, { liquidityUsd: 5000, volume24hUsd: 10000 }, 100, th).monitored, true);
});

test('流动性够但成交量不够，不进入，且说明是哪条不够', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 500 }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /成交/);
});

test('成交量够但流动性不够，不进入', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 100, volume24hUsd: 999999 }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /流动性/);
});

test('两条都不够时原因里都要提到', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 1, volume24hUsd: 1 }, 100, th);
  assert.match(r.reason!, /流动性/);
  assert.match(r.reason!, /成交/);
});

test('滞回：已监控的币跌到 $4,000 不退出（低于入门槛但高于退出线）', () => {
  const r = evaluateFilter(armed, { liquidityUsd: 4000, volume24hUsd: 12000 }, 100, th);
  assert.equal(r.monitored, true, '5000*0.6=3000 才是退出线，4000 在滞回区内');
  assert.equal(r.belowSinceTs, null);
});

test('跌破退出线要持续 30 分钟才退出', () => {
  const t0 = 1000;
  const s1 = evaluateFilter(armed, { liquidityUsd: 500, volume24hUsd: 12000 }, t0, th);
  assert.equal(s1.monitored, true, '刚跌破还不退出');
  assert.equal(s1.belowSinceTs, t0);

  const s2 = evaluateFilter(s1, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1799, th);
  assert.equal(s2.monitored, true, '不满 30 分钟还不退出');

  const s3 = evaluateFilter(s2, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1800, th);
  assert.equal(s3.monitored, false, '满 30 分钟才退出');
});

test('跌破后恢复，计时清零，不会累计', () => {
  const t0 = 1000;
  const dipped = evaluateFilter(armed, { liquidityUsd: 500, volume24hUsd: 12000 }, t0, th);
  assert.equal(dipped.belowSinceTs, t0);

  const recovered = evaluateFilter(dipped, { liquidityUsd: 8000, volume24hUsd: 12000 }, t0 + 60, th);
  assert.equal(recovered.belowSinceTs, null, '恢复后必须清零');
  assert.equal(recovered.monitored, true);

  const again = evaluateFilter(recovered, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 120, th);
  assert.equal(again.belowSinceTs, t0 + 120, '再次跌破应从头计时');
  const still = evaluateFilter(again, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1900, th);
  assert.equal(still.monitored, true, '从第二次跌破算起还不满 30 分钟');
});

test('反复短暂跌破不会把币踢出监控', () => {
  let s: FilterState = armed;
  for (let i = 0; i < 100; i++) {
    const liq = i % 2 === 0 ? 500 : 8000;      // 每轮跌破又恢复
    s = evaluateFilter(s, { liquidityUsd: liq, volume24hUsd: 12000 }, 1000 + i * 60, th);
  }
  assert.equal(s.monitored, true, '抖动 100 轮也不该被踢出');
});

test('成交量单独跌破退出线也会触发退出计时', () => {
  const r = evaluateFilter(armed, { liquidityUsd: 99999, volume24hUsd: 100 }, 500, th);
  assert.equal(r.belowSinceTs, 500);
});

test('报价缺失时保持原状态，并明确标出，不静默降级', () => {
  // 数据缺失不等于流动性归零，不能因一次接口抖动就把币踢出监控；
  // 也不能当作达标。保持原状态并把原因写出来，让用户在页面上看得见
  const kept = evaluateFilter(armed, { liquidityUsd: null, volume24hUsd: null }, 100, th);
  assert.equal(kept.monitored, true);
  assert.match(kept.reason!, /报价缺失/);

  const stillOut = evaluateFilter(idle, { liquidityUsd: null, volume24hUsd: null }, 100, th);
  assert.equal(stillOut.monitored, false);
  assert.match(stillOut.reason!, /报价缺失/);
});

test('报价缺失不清零退出计时', () => {
  const t0 = 1000;
  const dipped = evaluateFilter(armed, { liquidityUsd: 500, volume24hUsd: 12000 }, t0, th);
  const gap = evaluateFilter(dipped, { liquidityUsd: null, volume24hUsd: null }, t0 + 100, th);
  assert.equal(gap.belowSinceTs, t0, '接口抖一下不该让已经跌破的币重新开始计时');
});

test('只有一半报价缺失也按缺失处理', () => {
  const r = evaluateFilter(armed, { liquidityUsd: 6000, volume24hUsd: null }, 100, th);
  assert.match(r.reason!, /报价缺失/);
});

test('持有人数超标直接出局', () => {
  // MOONALD 实测 705,786 持有人，流动性和成交量都达标，但那是空投盘
  const r = evaluateFilter(idle, { liquidityUsd: 99189, volume24hUsd: 260271, holderCount: 705786 }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /持有人.*70\.6 万.*空投盘/);
});

test('持有人数超标时，已在监控的币也立刻踢出，不走滞回', () => {
  // 这不是"暂时不够格"而是"币的性质不对"，没有回旋余地
  const r = evaluateFilter(armed, { liquidityUsd: 99189, volume24hUsd: 260271, holderCount: 705786 }, 100, th);
  assert.equal(r.monitored, false);
  assert.equal(r.belowSinceTs, null);
});

test('持有人数在门槛内不影响判定', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 99999, holderCount: 8000 }, 100, th);
  assert.equal(r.monitored, true);
  assert.equal(r.reason, null);
});

test('正好等于门槛不算超标', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 99999, holderCount: 100000 }, 100, th);
  assert.equal(r.monitored, true);
});

test('持有人数还没查到时不影响原有判定', () => {
  // 查不到不等于合格，但也不该因此踢掉已在监控的币
  const a = evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 99999, holderCount: null }, 100, th);
  assert.equal(a.monitored, true, '其它条件达标就正常进入');
  const b = evaluateFilter(armed, { liquidityUsd: 50000, volume24hUsd: 99999 }, 100, th);
  assert.equal(b.monitored, true, '字段缺省也不该踢人');
});

test('默认门槛是 10 万', () => {
  assert.equal(th.maxHolderCount, 100_000);
});

test('持有人判定优先于报价缺失 —— 性质不对就不用等报价', () => {
  const r = evaluateFilter(armed, { liquidityUsd: null, volume24hUsd: null, holderCount: 705786 }, 100, th);
  assert.equal(r.monitored, true, '报价缺失时保持原状态，持有人判定要等有报价再说');
});

/* ---------- 1 小时成交量的快通道（FLETCH 那个坑） ---------- */

test('流动性够、24h 量不够，但 1h 量够 —— 放进来', () => {
  // FLETCH 9-03 17:20 的真实数字：池子 $32,457 一直没动，
  // 24h 量还没爬回来，但那五分钟已经成交 $3,705
  const r = evaluateFilter(idle, {
    liquidityUsd: 32457, volume24hUsd: 3000, volume1hUsd: 3705,
  }, 100, th);
  assert.equal(r.monitored, true);
  assert.equal(r.reason, null);
});

test('1h 量不够就还是挡着 —— 快通道不是后门', () => {
  const r = evaluateFilter(idle, {
    liquidityUsd: 32457, volume24hUsd: 3000, volume1hUsd: 199,
  }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason ?? '', /24h 成交/);
});

test('1h 量再大，流动性不够也进不来', () => {
  const r = evaluateFilter(idle, {
    liquidityUsd: 100, volume24hUsd: 0, volume1hUsd: 999999,
  }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason ?? '', /流动性/);
});

test('不传 1h 量时行为与改动前一致 —— 老调用方不受影响', () => {
  assert.equal(evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 500 }, 100, th).monitored, false);
  assert.equal(evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 10000 }, 100, th).monitored, true);
});

test('退出判定不看 1h 量 —— 一阵脉冲成交不能让币在监控集里进进出出', () => {
  const t0 = 1_000_000;
  // 24h 量跌破退出线，但 1h 量很大；仍然要开始计时退出
  const s1 = evaluateFilter(armed, { liquidityUsd: 50000, volume24hUsd: 100, volume1hUsd: 999999 }, t0, th);
  assert.equal(s1.belowSinceTs, t0);
  const s2 = evaluateFilter(s1, { liquidityUsd: 50000, volume24hUsd: 100, volume1hUsd: 999999 }, t0 + 1800, th);
  assert.equal(s2.monitored, false);
});
