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
import { getSecrets } from '../lib/config.ts';
import { isAdminName } from '../lib/adminAuth.ts';
import { makeLogger } from '../lib/log.ts';
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

const streaks = new Map<string, number>();
const lastAlertAt = new Map<string, number>();

/** 管理员账号。没配 ADMIN_ACCOUNT 时返回空 —— 那种情况下无人可报，只留日志 */
function adminUserIds(): string[] {
  const configured = getSecrets().adminAccount;
  if (!configured) return [];
  const rows = getRawDb().prepare(`SELECT id, name FROM users`).all() as
    Array<{ id: string; name: string }>;
  return rows.filter((u) => isAdminName(u.name, configured)).map((u) => u.id);
}

/**
 * 记一次核对结果，必要时报警。
 *
 * @param sourceId 被看护的源
 * @param verdict  本轮判定
 * @param detail   给人看的一句话，直接进报警正文
 */
export function recordVerdict(
  sourceId: string, verdict: HealthVerdict, now: number, detail: string,
): void {
  if (verdict.ok) {
    if ((streaks.get(sourceId) ?? 0) > 0) {
      log.info(`${sourceId} 恢复正常（${detail}）`);
    }
    streaks.set(sourceId, 0);
    return;
  }

  const streak = (streaks.get(sourceId) ?? 0) + 1;
  streaks.set(sourceId, streak);
  log.warn(`${sourceId} 第 ${streak} 轮不合格：${verdict.reason}（${detail}）`);
  if (streak < FAIL_STREAK_BEFORE_ALERT) return;

  const last = lastAlertAt.get(sourceId) ?? 0;
  if (now - last < REALERT_SECONDS) return;

  const admins = adminUserIds();
  if (admins.length === 0) {
    log.warn(`${sourceId} 已连续 ${streak} 轮不合格，但没有配置管理员账号，无人可报`);
    return;
  }
  lastAlertAt.set(sourceId, now);

  for (const userId of admins) {
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
  }
  log.warn(`${sourceId} 连续 ${streak} 轮不合格，已通知 ${admins.length} 位管理员：${verdict.reason}`);
}

/** 供测试重置内存状态 */
export function resetWatchState(): void {
  streaks.clear();
  lastAlertAt.clear();
}
