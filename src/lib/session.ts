/**
 * 个人会话。这是全站唯一的身份来源（共用口令已撤销）：
 * 那个决定"进不进得来"，这个决定"进来之后你是谁"。
 *
 * 库里只存 token 的 sha256：数据库泄露时拿不到可用的会话凭证。
 * token 本身足够随机（32 字节），不需要额外加盐 —— 加盐是为了防
 * 彩虹表攻击低熵输入，这里输入不是低熵的。
 */
import { randomBytes, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'wallet_session';
export const SESSION_TTL_SECONDS = 30 * 86400;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
