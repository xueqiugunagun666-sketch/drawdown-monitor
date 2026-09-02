/**
 * 管理员判定。
 *
 * 用账号名而不是 id：users.name 有 unique 约束，是稳定键；
 * id 是 uuid，写进 .env 没法人工核对对不对。
 *
 * **未配置时没有人是管理员**（fail closed）。反过来默认人人可删的话，
 * 配置一丢就等于把删除权限敞开给所有人 —— 那正是这次要消除的状态。
 */
import { getSecrets } from './config.ts';
import type { Account } from './accountAuth.ts';

/** 纯判定，配置值由调用方传入 —— 这样测试不用摆弄 process.env */
export function isAdminName(name: string, configured: string | undefined): boolean {
  const want = (configured ?? '').trim();
  const got = (name ?? '').trim();
  if (!want || !got) return false;
  return want === got;
}

export function isAdmin(account: Account | null): boolean {
  if (!account) return false;
  return isAdminName(account.name, getSecrets().adminAccount);
}
