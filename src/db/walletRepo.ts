/**
 * 钱包监控的数据访问层。单独一个文件，不塞进已有 568 行的 repo.ts。
 *
 * **本文件的核心约定：任何接受 userId 的读写，都必须把它放进 WHERE 子句，
 * 不能"先查出来再在代码里比较"。** 这个功能的全部意义就是互不查看持仓，
 * 这里是最后一道闸；漏一个条件就等于没做隔离。
 */
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from './index.ts';
import { users, sessions, wallets, holdings, pumpAlerts } from './schema.ts';

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
  id: string, block: number, at: number, error: string | null,
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
    belowSinceTs: holdings.belowSinceTs,
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
