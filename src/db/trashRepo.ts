/**
 * 群聊淘金的数据访问层。
 *
 * 这张表与钱包持仓不同：它是**全站共享**的（喊单信号是公开事实，
 * 不属于某个人），所以这里没有 userId 过滤 —— 与 walletRepo 顶上那条
 * 「凡是接受 userId 的读写都必须把它放进 WHERE」不冲突，因为这里压根
 * 没有 userId 这个维度。
 */
import { desc, sql } from 'drizzle-orm';
import { getDb, getRawDb } from './index.ts';
import { trashSignals } from './schema.ts';
import type { TrashSignal } from '../sources/trashSignals.ts';

export type TrashRow = typeof trashSignals.$inferSelect;

/**
 * 轮询游标 = 库里最大的 id。
 *
 * 不单独存一份游标状态：多存一份就多一份会与实际数据不一致的东西。
 * 用 MAX(id) 是自愈的 —— 万一某行被删了，下一轮会把它重新拉回来，
 * 而重复写入是幂等的（主键就是上游 id）。
 */
export function maxSignalId(): number {
  const r = getDb().get<{ n: number | null }>(sql`SELECT MAX(id) AS n FROM trash_signals`);
  return r?.n ?? 0;
}

/** 批量写入。返回**新增**的条数（已存在的不算） */
export function insertSignals(rows: TrashSignal[], now: number): number {
  if (rows.length === 0) return 0;
  const db = getRawDb();
  const st = db.prepare(
    `INSERT INTO trash_signals
       (id, chain, address, symbol, name, peak_market_cap, current_market_cap,
        drawdown_percent, first_call_time, latest_call_time, triggered_at, sources, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       current_market_cap = excluded.current_market_cap,
       drawdown_percent   = excluded.drawdown_percent,
       latest_call_time   = excluded.latest_call_time,
       sources            = excluded.sources,
       fetched_at         = excluded.fetched_at`,
  );
  // 一次事务写完：中途失败不会留下拉了一半的状态
  const run = db.transaction((list: TrashSignal[]) => {
    let added = 0;
    for (const s of list) {
      const before = db.prepare('SELECT 1 AS x FROM trash_signals WHERE id = ?').get(s.id);
      st.run(
        s.id, s.chain, s.address, s.symbol, s.name,
        s.peakMarketCap, s.currentMarketCap, s.drawdownPercent,
        s.firstCallTime, s.latestCallTime, s.triggeredAt,
        JSON.stringify(s.sources), now,
      );
      if (!before) added++;
    }
    return added;
  });
  return run(rows);
}

/** 最近的信号，新的在前。触发时间缺失的排最后，不让它们插到最前面 */
export function listSignals(limit = 200): TrashRow[] {
  return getDb().select().from(trashSignals)
    .orderBy(desc(sql`COALESCE(triggered_at, 0)`), desc(trashSignals.id))
    .limit(limit)
    .all();
}

export function countSignals(): number {
  const r = getDb().get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM trash_signals`);
  return r?.n ?? 0;
}
