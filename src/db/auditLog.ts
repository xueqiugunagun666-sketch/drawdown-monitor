/**
 * 审计日志的写与读。
 *
 * `recordAudit` **不自己开事务** —— 它要能被包进调用方的事务里，
 * 这样「删除 + 记日志」才是原子的。日志写失败就让整个操作回滚：
 * best-effort 的审计在最需要它的时候恰好可能是空的。
 */
import { desc } from 'drizzle-orm';
import { getDb } from './index.ts';
import { auditLog } from './schema.ts';
import { nowSec } from '../lib/time.ts';

export type AuditAction =
  | 'delete_token' | 'delete_event'
  | 'update_note'
  | 'set_enabled' | 'set_frozen'
  | 'update_rules';

export interface AuditInput {
  actorId: string | null;
  actorName: string;
  action: AuditAction;
  targetType: 'token' | 'event' | 'rules';
  targetId: string | null;
  targetLabel: string | null;
  /** 主要存旧值 —— 改备注时不存旧内容的话，原文就永久丢了 */
  detail?: unknown;
}

export function recordAudit(input: AuditInput): void {
  getDb().insert(auditLog).values({
    atTs: nowSec(),
    actorId: input.actorId,
    actorName: input.actorName,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetLabel: input.targetLabel,
    detail: input.detail === undefined ? null : JSON.stringify(input.detail),
  }).run();
}

export function listAudit(limit = 50) {
  return getDb().select().from(auditLog).orderBy(desc(auditLog.atTs), desc(auditLog.id)).limit(limit).all();
}
