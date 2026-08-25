/**
 * 数据访问层。better-sqlite3 是同步的，这里全部同步函数。
 */
import { eq, and, gte, desc, isNull, or } from 'drizzle-orm';
import { getDb, getRawDb } from './index.ts';
import {
  tokens, pools, candles, athState, alertRules, alertStates, alerts, sourceHealth, pollRuns,
  backfillJobs,
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
  db.delete(backfillJobs).where(eq(backfillJobs.tokenId, id)).run();
  db.delete(alerts).where(eq(alerts.tokenId, id)).run();
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

/** 主池的 DexScreener 实时价，作为回填数据的量级参照 */
export function getPrimaryPoolPrice(tokenId: string): Decimal | null {
  const row = getDb().select().from(pools)
    .where(and(eq(pools.tokenId, tokenId), eq(pools.isPrimary, 1))).get();
  return priceFromText(row?.priceUsd ?? null);
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

export function saveAth(
  tokenId: string, mode: string, quoteMode: string, r: AthResult, backfillPartial = false,
): void {
  getDb().insert(athState).values({
    tokenId, mode, quoteMode,
    athRaw: r.athRaw ? priceToText(r.athRaw) : null,
    athRobust: r.athRobust ? priceToText(r.athRobust) : null,
    athTs: r.athTs, athLiquidity: r.athLiquidity, volH1AtAth: r.volH1AtAth,
    athConfidence: r.athConfidence, verdictBasis: r.verdictBasis,
    backfillPartial: backfillPartial ? 1 : 0, updatedAt: nowSec(),
  }).onConflictDoUpdate({
    target: [athState.tokenId, athState.mode, athState.quoteMode],
    set: {
      athRaw: r.athRaw ? priceToText(r.athRaw) : null,
      athRobust: r.athRobust ? priceToText(r.athRobust) : null,
      athTs: r.athTs, athLiquidity: r.athLiquidity, volH1AtAth: r.volH1AtAth,
      athConfidence: r.athConfidence, verdictBasis: r.verdictBasis,
      backfillPartial: backfillPartial ? 1 : 0, updatedAt: nowSec(),
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

// ---------- 回填任务 ----------

export type BackfillJob = typeof backfillJobs.$inferSelect;

export function upsertBackfillJob(j: typeof backfillJobs.$inferInsert): void {
  getDb().insert(backfillJobs).values(j).onConflictDoUpdate({
    target: [backfillJobs.tokenId, backfillJobs.timeframe], set: j,
  }).run();
}

export function getBackfillJob(tokenId: string, timeframe: string): BackfillJob | undefined {
  return getDb().select().from(backfillJobs)
    .where(and(eq(backfillJobs.tokenId, tokenId), eq(backfillJobs.timeframe, timeframe))).get();
}

export function listBackfillJobs(): BackfillJob[] {
  return getDb().select().from(backfillJobs).all();
}

/** 取下一个待处理任务：先到先服务，'running' 优先于 'pending'（续传未完成的） */
export function nextBackfillJob(): BackfillJob | undefined {
  const running = getDb().select().from(backfillJobs)
    .where(eq(backfillJobs.status, 'running')).orderBy(backfillJobs.startedAt).limit(1).get();
  if (running) return running;
  return getDb().select().from(backfillJobs)
    .where(eq(backfillJobs.status, 'pending')).orderBy(backfillJobs.startedAt).limit(1).get();
}

export function updateBackfillJob(tokenId: string, timeframe: string, patch: Partial<BackfillJob>): void {
  getDb().update(backfillJobs).set({ ...patch, updatedAt: nowSec() })
    .where(and(eq(backfillJobs.tokenId, tokenId), eq(backfillJobs.timeframe, timeframe))).run();
}

/**
 * 批量写入回填出的 candle。
 * 用 DO NOTHING —— 实时轮询写的 candle 带流动性与成交笔数（ath_confidence='verified'），
 * 回填数据只有 OHLCV 六字段，绝不能把已有的实时数据覆盖成 inferred。
 */
export function insertBackfillCandles(
  tokenId: string,
  timeframe: string,
  rows: Array<{ ts: number; o: string; h: string; l: string; c: string; volumeUsd: number }>,
): number {
  const db = getRawDb();
  const stmt = db.prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, volume_usd, source)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(token_id, timeframe, ts) DO NOTHING`,
  );
  let written = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      written += stmt.run(tokenId, timeframe, r.ts, r.o, r.h, r.l, r.c, r.volumeUsd, 'geckoterminal').changes;
    }
  });
  tx();
  return written;
}

/** 给回填出的 candle 补上 native 计价（§2.3：由 USD 除以原生币报价推导） */
export function fillNativeForCandles(tokenId: string, timeframe: string, series: Map<number, string>): number {
  const db = getRawDb();
  const rows = db.prepare(
    `SELECT ts, o, h, l, c FROM candles
     WHERE token_id = ? AND timeframe = ? AND c IS NOT NULL AND c_native IS NULL`,
  ).all(tokenId, timeframe) as Array<{ ts: number; o: string; h: string; l: string; c: string }>;
  if (rows.length === 0) return 0;

  const stmt = db.prepare(
    `UPDATE candles SET o_native=?, h_native=?, l_native=?, c_native=?
     WHERE token_id=? AND timeframe=? AND ts=?`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const nat = series.get(r.ts);
      if (!nat) continue;   // 该时刻没有原生币报价 -> 留 null，不猜
      const d = new Decimal(nat);
      if (d.lte(0)) continue;
      stmt.run(
        new Decimal(r.o).div(d).toString(), new Decimal(r.h).div(d).toString(),
        new Decimal(r.l).div(d).toString(), new Decimal(r.c).div(d).toString(),
        tokenId, timeframe, r.ts,
      );
      n++;
    }
  });
  tx();
  return n;
}

/**
 * 把 5m candle 汇总成 1h —— all_time 模式读的是 1h 序列，
 * 回填只覆盖到回填那一刻，之后必须靠实时数据滚动补齐。
 *
 * 只重算最近 hours 小时，且不覆盖回填写入的更早数据。
 * o 取该小时首根的 o，c 取末根的 c，h/l 取极值，volume 求和。
 */
export function rollup5mTo1h(tokenId: string, hours = 3): number {
  const db = getRawDb();
  const since = Math.floor(nowSec() / 3600) * 3600 - hours * 3600;
  const rows = db.prepare(
    `SELECT ts, o, h, l, c, o_native, h_native, l_native, c_native,
            volume_usd, liquidity_primary, liquidity_total, txn_count
     FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ? ORDER BY ts`,
  ).all(tokenId, since) as Array<Record<string, string | number | null>>;
  if (rows.length === 0) return 0;

  const buckets = new Map<number, typeof rows>();
  for (const r of rows) {
    const hour = Math.floor(Number(r.ts) / 3600) * 3600;
    const list = buckets.get(hour) ?? [];
    list.push(r);
    buckets.set(hour, list);
  }

  const stmt = db.prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c,
       o_native, h_native, l_native, c_native, volume_usd,
       liquidity_primary, liquidity_total, txn_count, source)
     VALUES (?,'1h',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(token_id, timeframe, ts) DO UPDATE SET
       o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c,
       o_native=excluded.o_native, h_native=excluded.h_native,
       l_native=excluded.l_native, c_native=excluded.c_native,
       volume_usd=excluded.volume_usd,
       liquidity_primary=excluded.liquidity_primary,
       liquidity_total=excluded.liquidity_total,
       txn_count=excluded.txn_count, source=excluded.source`,
  );

  const maxOf = (list: typeof rows, key: string) => {
    let best: Decimal | null = null;
    for (const r of list) {
      const d = priceFromText(r[key] as string | null);
      if (d && (!best || d.gt(best))) best = d;
    }
    return best ? priceToText(best) : null;
  };
  const minOf = (list: typeof rows, key: string) => {
    let best: Decimal | null = null;
    for (const r of list) {
      const d = priceFromText(r[key] as string | null);
      if (d && (!best || d.lt(best))) best = d;
    }
    return best ? priceToText(best) : null;
  };

  let n = 0;
  const tx = db.transaction(() => {
    for (const [hour, list] of buckets) {
      const first = list[0]!, last = list[list.length - 1]!;
      const volume = list.reduce((sum, r) => sum + (Number(r.volume_usd) || 0), 0);
      const txn = list.reduce((sum, r) => sum + (Number(r.txn_count) || 0), 0);
      // 流动性取该小时最后一次观测值（存量指标，不能求和）
      const liqP = last.liquidity_primary as number | null;
      const liqT = last.liquidity_total as number | null;
      stmt.run(
        tokenId, hour,
        first.o, maxOf(list, 'h'), minOf(list, 'l'), last.c,
        first.o_native, maxOf(list, 'h_native'), minOf(list, 'l_native'), last.c_native,
        volume, liqP, liqT, txn, 'rollup',
      );
      n++;
    }
  });
  tx();
  return n;
}
