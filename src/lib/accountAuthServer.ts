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

/** API 路由用：从 Request 取 */
export function actorFromRequest(req: Request): Actor | null {
  return toActor(currentUser(req));
}

/**
 * 路由里的标准开头：没登录直接 401。
 *
 * **每个路由都必须调用它，只读的也不例外。** 中间件跑在 edge runtime
 * 查不了数据库，只能判断 `wallet_session` cookie 存不存在、判断不了
 * 有没有效 —— 手动设一个 `wallet_session=x` 就能过中间件。共享口令
 * 撤掉之后，只读接口若不自查，整个看板会被读出去。
 *
 * 用法：
 *   const actor = requireActor(req);
 *   if (isDenied(actor)) return actor;
 */
export function requireActor(req: Request): Actor | Response {
  const actor = actorFromRequest(req);
  if (!actor) {
    return new Response(JSON.stringify({ error: '需要登录' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  return actor;
}

export function isDenied(x: Actor | Response): x is Response {
  return x instanceof Response;
}
