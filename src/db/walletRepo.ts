/**
 * 钱包监控的数据访问层。单独一个文件，不塞进已有 568 行的 repo.ts。
 *
 * **本文件的核心约定：任何接受 userId 的读写，都必须把它放进 WHERE 子句，
 * 不能"先查出来再在代码里比较"。** 这个功能的全部意义就是互不查看持仓，
 * 这里是最后一道闸；漏一个条件就等于没做隔离。
 */
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Decimal } from '../lib/decimal.ts';
import { getDb, getRawDb } from './index.ts';
import { users, sessions, wallets, holdings, pumpAlerts, tokenMeta } from './schema.ts';

export type WalletRow = typeof wallets.$inferSelect;
export type HoldingRow = typeof holdings.$inferSelect;
export type PumpAlertRow = typeof pumpAlerts.$inferSelect;

/* ---------------- 用户 ---------------- */

export function createUser(name: string, passwordHash: string): { id: string; name: string } | null {
  const id = randomUUID();
  try {
    getDb().insert(users).values({
      id, name, passwordHash, createdAt: Math.floor(Date.now() / 1000),
    }).run();
    return { id, name };
  } catch {
    // UNIQUE 冲突 —— 用户名已存在。返回 null 让调用方回 409，
    // 而不是把 SQL 异常冒到接口层变成 500
    return null;
  }
}

export function findUserByName(name: string): { id: string; name: string; passwordHash: string } | null {
  const r = getDb().select().from(users).where(eq(users.name, name)).get();
  return r ? { id: r.id, name: r.name, passwordHash: r.passwordHash } : null;
}

/* ---------------- 会话 ---------------- */

export function createSession(userId: string, tokenHash: string, expiresAt: number): void {
  getDb().insert(sessions).values({
    tokenHash, userId, createdAt: Math.floor(Date.now() / 1000), expiresAt,
  }).run();
}

export function findUserBySessionHash(tokenHash: string, now: number): { id: string; name: string } | null {
  const r = getDb().select({ id: users.id, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gte(sessions.expiresAt, now)))
    .get();
  return r ?? null;
}

export function deleteSession(tokenHash: string): void {
  getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
}

export function purgeExpiredSessions(now: number): number {
  return getDb().delete(sessions).where(sql`${sessions.expiresAt} < ${now}`).run().changes;
}

/* ---------------- 钱包 ---------------- */

export function addWallet(
  userId: string, chain: string, address: string, label: string | null,
): { id: string } | null {
  const id = randomUUID();
  try {
    getDb().insert(wallets).values({
      id, userId, chain, address: address.toLowerCase(), label,
      lastScannedBlock: null, lastScanAt: null, lastScanError: null,
      enabled: 1, createdAt: Math.floor(Date.now() / 1000),
    }).run();
    return { id };
  } catch {
    return null;   // UNIQUE(user_id, chain, address) 冲突
  }
}

export function listWallets(userId: string): WalletRow[] {
  return getDb().select().from(wallets)
    .where(eq(wallets.userId, userId)).orderBy(wallets.createdAt).all();
}

/** worker 用，跨用户 —— 扫描是全局任务，不属于任何人 */
export function listAllEnabledWallets(): WalletRow[] {
  return getDb().select().from(wallets).where(eq(wallets.enabled, 1)).all();
}

export function updateWalletScanState(
  id: string, block: number | null, at: number, error: string | null,
): void {
  getDb().update(wallets)
    .set({ lastScannedBlock: block, lastScanAt: at, lastScanError: error })
    .where(eq(wallets.id, id)).run();
}

/** userId 必须在 WHERE 里 —— 少了它就是任意用户删任意钱包 */
export function removeWallet(userId: string, id: string): boolean {
  return getDb().delete(wallets)
    .where(and(eq(wallets.id, id), eq(wallets.userId, userId)))
    .run().changes > 0;
}

/* ---------------- 持仓 ---------------- */

export function upsertHolding(
  walletId: string, tokenId: string, balance: string, decimals: number | null, now: number,
): void {
  getDb().insert(holdings).values({
    walletId, tokenId, balance, decimals,
    firstSeenAt: now, lastSeenAt: now, monitored: 0, filterReason: null, belowSinceTs: null,
  }).onConflictDoUpdate({
    target: [holdings.walletId, holdings.tokenId],
    // first_seen_at 与 monitored 保持不变：重扫不该重置发现时间，
    // 更不该把已在监控的币打回未监控（那会触发一次冷启动 seed）
    set: { balance, decimals, lastSeenAt: now },
  }).run();
}

export function removeHolding(walletId: string, tokenId: string): void {
  getDb().delete(holdings)
    .where(and(eq(holdings.walletId, walletId), eq(holdings.tokenId, tokenId))).run();
}

export function listHoldings(userId: string): HoldingRow[] {
  return getDb().select({
    walletId: holdings.walletId, tokenId: holdings.tokenId, balance: holdings.balance,
    decimals: holdings.decimals, firstSeenAt: holdings.firstSeenAt, lastSeenAt: holdings.lastSeenAt,
    monitored: holdings.monitored, filterReason: holdings.filterReason,
    belowSinceTs: holdings.belowSinceTs, symbol: holdings.symbol,
  })
    .from(holdings)
    .innerJoin(wallets, eq(wallets.id, holdings.walletId))
    .where(eq(wallets.userId, userId))
    .all();
}

export function listHoldingsByWallet(walletId: string): HoldingRow[] {
  return getDb().select().from(holdings).where(eq(holdings.walletId, walletId)).all();
}

export function setHoldingMonitored(
  walletId: string, tokenId: string, monitored: boolean,
  reason: string | null, belowSinceTs: number | null,
): void {
  getDb().update(holdings)
    .set({ monitored: monitored ? 1 : 0, filterReason: reason, belowSinceTs })
    .where(and(eq(holdings.walletId, walletId), eq(holdings.tokenId, tokenId))).run();
}

/** 报警扇出用：谁持有这个币 */
export function usersHoldingToken(tokenId: string): Array<{
  userId: string; walletId: string; balance: string; decimals: number | null;
}> {
  return getDb().select({
    userId: wallets.userId, walletId: holdings.walletId,
    balance: holdings.balance, decimals: holdings.decimals,
  })
    .from(holdings)
    .innerJoin(wallets, eq(wallets.id, holdings.walletId))
    .where(eq(holdings.tokenId, tokenId))
    .all();
}

/** 跨用户去重 —— 两人持有同一个币，价格只需要轮询一次 */
export function monitoredTokenIds(): string[] {
  return getDb().selectDistinct({ tokenId: holdings.tokenId })
    .from(holdings).where(eq(holdings.monitored, 1)).all()
    .map((r) => r.tokenId);
}

/* ---------------- 报警 ---------------- */

export function insertPumpAlert(row: Omit<PumpAlertRow, 'ackedAt'> & { ackedAt?: number | null }): void {
  getDb().insert(pumpAlerts).values({ ...row, ackedAt: row.ackedAt ?? null }).run();
}

export function listPumpAlerts(userId: string, sinceTs: number): PumpAlertRow[] {
  return getDb().select().from(pumpAlerts)
    .where(and(eq(pumpAlerts.userId, userId), gte(pumpAlerts.firedAt, sinceTs)))
    .orderBy(desc(pumpAlerts.firedAt)).all();
}

/* ---------------- 钱包币的 5m candle ---------------- */

/**
 * 写入/更新钱包币当前的 5m candle。
 *
 * 与 repo.upsertCandle 的 o/h/l/c 语义完全一致（同一格内 o 保留首次、
 * h/l 取极值、c 取最新），但只需要价格与流动性 —— 钱包币走批量报价，
 * 拿不到也不需要主池选举、跨池中位数、txn 明细那些字段。
 *
 * 价格全程走字符串，不经过 Number。
 */
/**
 * 相邻两根 5m candle 之间允许的最大价格跳变。
 *
 * 实测线上 DexScreener 有一个 tick 给 USDG 返回了 5.56e-24（正常价约 1 美元），
 * 那根成了 1h 窗口的最低点，算出 5.96e21 倍并真的推了一条报警。
 *
 * 1000 倍设得很宽松：真实代币 5 分钟内涨跌 1000 倍基本不可能，
 * 而真出现了下一根也会接上，不会漏掉行情。宁可漏一根也不能让
 * 垃圾报价污染整个窗口。
 */
const MAX_TICK_JUMP = 1000;

export function upsertWalletCandle(
  tokenId: string, priceUsd: string, liquidityUsd: number, fetchedAt: number,
): boolean {
  const ts = Math.floor(fetchedAt / 300) * 300;
  const db = getRawDb();

  // 与上一根收盘比：跳变离谱的直接丢弃，不写进序列
  const prev = db.prepare(
    `SELECT c FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts < ?
     ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId, ts) as { c: string | null } | undefined;
  if (prev?.c) {
    const a = new Decimal(prev.c), b = new Decimal(priceUsd);
    if (a.gt(0) && b.gt(0)) {
      const ratio = Decimal.max(a.div(b), b.div(a));
      if (ratio.gt(MAX_TICK_JUMP)) return false;
    }
  }
  const existing = db.prepare(
    `SELECT h, l FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
  ).get(tokenId, ts) as { h: string | null; l: string | null } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, liquidity_total, source)
       VALUES (?, '5m', ?, ?, ?, ?, ?, ?, 'wallet-batch')`,
    ).run(tokenId, ts, priceUsd, priceUsd, priceUsd, priceUsd, liquidityUsd);
    return true;
  }

  const p = new Decimal(priceUsd);
  const hi = existing.h ? Decimal.max(new Decimal(existing.h), p) : p;
  const lo = existing.l ? Decimal.min(new Decimal(existing.l), p) : p;
  db.prepare(
    `UPDATE candles SET h = ?, l = ?, c = ?, liquidity_total = ?
     WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
  ).run(hi.toString(), lo.toString(), priceUsd, liquidityUsd, tokenId, ts);
  return true;
}

/**
 * 全部持仓的 token_id（跨用户去重），供引擎做过滤判定。
 *
 * 与 monitoredTokenIds 的区别很关键：引擎必须对**全部**持仓跑过滤，
 * 只取已监控的会死锁 —— 新持仓写入时 monitored=0，若引擎只看
 * monitored=1，过滤层永远不执行，币永远不会被提升为监控中。
 *
 * decimals 未知的排除掉：无法换算数量，判定没有意义。
 */
export function allHoldingTokenIds(): string[] {
  return getDb().selectDistinct({ tokenId: holdings.tokenId })
    .from(holdings)
    .where(sql`${holdings.decimals} IS NOT NULL`)
    .all()
    .map((r) => r.tokenId);
}

/**
 * 按地址删除该用户在**所有链**上的这个钱包。返回删掉的行数。
 *
 * 界面上一个地址是一张卡（跨四条链），删除自然也该是整组删。
 * user_id 必须在 WHERE 里 —— 少了它就是任意用户删任意钱包。
 */
export function removeWalletByAddress(userId: string, address: string): number {
  return getDb().delete(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.address, address.toLowerCase())))
    .run().changes;
}

/**
 * 记下代币符号。来自 DexScreener 批量报价，第一次拿到就存下来。
 *
 * 存在 holdings 而不是 tokens：钱包币绝不写进 tokens 表 —— 那是共享看板
 * 的数据源，`listEnabledTokens` 等查询都没有 visibility 过滤，
 * 写进去等于把你的持仓摆到公共看板上。宁可在 holdings 里按用户各存一份。
 */
export function setHoldingSymbol(tokenId: string, symbol: string): void {
  getDb().update(holdings)
    .set({ symbol })
    .where(and(eq(holdings.tokenId, tokenId), sql`${holdings.symbol} IS NULL`))
    .run();
}

/* ---------------- 代币元信息（全局缓存） ---------------- */

/** 缓存有效期：持有人数变化很慢，一天查一次足够 */
export const META_TTL_SECONDS = 86400;

export function getTokenMeta(tokenId: string): { holderCount: number | null; symbol: string | null; fetchedAt: number } | null {
  const r = getDb().select().from(tokenMeta).where(eq(tokenMeta.tokenId, tokenId)).get();
  return r ? { holderCount: r.holderCount, symbol: r.symbol, fetchedAt: r.fetchedAt } : null;
}

export function setTokenMeta(tokenId: string, holderCount: number | null, symbol: string | null, now: number): void {
  getDb().insert(tokenMeta)
    .values({ tokenId, holderCount, symbol, fetchedAt: now })
    .onConflictDoUpdate({
      target: tokenMeta.tokenId,
      set: { holderCount, symbol, fetchedAt: now },
    }).run();
}

export function isTokenMetaStale(tokenId: string, now: number): boolean {
  const m = getTokenMeta(tokenId);
  return m === null || now - m.fetchedAt >= META_TTL_SECONDS;
}

/** 已被挡掉的币多久重查一次。流动性不会分分钟变化，30 分钟够了 */
export const REJECTED_RECHECK_SECONDS = 1800;

/**
 * 本轮该判定哪些币。
 *
 * 监控中的每轮都判；已被挡掉的每 30 分钟重查一次 ——
 * 线上 1206 个去重代币里一千一百多个是早被流动性挡掉的粉尘，
 * 每轮都给它们拉报价光请求就占掉 20 秒，而流动性不会分分钟变化。
 *
 * 从未判定过的（last_eval_at 为空）一律要判，否则新扫到的币进不来。
 */
export function tokenIdsDueForEval(now: number): string[] {
  const rows = getDb().all<{ token_id: string }>(sql`
    SELECT DISTINCT h.token_id AS token_id
    FROM holdings h
    LEFT JOIN token_meta m ON m.token_id = h.token_id
    WHERE h.decimals IS NOT NULL
      AND (
        h.monitored = 1
        OR m.last_eval_at IS NULL
        OR m.last_eval_at <= ${now - REJECTED_RECHECK_SECONDS}
      )
  `);
  return rows.map((r) => r.token_id);
}

export function markTokenEvaluated(tokenId: string, now: number): void {
  getDb().run(sql`
    INSERT INTO token_meta (token_id, holder_count, symbol, fetched_at, last_eval_at)
    VALUES (${tokenId}, NULL, NULL, ${now}, ${now})
    ON CONFLICT(token_id) DO UPDATE SET last_eval_at = ${now}
  `);
}
