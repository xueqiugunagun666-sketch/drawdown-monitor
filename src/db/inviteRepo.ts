/**
 * 注册邀请码。
 *
 * 取代原来那个「所有人共用一个、永不过期」的全站口令：
 * 一个码带一个次数上限，用完自动失效，发给谁也能标注。
 *
 * 只在**注册**时校验并消耗 —— 登录和日常访问都不需要码，
 * 已有账号的人一次都不会消耗额度。
 */
import { eq, desc } from 'drizzle-orm';
import { randomInt, createHash } from 'node:crypto';
import { getDb, getRawDb } from './index.ts';
import { inviteCodes } from './schema.ts';
import { nowSec } from '../lib/time.ts';

/**
 * 码用的字符集：去掉了 0/O、1/I/L 这些手抄会认错的。
 * 这个码要通过聊天软件转发、可能被人手打，可读性比字符集大小重要。
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 4;
const PER_GROUP = 4;

/** 生成一个新码，形如 K7MP-3XQR-9TFW-2HBN。约 79 位熵，够用 */
export function generateCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  return Array.from({ length: GROUPS },
    () => Array.from({ length: PER_GROUP }, pick).join('')).join('-');
}

/** 与会话 token 同一种哈希，库里不存明文 */
export function hashCode(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

/**
 * 比对前先规范化：转发过来的码常带空格，也有人习惯打小写或漏掉连字符。
 * 这些都不该算错码 —— 字符集本身没有小写，不存在大小写冲突。
 */
function normalize(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function createInviteCode(code: string, label: string | null, maxUses: number): void {
  getDb().insert(inviteCodes).values({
    codeHash: hashCode(code),
    label,
    maxUses,
    usedCount: 0,
    createdAt: nowSec(),
  }).run();
}

export type ConsumeResult =
  | { ok: true; label: string | null; remaining: number }
  | { ok: false; reason: '邀请码不对' | '这个邀请码已经用完了' };

/**
 * 核销一次。
 *
 * **必须是单条 UPDATE**：先 SELECT 判断次数、再 UPDATE 的话，
 * 两个人同时用最后一次额度会双双通过。把条件写进 WHERE，
 * 由 SQLite 保证「判断 + 自增」不可分割，看 changes 就知道成没成。
 */
export function consumeInviteCode(code: string): ConsumeResult {
  const hash = hashCode(code);
  const raw = getRawDb();

  const res = raw.prepare(
    `UPDATE invite_codes
        SET used_count = used_count + 1, last_used_at = ?
      WHERE code_hash = ? AND used_count < max_uses`,
  ).run(nowSec(), hash);

  if (res.changes === 1) {
    const row = raw.prepare(
      'SELECT label, max_uses, used_count FROM invite_codes WHERE code_hash = ?',
    ).get(hash) as { label: string | null; max_uses: number; used_count: number };
    return { ok: true, label: row.label, remaining: row.max_uses - row.used_count };
  }

  // 没更新到：要么码不存在，要么额度已满。这两种要分开告诉用户 ——
  // 「码不对」会让人去核对字符，「已用完」会让人来找你要新的
  const exists = raw.prepare(
    'SELECT 1 FROM invite_codes WHERE code_hash = ?',
  ).get(hash);
  return { ok: false, reason: exists ? '这个邀请码已经用完了' : '邀请码不对' };
}

/**
 * 把已核销的一次退回去。
 *
 * 用于「码没问题、但账号最终没建成」的情况（目前只有用户名撞车）。
 * 不退的话用户换个名字重试会发现码少了一次，而他什么都没得到。
 *
 * 用 `used_count > 0` 兜底，避免任何情况下减成负数。
 */
export function refundInviteCode(code: string): void {
  getRawDb().prepare(
    'UPDATE invite_codes SET used_count = used_count - 1 WHERE code_hash = ? AND used_count > 0',
  ).run(hashCode(code));
}

export function listInviteCodes() {
  return getDb().select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt)).all();
}

export function deleteInviteCode(codeHash: string): boolean {
  return getDb().delete(inviteCodes).where(eq(inviteCodes.codeHash, codeHash)).run().changes > 0;
}
