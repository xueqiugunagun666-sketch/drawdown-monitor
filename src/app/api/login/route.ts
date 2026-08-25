import { NextResponse } from 'next/server';
import { getSecrets } from '../../../lib/config.ts';
import { makeLogger } from '../../../lib/log.ts';
import {
  tokenMatches, checkRateLimit, recordFailure, clearFailures, clientIp, COOKIE_NAME,
} from '../../../lib/authToken.ts';

export const dynamic = 'force-dynamic';

const log = makeLogger('login');

export async function POST(req: Request) {
  const { accessToken } = getSecrets();
  if (!accessToken) {
    return NextResponse.json({ error: '服务端未设置 ACCESS_TOKEN，无需登录' }, { status: 400 });
  }

  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    log.warn(`登录限流: ${ip} 尝试过于频繁`);
    return NextResponse.json(
      { error: `尝试次数过多，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再试` },
      { status: 429 },
    );
  }

  let body: { password?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求格式错误' }, { status: 400 }); }

  const password = body.password ?? '';
  if (!password || !tokenMatches(password, accessToken)) {
    recordFailure(ip);
    // 不回显任何口令内容
    log.warn(`登录失败: ${ip}`);
    return NextResponse.json({ error: '口令不正确' }, { status: 401 });
  }

  clearFailures(ip);
  log.info(`登录成功: ${ip}`);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,   // 30 天
  });
  return res;
}

export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { path: '/', maxAge: 0 });
  log.info(`登出: ${clientIp(req)}`);
  return res;
}
