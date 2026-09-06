/**
 * 报价源健康看护 —— 坏了要报给管理员，而不是静静烂掉。
 *
 * 接入 XXYY 是接了一个**没有公开文档的私有接口**：对方随时可能改路径、
 * 改字段、加鉴权，而最危险的是**静默地改** —— 某天开始给所有币回 0，
 * 或者悄悄换了价格口径。今天已经被数据源坑过三次，三次都是"接口正常
 * 返回 200、字段齐全、只是数字是错的"。
 *
 * 所以这里做两件事：
 *   1. 每轮拿新源与 DexScreener 的重叠部分对一次（sourceAgreement）
 *   2. 连续多轮不合格就给管理员发一条报警，走的是已有的报警通道
 *      —— 用户已经在盯那个通道，不用再学一套新东西
 */
import * as wr from '../db/walletRepo.ts';
import { getRawDb } from '../db/index.ts';
import { makeLogger } from '../lib/log.ts';
import { scrubSecrets } from '../lib/mask.ts';
import { randomUUID } from 'node:crypto';
import type { HealthVerdict } from './sourceAgreement.ts';

const log = makeLogger('source-watch');

/**
 * 连续这么多轮不合格才报警。
 *
 * 单轮不合格很可能只是采样时刻错开（两个源不是同一秒取的价），
 * 报一次就吵一次会让人很快开始忽略它 —— 而这条报警的全部价值在于
 * 它很少响、一响就是真的。
 */
export const FAIL_STREAK_BEFORE_ALERT = 5;

/** 报过之后隔这么久才再报一次，避免一直坏着一直吵 */
export const REALERT_SECONDS = 6 * 3600;

/** 用户明确指定：报价源故障只通知这个账号。 */
export const SOURCE_ALERT_ACCOUNT = 'pananiu';

function alertUserId(): string | null {
  const row = getRawDb().prepare(
    `SELECT id FROM users WHERE name = ? LIMIT 1`,
  ).get(SOURCE_ALERT_ACCOUNT) as { id: string } | undefined;
  return row?.id ?? null;
}

function currentFailureStreak(sourceId: string): number {
  const row = getRawDb().prepare(
    `SELECT consecutive_failures AS n FROM source_health WHERE source_id = ?`,
  ).get(sourceId) as { n: number } | undefined;
  return row?.n ?? 0;
}

function recordHealthy(sourceId: string, now: number): void {
  getRawDb().prepare(
    `INSERT INTO source_health (source_id, last_ok_at, consecutive_failures)
     VALUES (?, ?, 0)
     ON CONFLICT(source_id) DO UPDATE SET
       last_ok_at = excluded.last_ok_at,
       consecutive_failures = 0`,
  ).run(sourceId, now);
}

function recordFailure(sourceId: string, now: number, message: string): number {
  const next = currentFailureStreak(sourceId) + 1;
  getRawDb().prepare(
    `INSERT INTO source_health
       (source_id, last_fail_at, last_fail_kind, last_fail_message, consecutive_failures)
     VALUES (?, ?, 'agreement', ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       last_fail_at = excluded.last_fail_at,
       last_fail_kind = excluded.last_fail_kind,
       last_fail_message = excluded.last_fail_message,
       consecutive_failures = excluded.consecutive_failures`,
  ).run(sourceId, now, scrubSecrets(message), next);
  return next;
}

function lastAlertTime(userId: string, sourceId: string): number {
  const row = getRawDb().prepare(
    `SELECT MAX(fired_at) AS at FROM pump_alerts
     WHERE user_id = ? AND token_id = ? AND kind = 'source-down'`,
  ).get(userId, `system:${sourceId}`) as { at: number | null } | undefined;
  return row?.at ?? 0;
}

/**
 * 记一次核对结果，必要时报警。
 *
 * @param sourceId 被看护的源
 * @param verdict  本轮判定
 * @param detail   给人看的一句话，写进健康状态与服务器日志，便于排查
 */
export function recordVerdict(
  sourceId: string, verdict: HealthVerdict, now: number, detail: string,
): void {
  if (verdict.ok) {
    if (currentFailureStreak(sourceId) > 0) {
      log.info(`${sourceId} 恢复正常（${detail}）`);
    }
    recordHealthy(sourceId, now);
    return;
  }

  const message = `${verdict.reason ?? '未知故障'}（${detail}）`;
  const streak = recordFailure(sourceId, now, message);
  log.warn(`${sourceId} 第 ${streak} 轮不合格：${verdict.reason}（${detail}）`);
  if (streak < FAIL_STREAK_BEFORE_ALERT) return;

  const userId = alertUserId();
  if (!userId) {
    log.warn(`${sourceId} 已连续 ${streak} 轮不合格，但找不到账号 ${SOURCE_ALERT_ACCOUNT}`);
    return;
  }
  if (now - lastAlertTime(userId, sourceId) < REALERT_SECONDS) return;

  wr.insertPumpAlert({
    id: randomUUID(),
    userId,
    // 用一个不存在的 token_id 承载：报警通道是现成的，
    // 而 kind 让前端知道这不是行情、是系统消息
    tokenId: `system:${sourceId}`,
    firedAt: now,
    timeframe: '24h',
    basis: 'low',
    level: 0,
    multiple: '1',
    priceUsd: null,
    basePriceUsd: null,
    balance: null,
    valueUsd: null,
    kind: 'source-down',
    athWindow: null,
    marketCapUsd: null,
  });
  log.warn(`${sourceId} 连续 ${streak} 轮不合格，已通知 ${SOURCE_ALERT_ACCOUNT}：${verdict.reason}`);
}

/** 供测试隔离状态；生产代码不会调用。 */
export function resetWatchState(): void {
  const db = getRawDb();
  db.prepare(`DELETE FROM source_health WHERE source_id = 'xxyy'`).run();
  db.prepare(`DELETE FROM pump_alerts WHERE token_id = 'system:xxyy' AND kind = 'source-down'`).run();
}
