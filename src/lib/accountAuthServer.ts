/**
 * 把「会话」翻译成「Actor」的唯一入口。
 *
 * 两个函数对应两种调用场景，但结论必须一致 —— 所以共用同一个
 * toActor：服务端组件按它渲染按钮，路由按它判权限，两边算法一旦
 * 分叉就会出现「按钮看得见但点了被拒」或者更糟的反过来。
 *
 * 单独一个文件而不是塞进 accountAuth.ts：`next/headers` 只能在
 * Next 的服务端上下文里 import，混进去会让 accountAuth.ts 在
 * node:test 与 worker 进程里直接崩掉。
 */
import { cookies } from 'next/headers';
import { currentUser } from './accountAuth.ts';
import { SESSION_COOKIE, hashToken } from './session.ts';
import { findUserBySessionHash } from '../db/walletRepo.ts';
import { isAdmin } from './adminAuth.ts';
import type { Actor } from './permissions.ts';

function toActor(account: { id: string; name: string } | null): Actor | null {
  if (!account) return null;
  return { id: account.id, name: account.name, isAdmin: isAdmin(account) };
}

/** 服务端组件用：从 next/headers 取 cookie */
export async function currentActor(): Promise<Actor | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return toActor(findUserBySessionHash(hashToken(raw), Math.floor(Date.now() / 1000)));
}

/** API 路由用：从 Request 取。Task 8/9/10 三个路由都 import 这个 */
export function actorFromRequest(req: Request): Actor | null {
  return toActor(currentUser(req));
}
