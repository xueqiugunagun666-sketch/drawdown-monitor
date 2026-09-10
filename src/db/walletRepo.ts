/**
 * 钱包监控的数据访问层。单独一个文件，不塞进已有 568 行的 repo.ts。
 *
 * **本文件的核心约定：任何接受 userId 的读写，都必须把它放进 WHERE 子句，
 * 不能"先查出来再在代码里比较"。** 这个功能的全部意义就是互不查看持仓，
 * 这里是最后一道闸；漏一个条件就等于没做隔离。
 */
import { eq, and, gte, desc, asc, sql, getTableColumns } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Decimal } from '../lib/decimal.ts';
import { normalizeWalletAddress } from '../lib/walletAddress.ts';
import { getDb, getRawDb } from './index.ts';
import {
  users, sessions, wallets, holdings, walletTokenCandidates, pumpAlerts, tokenMeta,
} from './schema.ts';

export type WalletRow = typeof wallets.$inferSelect;
export type HoldingRow = typeof holdings.$inferSelect;
export type PumpAlertRow = typeof pumpAlerts.$inferSelect;

export const WALLET_LABEL_MAX_LENGTH = 40;

/** 钱包备注的唯一归一化规则：去首尾空白、空串视为清空、最多 40 个字符。 */
export function normalizeWalletLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  return trimmed ? trimmed.slice(0, WALLET_LABEL_MAX_LENGTH) : null;
}

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
      id, userId, chain, address: normalizeWalletAddress(address), label: normalizeWalletLabel(label),
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

/**
 * 更新用户自己的地址备注。一个地址在底层按链有多行，列表按地址展示，
 * 所以必须一次更新该用户的全部同地址行；userId 始终在 WHERE 中做隔离。
 */
export function updateWalletLabelByAddress(
  userId: string, address: string, label: string | null,
): number {
  return getDb().update(wallets)
    .set({ label: normalizeWalletLabel(label) })
    .where(and(eq(wallets.userId, userId), eq(wallets.address, normalizeWalletAddress(address))))
    .run().changes;
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
  firstSeenAt = now,
): void {
  getDb().insert(holdings).values({
    walletId, tokenId, balance, decimals,
    firstSeenAt, lastSeenAt: now, monitored: 0, filterReason: null, belowSinceTs: null,
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

export interface HoldingSnapshotEntry {
  tokenId: string;
  balance: string;
  decimals: number;
}

/**
 * 原子应用一份完整持仓快照。用于 Solana：RPC 每轮返回钱包当前所有
 * Token/Token-2022 账户，不需要像 EVM 一样靠转账日志增量发现。
 *
 * 插入、更新、删除旧持仓和推进 slot 必须在同一事务；任何一步失败都会
 * 整体回滚，避免页面显示半份新余额、半份旧余额。
 */
export function applyWalletHoldingSnapshot(
  walletId: string, chain: string, entries: HoldingSnapshotEntry[], slot: number, now: number,
): { written: number; removed: number } {
  const db = getRawDb();
  const tx = db.transaction(() => {
    const wallet = db.prepare(`SELECT chain FROM wallets WHERE id = ?`).get(walletId) as
      { chain: string } | undefined;
    if (!wallet || wallet.chain !== chain) throw new Error('钱包不存在或链不匹配');

    const existing = db.prepare(`SELECT token_id FROM holdings WHERE wallet_id = ?`)
      .all(walletId) as Array<{ token_id: string }>;
    const keep = new Set<string>();
    const upsert = db.prepare(`
      INSERT INTO holdings
        (wallet_id, token_id, balance, decimals, first_seen_at, last_seen_at,
         monitored, filter_reason, below_since_ts)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
      ON CONFLICT(wallet_id, token_id) DO UPDATE SET
        balance = excluded.balance,
        decimals = excluded.decimals,
        last_seen_at = excluded.last_seen_at
    `);
    let written = 0;
    for (const entry of entries) {
      if (!entry.tokenId.startsWith(`${chain}:`)) throw new Error('快照 token_id 链不匹配');
      if (!/^\d+$/.test(entry.balance) || BigInt(entry.balance) <= 0n) {
        throw new Error('快照余额必须是正整数字符串');
      }
      keep.add(entry.tokenId);
      upsert.run(walletId, entry.tokenId, entry.balance, entry.decimals, now, now);
      written++;
    }

    const remove = db.prepare(`DELETE FROM holdings WHERE wallet_id = ? AND token_id = ?`);
    let removed = 0;
    for (const row of existing) {
      if (keep.has(row.token_id)) continue;
      removed += remove.run(walletId, row.token_id).changes;
    }
    db.prepare(`
      UPDATE wallets
         SET last_scanned_block = ?, last_scan_at = ?, last_scan_error = NULL
       WHERE id = ?
    `).run(slot, now, walletId);
    return { written, removed };
  });
  return tx();
}

export interface WalletTokenCandidate {
  tokenId: string;
  discoveredAt: number;
  attemptCount: number;
  nextRetryAt: number | null;
}

/** 发现后先落候选，再允许扫描水位前进。重复发现只保留原始发现时刻。 */
export function rememberWalletTokenCandidates(
  walletId: string, tokenIds: string[], now: number,
): void {
  if (tokenIds.length === 0) return;
  const insert = getDb().insert(walletTokenCandidates);
  getRawDb().transaction(() => {
    for (const tokenId of tokenIds) {
      insert.values({
        walletId, tokenId, discoveredAt: now, lastAttemptAt: null,
        attemptCount: 0, nextRetryAt: null, lastError: null,
      }).onConflictDoNothing().run();
    }
  })();
}

/** 到期候选；NULL 表示从未尝试，必须立刻处理。 */
export function dueWalletTokenCandidates(
  walletId: string, now: number, limit = 50,
): WalletTokenCandidate[] {
  return getDb().select({
    tokenId: walletTokenCandidates.tokenId,
    discoveredAt: walletTokenCandidates.discoveredAt,
    attemptCount: walletTokenCandidates.attemptCount,
    nextRetryAt: walletTokenCandidates.nextRetryAt,
  }).from(walletTokenCandidates).where(and(
    eq(walletTokenCandidates.walletId, walletId),
    sql`${walletTokenCandidates.nextRetryAt} IS NULL OR ${walletTokenCandidates.nextRetryAt} <= ${now}`,
  )).orderBy(walletTokenCandidates.discoveredAt).limit(limit).all();
}

export function markWalletTokenCandidateFailed(
  walletId: string, tokenId: string, now: number, nextRetryAt: number, error: string,
): void {
  getDb().update(walletTokenCandidates).set({
    lastAttemptAt: now,
    attemptCount: sql`${walletTokenCandidates.attemptCount} + 1`,
    nextRetryAt,
    lastError: error.slice(0, 240),
  }).where(and(
    eq(walletTokenCandidates.walletId, walletId),
    eq(walletTokenCandidates.tokenId, tokenId),
  )).run();
}

export function removeWalletTokenCandidate(walletId: string, tokenId: string): void {
  getDb().delete(walletTokenCandidates).where(and(
    eq(walletTokenCandidates.walletId, walletId),
    eq(walletTokenCandidates.tokenId, tokenId),
  )).run();
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

/**
 * 取单个持仓。走主键 (wallet_id, token_id)，不是把整个钱包捞出来再挑。
 *
 * 引擎里原本写的是 `listHoldingsByWallet(walletId).find(x => x.tokenId === id)`，
 * 每个币每个持有人调两次。线上最大的钱包有 1,677 行持仓，一轮要过一千多个币 ——
 * 等于每轮在内存里翻上百万行。快车道把每轮的币数从五百多提到一千多之后，
 * 这笔开销直接把轮次周期顶到 97 秒（预算是 60 秒）。
 */
export function getHolding(walletId: string, tokenId: string): HoldingRow | undefined {
  return getDb().select().from(holdings)
    .where(and(eq(holdings.walletId, walletId), eq(holdings.tokenId, tokenId)))
    .get();
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
/**
 * 持有这个币的人。带上各自的粉尘阈值 —— 扇出时要按人判，
 * 在这里一次 join 拿到，省得每个持有者再查一次 users
 */
export function usersHoldingToken(tokenId: string): Array<{
  userId: string; walletId: string; balance: string; decimals: number | null;
  minAlertValueUsd: number | null; firstSeenAt: number;
}> {
  return getDb().select({
    userId: wallets.userId, walletId: holdings.walletId,
    balance: holdings.balance, decimals: holdings.decimals,
    minAlertValueUsd: users.minAlertValueUsd,
    /** 这个持仓什么时候第一次被扫到 —— 冷启动要靠它分清"新加的钱包"与"沉睡的币醒了" */
    firstSeenAt: holdings.firstSeenAt,
  })
    .from(holdings)
    .innerJoin(wallets, eq(wallets.id, holdings.walletId))
    .innerJoin(users, eq(users.id, wallets.userId))
    .where(and(eq(holdings.tokenId, tokenId), eq(wallets.enabled, 1)))
    .all();
}

/**
 * 每人的粉尘阈值。NULL = 没设过，调用方用默认值。
 *
 * 上限 100 万：手滑多打几个零就等于把报警整个关掉，而关掉是**静默**的 ——
 * 页面一切正常，只是再也不响。宁可拒绝一个荒唐的输入。
 */
export const MAX_MIN_ALERT_VALUE_USD = 1_000_000;

export function getMinAlertValue(userId: string): number | null {
  const r = getDb().select({ v: users.minAlertValueUsd })
    .from(users).where(eq(users.id, userId)).get();
  return r?.v ?? null;
}

/** 返回 false 表示值不合法，没有写入 */
export function setMinAlertValue(userId: string, v: number | null): boolean {
  if (v !== null && (!Number.isFinite(v) || v < 0 || v > MAX_MIN_ALERT_VALUE_USD)) return false;
  getDb().update(users).set({ minAlertValueUsd: v }).where(eq(users.id, userId)).run();
  return true;
}

/** 跨用户去重 —— 两人持有同一个币，价格只需要轮询一次 */
export function monitoredTokenIds(): string[] {
  return getDb().selectDistinct({ tokenId: holdings.tokenId })
    .from(holdings)
    .innerJoin(wallets, eq(wallets.id, holdings.walletId))
    .where(and(eq(holdings.monitored, 1), eq(wallets.enabled, 1))).all()
    .map((r) => r.tokenId);
}

/* ---------------- 报警 ---------------- */

/**
 * 报警的种类。
 *   level / advance —— 暴涨：穿过档位 / 未升档但又涨了一截
 *   ath / ath-advance —— 突破历史新高 / 破新高之后又涨了一截
 */
export type AlertKind =
  | 'level' | 'advance'          // 暴涨：穿档 / 未升档但又涨了一截
  | 'ath' | 'ath-advance'        // 破新高 / 破新高之后又涨了一截
  | 'pump-ath'                   // 同一采样同时满足暴涨档位与 ATH，只通知一次但保留两个原因
  | 'source-down';               // 系统消息：某个报价源不可信了，只发给管理员

export function insertPumpAlert(
  row: Omit<PumpAlertRow,
    'ackedAt' | 'kind' | 'baseTs' | 'athWindow' | 'marketCapUsd' | 'quoteFetchedAt'
    | 'evaluatedAt' | 'priceSource' | 'priceRegime'>
     & { ackedAt?: number | null; kind?: AlertKind | null; baseTs?: number | null;
         athWindow?: string | null; marketCapUsd?: number | null;
         quoteFetchedAt?: number | null; evaluatedAt?: number | null;
         priceSource?: string | null; priceRegime?: string | null },
): void {
  // kind 默认 'level'：调用方不关心时就是穿档，旧行也全是这么来的
  getDb().insert(pumpAlerts)
    .values({
      ...row, ackedAt: row.ackedAt ?? null,
      kind: row.kind ?? 'level', baseTs: row.baseTs ?? null,
      athWindow: row.athWindow ?? null,
      marketCapUsd: row.marketCapUsd ?? null,
      quoteFetchedAt: row.quoteFetchedAt ?? null,
      evaluatedAt: row.evaluatedAt ?? null,
      priceSource: row.priceSource ?? null,
      priceRegime: row.priceRegime ?? null,
    }).run();
}

export function listPumpAlerts(userId: string, sinceTs: number): PumpAlertRow[] {
  return getDb().select().from(pumpAlerts)
    .where(and(eq(pumpAlerts.userId, userId), gte(pumpAlerts.firedAt, sinceTs)))
    .orderBy(desc(pumpAlerts.firedAt)).all();
}

/**
 * 推送游标**不能用 fired_at**，必须用写入顺序。
 *
 * fired_at 存的是那一轮**开始**的时刻，而这一行要等引擎遍历到这个币才写进来 ——
 * 实测 FLETCH 那条 fired_at=17:24:14、实际落库 17:24:37，差 23 秒；一轮要跑
 * 五百多个币，最坏能差一整轮（线上实测 60~79 秒）。拿时间戳当游标就有两种漏法：
 *
 *   1. 连接在这段间隔里重连 —— 游标取"此刻"，已经越过了这条的 fired_at，
 *      它从此对推送永远不可见
 *   2. 同一轮里两条报警共用同一个 fired_at，先送到的那条把游标推到该值，
 *      下一次查 `> 游标` 就把同轮的另一条漏掉（9-03 pananiu 就中了 3 次）
 *
 * rowid 是写入顺序，单调且与时间无关，正好是"投递到哪儿了"该用的东西。
 * pump_alerts 从不删行（全库 grep 过），所以 rowid 不会被回收重用。
 */
export interface PumpAlertWithSeq extends PumpAlertRow { seq: number }

export interface PumpAlertSnapshot {
  snapshotSeq: number;
  alerts: PumpAlertWithSeq[];
}

const ROWID = sql<number>`rowid`;

export function pumpAlertsAfterSeq(userId: string, seq: number, limit = 100): PumpAlertWithSeq[] {
  // 走 drizzle 的 select 而不是裸 SQL：裸 SQL 的 `*` 回的是 snake_case 列名，
  // 与 PumpAlertRow 的 camelCase 对不上，enrichAlerts 会拿到一堆 undefined
  return getDb().select({ ...getTableColumns(pumpAlerts), seq: ROWID })
    .from(pumpAlerts)
    .where(and(eq(pumpAlerts.userId, userId), sql`rowid > ${seq}`))
    .orderBy(asc(ROWID))
    .limit(Math.max(1, Math.min(100, Math.floor(limit))))
    .all();
}

/**
 * 历史列表与 SSE 共用的原子快照边界。
 *
 * 先在读事务里固定全表最大 rowid，再只返回该边界内属于当前用户的历史行。
 * 事务结束后写入的报警必然满足 rowid > snapshotSeq，由随后建立的 SSE 补上。
 */
export function pumpAlertSnapshot(userId: string, sinceTs: number): PumpAlertSnapshot {
  return getRawDb().transaction(() => {
    const snapshotSeq = maxPumpAlertSeq();
    const alerts = getDb().select({ ...getTableColumns(pumpAlerts), seq: ROWID })
      .from(pumpAlerts)
      .where(and(
        eq(pumpAlerts.userId, userId),
        gte(pumpAlerts.firedAt, sinceTs),
        sql`rowid <= ${snapshotSeq}`,
      ))
      .orderBy(desc(ROWID))
      .all();
    return { snapshotSeq, alerts };
  })();
}

/** 当前最大写入序号。新连接从这里开始，不重播历史 */
export function maxPumpAlertSeq(): number {
  const r = getDb().get<{ n: number | null }>(sql`SELECT MAX(rowid) AS n FROM pump_alerts`);
  return r?.n ?? 0;
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
export const MAX_TICK_JUMP = 1000;

export type WalletCandleWriteResult =
  | { status: 'accepted'; reason: null }
  | { status: 'quarantined'; reason: string };

export function upsertWalletCandle(
  tokenId: string, priceUsd: string, liquidityUsd: number, fetchedAt: number,
  /** 与 priceUsd 同源的市值。持仓列表要显示它，不记就只能显示价格 */
  marketCapUsd: number | null = null,
  source: 'wallet-batch' | 'wallet-dexscreener' | 'wallet-xxyy' = 'wallet-batch',
): WalletCandleWriteResult {
  const ts = Math.floor(fetchedAt / 300) * 300;
  const db = getRawDb();

  let price: Decimal;
  try {
    price = new Decimal(priceUsd);
  } catch {
    return { status: 'quarantined', reason: '价格不是合法十进制数' };
  }
  if (!price.isFinite() || price.lte(0)) {
    return { status: 'quarantined', reason: '价格不是有限正数' };
  }

  // 与最近一笔已接受报价比（包括同一 5m 格）：跳变离谱的直接隔离，
  // 不能让同格内的坏报价绕过守卫并污染 h/l/c。
  const prev = db.prepare(
    `SELECT c FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts <= ? AND c IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId, ts) as { c: string | null } | undefined;
  if (prev?.c) {
    try {
      const accepted = new Decimal(prev.c);
      if (accepted.isFinite() && accepted.gt(0)) {
        const ratio = Decimal.max(accepted.div(price), price.div(accepted));
        if (ratio.gt(MAX_TICK_JUMP)) {
          return {
            status: 'quarantined',
            reason: `相对最近已接受报价跳变 ${ratio.toSignificantDigits(8).toString()} 倍`,
          };
        }
      }
    } catch {
      // 旧历史若已损坏，不把它当作新报价的可信参照；新报价本身仍按上面的规则校验。
    }
  }
  const existing = db.prepare(
    `SELECT h, l FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
  ).get(tokenId, ts) as { h: string | null; l: string | null } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO candles
         (token_id, timeframe, ts, o, h, l, c, liquidity_total, market_cap_usd, source)
       VALUES (?, '5m', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(tokenId, ts, priceUsd, priceUsd, priceUsd, priceUsd, liquidityUsd, marketCapUsd, source);
    return { status: 'accepted', reason: null };
  }

  const hi = existing.h ? Decimal.max(new Decimal(existing.h), price) : price;
  const lo = existing.l ? Decimal.min(new Decimal(existing.l), price) : price;
  db.prepare(
    `UPDATE candles SET h = ?, l = ?, c = ?, liquidity_total = ?,
       market_cap_usd = COALESCE(?, market_cap_usd), source = ?
     WHERE token_id = ? AND timeframe = '5m' AND ts = ?`,
  ).run(hi.toString(), lo.toString(), priceUsd, liquidityUsd, marketCapUsd, source, tokenId, ts);
  return { status: 'accepted', reason: null };
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
    .where(and(eq(wallets.userId, userId), eq(wallets.address, normalizeWalletAddress(address))))
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

/** 慢车道：连流动性都不够的币多久重查一次。这类币不会突然变成正经币，30 分钟够了 */
export const REJECTED_RECHECK_SECONDS = 1800;

/**
 * 快车道：**流动性够、只差成交量**的币多久重查一次。
 *
 * 这一拨是被挡掉的币里唯一会突然暴涨的：池子里有几万刀，只是当下没人交易。
 * 线上 1,176 个。FLETCH 9-03 就是其中之一 —— 流动性 $32,457 从头到尾没动过，
 * 只因 24h 成交量跌破退出线被降级，然后 14 小时不采价；行情 17:15 启动，
 * 30 分钟的复查恰好落在 17:2x，等看见时已经 2.53 倍。
 *
 * 3 分钟的定法是**请求预算**倒推的：1,176 个币按每请求 30 个地址、
 * 每轮摊 1/3 分钟，每轮多约 13 个请求；批量接口自带 2 req/s 的节流，
 * 折合每轮多约 6 秒。而线上实测的轮次周期是 60/60/71/60/60 秒 ——
 * 余量只有十几秒，全量每轮跑（多 40 个请求 ≈ 20 秒）会把轮次顶穿。
 */
export const WARM_RECHECK_SECONDS = 180;

/**
 * 快车道的流动性门槛。
 *
 * 原先与 holdingsFilter 的进入线一致（$5,000），但那条线管的是"值不值得
 * 监控"，与"要不要盯着看它会不会醒"是两件事。2026-09-06 的 KANSO 就栽在
 * 这里：拉盘前它的成交量只有约 $154、流动性也不高，走的是 30 分钟一次的
 * 慢车道；等复查到时价格已经 3.55 倍。
 *
 * 降到 $1,000 的代价是实测出来的（9,985 个持仓币的流动性分布）：
 *   >= $5,000        2,767   现有快车道
 *   $1,000 ~ $5,000    299   ← 新增的就是这些
 *   < $1,000           451
 *   拿不到报价       6,468   真正的死币，仍走慢车道
 * 只多 299 个（+11%），摊到每轮约多 100 个币、3 个请求、不到 1 秒。
 *
 * 没有一路降到 0：拿不到报价的那 6,468 个是没有池子的空投垃圾，
 * 把它们塞进快车道只会白烧请求预算，而预算就是这个系统的容量上限。
 */
const WARM_MIN_LIQUIDITY_USD = 1000;

function stableTokenHash(tokenId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < tokenId.length; i++) {
    hash ^= tokenId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 技术失败 15 秒起步，指数退避到最多 5 分钟，并加 0–10 秒固定抖动。 */
export function tokenRetryDelaySeconds(tokenId: string, failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 5);
  const base = Math.min(15 * (2 ** exponent), 300);
  return Math.min(base + (stableTokenHash(tokenId) % 11), 300);
}

function normalScheduleJitter(tokenId: string, interval: number): number {
  const spread = interval === WARM_RECHECK_SECONDS ? 30 : 300;
  return stableTokenHash(tokenId) % spread;
}

/**
 * 本轮该判定哪些币。
 *
 * 三档：监控中的每轮都判；流动性够但成交量不够的 3 分钟一次；
 * 其余（流动性不够、或压根没有报价的粉尘）30 分钟一次 ——
 * 线上 8,188 个去重代币里六千多个是 DexScreener 根本查不到的空投垃圾，
 * 每轮都给它们拉报价光请求就要几分钟，而它们的状态不会分分钟变化。
 *
 * 从未判定过的（last_eval_at 为空）一律要判，否则新扫到的币进不来。
 */
export function tokenIdsDueForEval(now: number, limit = Number.POSITIVE_INFINITY): string[] {
  const rows = getDb().all<{
    token_id: string;
    hot: number;
    last_ok_at: number | null;
    last_liquidity_usd: number | null;
    next_retry_at: number | null;
  }>(sql`
    SELECT h.token_id AS token_id,
           MAX(h.monitored) AS hot,
           COALESCE(m.last_eval_ok_at, m.last_eval_at) AS last_ok_at,
           m.last_liquidity_usd AS last_liquidity_usd,
           m.next_retry_at AS next_retry_at
    FROM holdings h
    INNER JOIN wallets w ON w.id = h.wallet_id AND w.enabled = 1
    LEFT JOIN token_meta m ON m.token_id = h.token_id
    WHERE h.decimals IS NOT NULL
    GROUP BY h.token_id
  `);

  const due = rows.map((row) => {
    const lane = row.hot === 1 ? 0 : row.last_ok_at === null
      ? 1 : (row.last_liquidity_usd ?? 0) >= WARM_MIN_LIQUIDITY_USD ? 2 : 3;
    const interval = lane === 2 ? WARM_RECHECK_SECONDS : REJECTED_RECHECK_SECONDS;
    const normalDueAt = row.last_ok_at === null
      ? 0 : row.last_ok_at + interval + normalScheduleJitter(row.token_id, interval);
    return { ...row, lane, dueAt: row.next_retry_at ?? normalDueAt };
  }).filter((row) => {
    if (row.next_retry_at !== null) return row.next_retry_at <= now;
    return row.lane === 0 || row.dueAt <= now;
  }).sort((a, b) => a.lane - b.lane || a.dueAt - b.dueAt
    || a.token_id.localeCompare(b.token_id))
    .map((row) => row.token_id);
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : due.length;
  return due.slice(0, bounded);
}

/**
 * 回填重试的冷却时间。
 *
 * 一个币的 24 小时历史在半小时里不会有什么变化，而实时 candle 每轮都在攒，
 * 所以隔久一点重试没有损失。**首次一定会试**（没有记录就是 null），
 * 新进监控的币不会因为这个冷却而拿不到历史 —— FLETCH 那种情况正需要立刻回填。
 */
export const BACKFILL_RETRY_SECONDS = 1800;

export function shouldTryBackfill(tokenId: string, now: number): boolean {
  const r = getDb().select({ t: tokenMeta.lastBackfillAt })
    .from(tokenMeta).where(eq(tokenMeta.tokenId, tokenId)).get();
  const last = r?.t ?? null;
  return last === null || now - last >= BACKFILL_RETRY_SECONDS;
}

/** 记的是**尝试**，不是成功 —— 失败的也要计入冷却，否则一直失败的币照样每轮打一次 */
export function markBackfillAttempted(tokenId: string, now: number): void {
  getDb().run(sql`
    INSERT INTO token_meta (token_id, holder_count, symbol, fetched_at, last_backfill_at)
    VALUES (${tokenId}, NULL, NULL, ${now}, ${now})
    ON CONFLICT(token_id) DO UPDATE SET last_backfill_at = ${now}
  `);
}

/**
 * 记下这个币判过了，顺带记下流动性 —— 下一轮靠它决定走快车道还是慢车道。
 *
 * liquidityUsd 为 undefined 表示这一轮没拿到报价（接口抖动 / 币查不到）。
 * 这种情况**保留上一次的值**而不是写 NULL：一次抖动不该把一个正经币
 * 从快车道踢到慢车道，那正是它最需要被盯着的时候。
 */
/**
 * 记下项目方绑定的链接。
 *
 * 只在**拿到非空值**时覆盖：DexScreener 偶尔会回一个不带 info 的池
 * （同一个币多个池，选中的那个没有增强信息），全量覆盖会让已经拿到的
 * 链接反复被清空又填回来，页面上的按钮一闪一闪。
 */
export function setTokenLinks(
  tokenId: string, now: number,
  links: { imageUrl: string | null; websiteUrl: string | null;
           twitterUrl: string | null; telegramUrl: string | null },
): void {
  if (!links.imageUrl && !links.websiteUrl && !links.twitterUrl && !links.telegramUrl) return;
  getDb().run(sql`
    INSERT INTO token_meta (token_id, holder_count, symbol, fetched_at,
                            image_url, website_url, twitter_url, telegram_url)
    VALUES (${tokenId}, NULL, NULL, ${now},
            ${links.imageUrl}, ${links.websiteUrl}, ${links.twitterUrl}, ${links.telegramUrl})
    ON CONFLICT(token_id) DO UPDATE SET
      image_url    = COALESCE(${links.imageUrl},    image_url),
      website_url  = COALESCE(${links.websiteUrl},  website_url),
      twitter_url  = COALESCE(${links.twitterUrl},  twitter_url),
      telegram_url = COALESCE(${links.telegramUrl}, telegram_url)
  `);
}

export interface TokenLinks {
  tokenId: string;
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
}

/** 一次取一批，页面渲染时按 tokenId 查 —— 别在列表里一行一次查库 */
export function listTokenLinks(): Map<string, TokenLinks> {
  const rows = getDb().select({
    tokenId: tokenMeta.tokenId, imageUrl: tokenMeta.imageUrl,
    websiteUrl: tokenMeta.websiteUrl, twitterUrl: tokenMeta.twitterUrl,
    telegramUrl: tokenMeta.telegramUrl,
  }).from(tokenMeta).all();
  const m = new Map<string, TokenLinks>();
  for (const r of rows) {
    if (r.imageUrl || r.websiteUrl || r.twitterUrl || r.telegramUrl) m.set(r.tokenId, r);
  }
  return m;
}

export function markTokenAttempted(tokenId: string, now: number): void {
  getDb().run(sql`
    INSERT INTO token_meta (token_id, holder_count, symbol, fetched_at, last_attempt_at)
    VALUES (${tokenId}, NULL, NULL, 0, ${now})
    ON CONFLICT(token_id) DO UPDATE SET last_attempt_at = ${now}
  `);
}

export function markTokensAttempted(tokenIds: readonly string[], now: number): void {
  if (tokenIds.length === 0) return;
  const db = getRawDb();
  const statement = db.prepare(
    `INSERT INTO token_meta (token_id, holder_count, symbol, fetched_at, last_attempt_at)
     VALUES (?, NULL, NULL, 0, ?)
     ON CONFLICT(token_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`,
  );
  db.transaction((ids: readonly string[]) => {
    for (const id of ids) statement.run(id, now);
  })(tokenIds);
}

export function markTokenQuoteSucceeded(tokenId: string, now: number, liquidityUsd?: number): void {
  const liq = liquidityUsd ?? null;
  getDb().run(sql`
    INSERT INTO token_meta
      (token_id, holder_count, symbol, fetched_at, last_attempt_at, last_quote_ok_at,
       last_liquidity_usd)
    VALUES (${tokenId}, NULL, NULL, 0, ${now}, ${now}, ${liq})
    ON CONFLICT(token_id) DO UPDATE SET
      last_attempt_at = ${now},
      last_quote_ok_at = ${now},
      last_liquidity_usd = COALESCE(${liq}, last_liquidity_usd)
  `);
}

/** 正常完成查询但上游明确表示没有可用池，不按技术故障高频重试。 */
export function markTokenCheckedWithoutQuote(tokenId: string, now: number): void {
  getDb().run(sql`
    INSERT INTO token_meta
      (token_id, holder_count, symbol, fetched_at, last_attempt_at, last_eval_at,
       last_eval_ok_at, next_retry_at, eval_failure_count)
    VALUES (${tokenId}, NULL, NULL, 0, ${now}, ${now}, ${now}, NULL, 0)
    ON CONFLICT(token_id) DO UPDATE SET
      last_attempt_at = ${now},
      last_eval_at = ${now},
      last_eval_ok_at = ${now},
      next_retry_at = NULL,
      eval_failure_count = 0
  `);
}

/** 技术失败或判定异常：不推进成功水位，按确定性有界退避重试。 */
export function markTokenEvaluationFailed(tokenId: string, now: number): number {
  const tx = getRawDb().transaction(() => {
    const row = getRawDb().prepare(
      `SELECT eval_failure_count AS n FROM token_meta WHERE token_id = ?`,
    ).get(tokenId) as { n: number } | undefined;
    const failureCount = (row?.n ?? 0) + 1;
    const nextRetryAt = now + tokenRetryDelaySeconds(tokenId, failureCount);
    getRawDb().prepare(
      `INSERT INTO token_meta
         (token_id, holder_count, symbol, fetched_at, last_attempt_at,
          next_retry_at, eval_failure_count)
       VALUES (?, NULL, NULL, 0, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
         last_attempt_at=excluded.last_attempt_at,
         next_retry_at=excluded.next_retry_at,
         eval_failure_count=excluded.eval_failure_count`,
    ).run(tokenId, now, nextRetryAt, failureCount);
    return nextRetryAt;
  });
  return tx();
}

export function markTokenEvaluated(tokenId: string, now: number, liquidityUsd?: number): void {
  const liq = liquidityUsd ?? null;
  getDb().run(sql`
    INSERT INTO token_meta
      (token_id, holder_count, symbol, fetched_at, last_attempt_at, last_quote_ok_at,
       last_eval_at, last_eval_ok_at, next_retry_at, eval_failure_count,
       last_liquidity_usd)
    VALUES (${tokenId}, NULL, NULL, 0, ${now}, ${now}, ${now}, ${now}, NULL, 0, ${liq})
    ON CONFLICT(token_id) DO UPDATE SET
      last_attempt_at = ${now},
      last_quote_ok_at = ${now},
      last_eval_at = ${now},
      last_eval_ok_at = ${now},
      next_retry_at = NULL,
      eval_failure_count = 0,
      last_liquidity_usd = COALESCE(${liq}, last_liquidity_usd)
  `);
}
