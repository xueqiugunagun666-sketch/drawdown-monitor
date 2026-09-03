process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import * as repo from '../db/trashRepo.ts';
import { runTrashTick, type TrashDeps } from './trashPoller.ts';
import type { TrashPage, TrashSignal } from '../sources/trashSignals.ts';

before(() => { runMigrations(); });

const NOW = 1_788_460_000;

/**
 * 每个用例领一段互不重叠的 id 区间。
 * 共用一个内存库，而 id 就是主键 —— 撞了就变成 upsert，
 * 断言会以很难看懂的方式失败（第一次写这个测试就踩了）。
 */
let block = 0;
const nextBlock = (): number => 1000 + (++block) * 1000;

function sig(id: number, over: Partial<TrashSignal> = {}): TrashSignal {
  return {
    id, chain: 'robinhood', address: `0x${id.toString(16).padStart(40, '0')}`,
    symbol: 'T', name: 'Token', peakMarketCap: 2_000_000, currentMarketCap: 300_000,
    drawdownPercent: 85, firstCallTime: NOW - 3600, latestCallTime: NOW - 3600,
    triggeredAt: NOW - 60, sources: [{ callerName: 'a', groupName: 'g', firstCallTime: NOW - 3600 }],
    ...over,
  };
}

/** 按 after_id 切页的假上游 */
function fakeUpstream(all: TrashSignal[], pageSize = 100): TrashDeps & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fetchPage: async (afterId: number): Promise<TrashPage> => {
      calls.push(afterId);
      const page = all.filter((s) => s.id > afterId).slice(0, pageSize);
      return {
        signals: page,
        nextAfterId: page.reduce((m, s) => Math.max(m, s.id), afterId),
        rule: null,
      };
    },
  };
}

test('拉到的信号写进库', async () => {
  const base = nextBlock();
  const added = await runTrashTick(NOW, fakeUpstream([sig(base), sig(base + 1)]));
  assert.equal(added, 2);
  assert.ok(repo.listSignals().some((r) => r.id === base));
});

test('重复拉同一批不会写重 —— 主键就是上游 id', async () => {
  const base = nextBlock();
  const up = fakeUpstream([sig(base)]);
  await runTrashTick(NOW, up);
  const n1 = repo.countSignals();
  const added = await runTrashTick(NOW, fakeUpstream([sig(base)]));
  assert.equal(added, 0, '已存在的不算新增');
  assert.equal(repo.countSignals(), n1);
});

test('已有的信号会被更新（现价与回撤会变）', async () => {
  const id = nextBlock();
  await runTrashTick(NOW, fakeUpstream([sig(id, { currentMarketCap: 300_000, drawdownPercent: 85 })]));
  // 上游后来又更新了这条
  repo.insertSignals([sig(id, { currentMarketCap: 111_000, drawdownPercent: 94.5 })], NOW + 60);
  const row = repo.listSignals().find((r) => r.id === id)!;
  assert.equal(row.currentMarketCap, 111_000);
  assert.equal(row.drawdownPercent, 94.5);
});

test('游标从库里的最大 id 接着走，不重拉旧的', async () => {
  const base = nextBlock();
  const all = [sig(base), sig(base + 1), sig(base + 2)];
  await runTrashTick(NOW, fakeUpstream(all));
  const up = fakeUpstream(all);
  await runTrashTick(NOW, up);
  assert.ok(up.calls[0]! >= base + 2, `第二轮应从 ${base + 2} 之后开始，实际 ${up.calls[0]}`);
});

test('一轮会连续翻页直到拉空 —— 首次接入时上游可能已攒了几百条', async () => {
  const base = nextBlock();
  const many = Array.from({ length: 250 }, (_, i) => sig(base + i));
  const up = fakeUpstream(many, 100);
  const added = await runTrashTick(NOW, up);
  assert.equal(added, 250, '一轮就该追平，而不是等三轮');
  assert.ok(up.calls.length >= 3, `应该翻了至少 3 页，实际 ${up.calls.length}`);
});

test('上游游标不前进时本轮中止，不死循环', async () => {
  // 防的是把 worker 卡死 —— 卡死是静默的，日志里什么都没有，只是别的事都不跑了
  let calls = 0;
  const stuck: TrashDeps = {
    fetchPage: async () => {
      calls++;
      if (calls > 50) throw new Error('死循环了');
      return { signals: [sig(1)], nextAfterId: 0, rule: null };   // 游标永远是 0
    },
  };
  await runTrashTick(NOW, stuck);
  assert.ok(calls <= 21, `应该早早中止，实际调了 ${calls} 次`);
});

test('拉取抛错时向上传递，由循环去记日志 —— 不能悄悄当成没有新数据', async () => {
  const boom: TrashDeps = { fetchPage: async () => { throw new Error('令牌被拒绝 (401)'); } };
  await assert.rejects(() => runTrashTick(NOW, boom), /401/);
});

test('列表按触发时间倒序，时间缺失的排最后', async () => {
  const base = nextBlock();
  repo.insertSignals([
    sig(base, { triggeredAt: NOW - 1000 }),
    sig(base + 1, { triggeredAt: NOW - 10 }),
    sig(base + 2, { triggeredAt: null }),
  ], NOW);
  // 只看这三条的相对顺序：库里还有别的用例写进去的行，
  // 而 listSignals 默认只回最近 200 条，直接比全局下标会被截断误导
  const mine = new Set([base, base + 1, base + 2]);
  const ids = repo.listSignals(10_000).map((r) => r.id).filter((id) => mine.has(id));
  assert.deepEqual(ids, [base + 1, base, base + 2],
    '新的在前，没有触发时间的垫底');
});
