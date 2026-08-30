import { NextResponse } from 'next/server';
import { verifyPassword } from '../../../../lib/password.ts';
import { newSessionToken, hashToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../../../../lib/session.ts';
import { findUserByName, createSession } from '../../../../db/walletRepo.ts';
import { sanitizeName } from '../../../../lib/user.ts';
import { checkRateLimit, recordFailure, clearFailures, clientIp } from '../../../../lib/authToken.ts';
import { makeLogger } from '../../../../lib/log.ts';

export const dynamic = 'force-dynamic';
const log = makeLogger('account');

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `尝试次数过多，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再试` },
      { status: 429 },
    );
  }

  let body: { name?: string; password?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求格式错误' }, { status: 400 }); }

  const name = sanitizeName(body.name ?? '');
  const user = name ? findUserByName(name) : null;

  // 用户不存在时也要走一次哈希校验，让响应耗时与"存在但密码错"接近，
  // 否则可以靠响应时间枚举出哪些用户名是存在的
  const ok = user
    ? await verifyPassword(body.password ?? '', user.passwordHash)
    : await verifyPassword(body.password ?? '', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

  if (!user || !ok) {
    recordFailure(ip);
    log.warn(`登录失败: ${ip}`);
    // 不区分"用户名不存在"与"密码错误"，否则可以枚举用户名
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }

  clearFailures(ip);
  const token = newSessionToken();
  createSession(user.id, hashToken(token), Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  log.info(`账号登录: ${user.name}`);

  const res = NextResponse.json({ ok: true, name: user.name });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/', maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
