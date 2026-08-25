/**
 * 数据访问层。better-sqlite3 是同步的，这里全部同步函数。
 */
import { eq, and, gte, desc, isNull, or } from 'drizzle-orm';
import { getDb } from './index.ts';
import {
  tokens, pools, candles, athState, alertRules, alertStates, alerts, sourceHealth, pollRuns,
} from './schema.ts';
import { Decimal, priceToText, priceFromText } from '../lib/decimal.ts';
import { nowSec, align5m } from '../lib/time.ts';
import type { TokenQuote } from '../sources/types.ts';
import type { AthResult } from '../worker/ath.ts';
import type { StateSnapshot } from '../worker/stateMachine.ts';

export type TokenRow = typeof tokens.$inferSelect;
export type RuleRow = typeof alertRules.$inferSelect;

export function listEnabledTokens(): TokenRow[] {
  return getDb().select().from(tokens).where(eq(tokens.enabled, 1)).all();
}

export function listAllTokens(): TokenRow[] {
  return getDb().select().from(tokens).orderBy(tokens.addedAt).all();
}

export function getToken(id: string): TokenRow | undefined {
  return getDb().select().from(tokens).where(eq(tokens.id, id)).get();
}

export function addToken(input: {
  chain: string; address: string; note: string; tags?: string[];
}): TokenRow {
  const id = `${input.chain}:${input.address}`;
  const row = {
    id, chain: input.chain, address: input.address, symbol: null, name: null, decimals: null,
    addedAt: nowSec(), note: input.note, tags: JSON.stringify(input.tags ?? []),
    frozen: 0, enabled: 1, lastSource: null, lastQuoteAt: null, failCount: 0,
  };
  getDb().insert(tokens).values(row).onConflictDoNothing().run();
  return getToken(id)!;
}

export function deleteToken(id: string): void {
  const db = getDb();
  db.delete(alertStates).where(eq(alertStates.tokenId, id)).run();
  db.delete(athState).where(eq(athState.tokenId, id)).run();
  db.delete(candles).where(eq(candles.tokenId, id)).run();
  db.delete(pools).where(eq(pools.tokenId, id)).run();
  db.delete(tokens).where(eq(tokens.id, id)).run();
}

export function updateTokenMeta(id: string, patch: Partial<TokenRow>): void {
  getDb().update(tokens).set(patch).where(eq(tokens.id, id)).run();
}

/** 报价成功：更新符号/来源/时间并清零失败计数 */
export function markQuoteSuccess(id: string, q: TokenQuote): void {
  getDb().update(tokens).set({
    symbol: q.symbol, name: q.name, lastSource: q.source, lastQuoteAt: q.fetchedAt, failCount: 0,
  }).where(eq(tokens.id, id)).run();
}

export function markQuoteFailure(id: string): number {
  const t = getToken(id);
  const next = (t?.failCount ?? 0) + 1;
  getDb().update(tokens).set({ failCount: next }).where(eq(tokens.id, id)).run();
  return next;
}

/** 主池迁移检测：返回上一次的 primary pool 地址 */
export function getPrimaryPoolAddress(tokenId: string): string | null {
  const row = getDb().select().from(pools)
    .where(and(eq(pools.tokenId, tokenId), eq(pools.isPrimary, 1))).get();
  return row?.address ?? null;
}

export function syncPools(tokenId: string, q: TokenQuote): void {
  const db = getDb();
  const ts = nowSec();
  db.transaction((tx) => {
    tx.update(pools).set({ isPrimary: 0 }).where(eq(pools.tokenId, tokenId)).run();
    for (const p of q.allPools) {
      tx.insert(pools).values({
        id: `${p.chain}:${p.address}`, tokenId, address: p.address, dex: p.dex,
        quoteSymbol: p.quoteSymbol, quoteAddress: p.quoteAddress,
        isPrimary: p.address === q.primaryPool.address ? 1 : 0,
        liquidityUsd: p.liquidityUsd, priceUsd: p.priceUsd,
        isOutlier: p.isOutlier ? 1 : 0, createdAt: p.createdAt, lastSeenAt: ts,
      }).onConflictDoUpdate({
        target: pools.id,
        set: {
          dex: p.dex, quoteSymbol: p.quoteSymbol, liquidityUsd: p.liquidityUsd,
          priceUsd: p.priceUsd, isOutlier: p.isOutlier ? 1 : 0,
          isPrimary: p.address === q.primaryPool.address ? 1 : 0, lastSeenAt: ts,
        },
      }).run();
    }
  });
}

export function listPools(tokenId: string) {
  return getDb().select().from(pools).where(eq(pools.tokenId, tokenId))
    .orderBy(desc(pools.liquidityUsd)).all();
}

/**
 * 写入/更新当前 5m candle。
 * 同一格内多次轮询：o 保留首次，h/l 取极值，c 取最新。
 */
export function upsertCandle(tokenId: string, q: TokenQuote): void {
  const db = getDb();
  const ts = align5m(q.fetchedAt);
  const price = priceToText(q.priceUsd);
  const nat = q.priceNative ? priceToText(q.priceNative) : null;
  const existing = db.select().from(candles)
    .where(and(eq(candles.tokenId, tokenId), eq(candles.timeframe, '5m'), eq(candles.ts, ts))).get();

  if (!existing) {
    db.insert(candles).values({
      tokenId, timeframe: '5m', ts,
      o: price, h: price, l: price, c: price,
      oNative: nat, hNative: nat, lNative: nat, cNative: nat,
      volumeUsd: q.volume.m5, liquidityPrimary: q.liquidityPrimary,
      liquidityTotal: q.liquidityTotal,
      txnCount: q.txns.m5.buys + q.txns.m5.sells, source: q.source,
    }).run();
    return;
  }

  const hi = Decimal.max(priceFromText(existing.h) ?? q.priceUsd, q.priceUsd);
  const lo = Decimal.min(priceFromText(existing.l) ?? q.priceUsd, q.priceUsd);
  const patch: Record<string, unknown> = {
    h: priceToText(hi), l: priceToText(lo), c: price,
    volumeUsd: q.volume.m5, liquidityPrimary: q.liquidityPrimary,
    liquidityTotal: q.liquidityTotal,
    txnCount: q.txns.m5.buys + q.txns.m5.sells, source: q.source,
  };
  if (nat) {
    const hn = existing.hNative ? Decimal.max(new Decimal(existing.hNative), q.priceNative!) : q.priceNative!;
    const ln = existing.lNative ? Decimal.min(new Decimal(existing.lNative), q.priceNative!) : q.priceNative!;
    patch.hNative = priceToText(hn);
    patch.lNative = priceToText(ln);
    patch.cNative = nat;
    if (!existing.oNative) patch.oNative = nat;
  }
  db.update(candles).set(patch)
    .where(and(eq(candles.tokenId, tokenId), eq(candles.timeframe, '5m'), eq(candles.ts, ts))).run();
}

export function getCandles(tokenId: string, timeframe = '5m', sinceTs = 0) {
  return getDb().select().from(candles)
    .where(and(eq(candles.tokenId, tokenId), eq(candles.timeframe, timeframe), gte(candles.ts, sinceTs)))
    .orderBy(candles.ts).all();
}

export function saveAth(tokenId: string, mode: string, quoteMode: string, r: AthResult): void {
  getDb().insert(athState).values({
    tokenId, mode, quoteMode,
    athRaw: r.athRaw ? priceToText(r.athRaw) : null,
    athRobust: r.athRobust ? priceToText(r.athRobust) : null,
    athTs: r.athTs, athLiquidity: r.athLiquidity, volH1AtAth: r.volH1AtAth,
    athConfidence: r.athConfidence, verdictBasis: r.verdictBasis,
    backfillPartial: 0, updatedAt: nowSec(),
  }).onConflictDoUpdate({
    target: [athState.tokenId, athState.mode, athState.quoteMode],
    set: {
      athRaw: r.athRaw ? priceToText(r.athRaw) : null,
      athRobust: r.athRobust ? priceToText(r.athRobust) : null,
      athTs: r.athTs, athLiquidity: r.athLiquidity, volH1AtAth: r.volH1AtAth,
      athConfidence: r.athConfidence, verdictBasis: r.verdictBasis, updatedAt: nowSec(),
    },
  }).run();
}

export function getAth(tokenId: string, mode: string, quoteMode: string) {
  return getDb().select().from(athState)
    .where(and(eq(athState.tokenId, tokenId), eq(athState.mode, mode), eq(athState.quoteMode, quoteMode)))
    .get();
}

/** 该代币的规则：单代币覆盖优先，否则全局默认 */
export function getRulesFor(tokenId: string): RuleRow[] {
  const db = getDb();
  const own = db.select().from(alertRules)
    .where(and(eq(alertRules.tokenId, tokenId), eq(alertRules.enabled, 1))).all();
  if (own.length > 0) return own;
  return db.select().from(alertRules)
    .where(and(isNull(alertRules.tokenId), eq(alertRules.enabled, 1))).all();
}

export function listRules(): RuleRow[] {
  return getDb().select().from(alertRules).all();
}

export function upsertRule(r: typeof alertRules.$inferInsert): void {
  getDb().insert(alertRules).values(r).onConflictDoUpdate({ target: alertRules.id, set: r }).run();
}

export function getAlertState(tokenId: string, ruleId: string, level: number): StateSnapshot {
  const row = getDb().select().from(alertStates)
    .where(and(eq(alertStates.tokenId, tokenId), eq(alertStates.ruleId, ruleId), eq(alertStates.level, level)))
    .get();
  if (!row) {
    return { state: 'ARMED', hitCount: 0, rearmSinceTs: null, localLow: null, localLowTs: null, lastFiredAt: null };
  }
  return {
    state: row.state as 'ARMED' | 'FIRED',
    hitCount: row.hitCount,
    rearmSinceTs: row.rearmSinceTs,
    localLow: priceFromText(row.localLow),
    localLowTs: row.localLowTs,
    lastFiredAt: row.lastFiredAt,
  };
}

export function saveAlertState(tokenId: string, ruleId: string, level: number, s: StateSnapshot): void {
  const v = {
    tokenId, ruleId, level, state: s.state, hitCount: s.hitCount,
    rearmSinceTs: s.rearmSinceTs,
    localLow: s.localLow ? priceToText(s.localLow) : null,
    localLowTs: s.localLowTs, lastFiredAt: s.lastFiredAt,
  };
  getDb().insert(alertStates).values(v).onConflictDoUpdate({
    target: [alertStates.tokenId, alertStates.ruleId, alertStates.level], set: v,
  }).run();
}

/** cooldown 用：该代币任意档位最近一次触发时刻 */
export function getLastFiredAt(tokenId: string): number | null {
  const row = getDb().select().from(alerts).where(eq(alerts.tokenId, tokenId))
    .orderBy(desc(alerts.firedAt)).limit(1).get();
  return row?.firedAt ?? null;
}

export function insertAlert(a: typeof alerts.$inferInsert): void {
  getDb().insert(alerts).values(a).run();
}

export function updateAlertDelivery(id: string, delivered: string): void {
  getDb().update(alerts).set({ delivered }).where(eq(alerts.id, id)).run();
}

export function listAlerts(limit = 100) {
  return getDb().select().from(alerts).orderBy(desc(alerts.firedAt)).limit(limit).all();
}

/** 启动时补发：未投递成功且在 2 小时内的 alert（§8.3） */
export function listUndelivered(withinSeconds = 7200) {
  const cutoff = nowSec() - withinSeconds;
  return getDb().select().from(alerts)
    .where(and(gte(alerts.firedAt, cutoff), or(isNull(alerts.delivered), eq(alerts.delivered, '')))).all();
}

export function recordSourceOk(sourceId: string): void {
  const v = { sourceId, lastOkAt: nowSec(), consecutiveFailures: 0 };
  getDb().insert(sourceHealth).values(v).onConflictDoUpdate({ target: sourceHealth.sourceId, set: v }).run();
}

export function recordSourceFailure(sourceId: string, kind: string, message: string): void {
  const db = getDb();
  const cur = db.select().from(sourceHealth).where(eq(sourceHealth.sourceId, sourceId)).get();
  const v = {
    sourceId, lastOkAt: cur?.lastOkAt ?? null, lastFailAt: nowSec(),
    lastFailKind: kind, lastFailMessage: message,
    consecutiveFailures: (cur?.consecutiveFailures ?? 0) + 1,
  };
  db.insert(sourceHealth).values(v).onConflictDoUpdate({ target: sourceHealth.sourceId, set: v }).run();
}

export function listSourceHealth() {
  return getDb().select().from(sourceHealth).all();
}

export function startPollRun(tokensRequested: number): number {
  const r = getDb().insert(pollRuns)
    .values({ startedAt: nowSec(), tokensRequested, tokensCovered: 0 }).returning({ id: pollRuns.id }).get();
  return r.id;
}

export function finishPollRun(id: number, covered: number, errors: string[]): void {
  getDb().update(pollRuns).set({
    finishedAt: nowSec(), tokensCovered: covered,
    errors: errors.length ? JSON.stringify(errors) : null,
  }).where(eq(pollRuns.id, id)).run();
}

export function getLastPollRun() {
  return getDb().select().from(pollRuns).orderBy(desc(pollRuns.id)).limit(1).get();
}
