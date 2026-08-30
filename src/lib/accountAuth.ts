/**
 * 个人账号的唯一身份入口。
 *
 * **所有钱包相关的 API 必须用它取 userId，绝不从请求体或查询参数读。**
 * 一旦某个路由接受了客户端传来的 user_id，隔离就名存实亡 ——
 * 任何人改个参数就能看别人的持仓。
 */
import { SESSION_COOKIE, hashToken } from './session.ts';
import { findUserBySessionHash } from '../db/walletRepo.ts';

export interface Account { id: string; name: string }

export function currentUser(req: Request): Account | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (!m?.[1]) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]);
  } catch {
    return null;                     // cookie 被截断或篡改
  }
  return findUserBySessionHash(hashToken(raw), Math.floor(Date.now() / 1000));
}

/** 路由里的常用形态：没登录直接给 401 */
export function requireUser(req: Request): Account | Response {
  const u = currentUser(req);
  if (!u) {
    return new Response(JSON.stringify({ error: '需要登录个人账号' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  return u;
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}
