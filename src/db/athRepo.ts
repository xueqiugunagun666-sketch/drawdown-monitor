/**
 * 钱包币 ATH 的读写。见 schema.ts 的 walletAth 说明。
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from './index.ts';
import { walletAth } from './schema.ts';

export type WalletAthRow = typeof walletAth.$inferSelect;

export function getWalletAth(tokenId: string): WalletAthRow | null {
  return getDb().select().from(walletAth).where(eq(walletAth.tokenId, tokenId)).get() ?? null;
}

export function listWalletAth(): Map<string, WalletAthRow> {
  const m = new Map<string, WalletAthRow>();
  for (const r of getDb().select().from(walletAth).all()) m.set(r.tokenId, r);
  return m;
}

export interface AthUpsert {
  tokenId: string;
  athPrice: string | null;
  athTs: number | null;
  historyStartTs: number | null;
  pairCreatedAt: number | null;
  complete: boolean;
  backfilledAt: number;
}

export function upsertWalletAth(r: AthUpsert): void {
  getDb().run(sql`
    INSERT INTO wallet_ath
      (token_id, ath_price, ath_ts, history_start_ts, pair_created_at,
       complete, backfilled_at, updated_at)
    VALUES (${r.tokenId}, ${r.athPrice}, ${r.athTs}, ${r.historyStartTs},
            ${r.pairCreatedAt}, ${r.complete ? 1 : 0}, ${r.backfilledAt}, ${r.backfilledAt})
    ON CONFLICT(token_id) DO UPDATE SET
      ath_price        = excluded.ath_price,
      ath_ts           = excluded.ath_ts,
      history_start_ts = excluded.history_start_ts,
      pair_created_at  = excluded.pair_created_at,
      complete         = excluded.complete,
      backfilled_at    = excluded.backfilled_at,
      updated_at       = excluded.updated_at
  `);
}

/**
 * 实时判定时把新高写进去，但**不动 backfilled_at**。
 *
 * 分开是因为那两件事的含义不同：backfilled_at 说的是"上次拉长历史是什么
 * 时候"，决定要不要重拉；而实时刷新的新高不改变历史覆盖范围。
 * 混用会让长历史永远不重拉。
 */
export function raiseWalletAth(tokenId: string, price: string, ts: number): void {
  getDb().run(sql`
    UPDATE wallet_ath SET ath_price = ${price}, ath_ts = ${ts}, updated_at = ${ts}
    WHERE token_id = ${tokenId}
  `);
}

/** 上次回填早于这个时刻的币需要重拉。没记录的一律要拉 */
export function tokenIdsNeedingBackfill(allTokenIds: string[], before: number): string[] {
  const have = listWalletAth();
  return allTokenIds.filter((id) => {
    const r = have.get(id);
    return !r || r.backfilledAt === null || r.backfilledAt < before;
  });
}

/** 报警状态机的持久化。与 upsertWalletAth 分开 —— 那个管长历史，这个管报警 */
export function saveAthAlertState(
  tokenId: string,
  state: 'ARMED' | 'FIRED',
  lastAlertPrice: string | null,
  refAth: string | null,
  now: number,
  fired: boolean,
): void {
  getDb().run(sql`
    UPDATE wallet_ath SET
      state = ${state},
      last_alert_price = ${lastAlertPrice},
      ref_ath = ${refAth},
      last_alert_at = ${fired ? now : sql`last_alert_at`},
      updated_at = ${now}
    WHERE token_id = ${tokenId}
  `);
}
