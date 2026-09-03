/**
 * 管理员判定。
 *
 * 用账号名而不是 id：users.name 有 unique 约束，是稳定键；
 * id 是 uuid，写进 .env 没法人工核对对不对。
 *
 * `ADMIN_ACCOUNT` 支持逗号分隔的多个账号名。变量名是单数，因为它
 * 早于「多管理员」这个需求存在，改名要冒一个「新变量没配上、旧变量
 * 已失效 = 没有人是管理员」的窗口，不值得。
 *
 * **未配置时没有人是管理员**（fail closed）。反过来默认人人可删的话，
 * 配置一丢就等于把删除权限敞开给所有人 —— 那正是这次要消除的状态。
 */
import { getSecrets } from './config.ts';
import type { Account } from './accountAuth.ts';

/** 纯判定，配置值由调用方传入 —— 这样测试不用摆弄 process.env */
export function isAdminName(name: string, configured: string | undefined): boolean {
  const got = (name ?? '').trim();
  if (!got) return false;
  return (configured ?? '')
    .split(',')
    .map((s) => s.trim())
    // 空条目必须先滤掉再比：多打一个逗号不能变成「匹配空名字」。
    // 上面已经挡了空的 got，这里是第二道，两处都留着
    .filter((s) => s.length > 0)
    // 整体相等，不做前缀或包含匹配 —— 这个项目里 retend 与 retend666
    // 是两个真实存在的不同账号，包含匹配会把后者一起提权
    .includes(got);
}

export function isAdmin(account: Account | null): boolean {
  if (!account) return false;
  return isAdminName(account.name, getSecrets().adminAccount);
}
