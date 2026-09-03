import { NextResponse } from 'next/server';
import { hashPassword } from '../../../../lib/password.ts';
import { newSessionToken, hashToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../../../../lib/session.ts';
import { createUser, createSession } from '../../../../db/walletRepo.ts';
import { sanitizeName } from '../../../../lib/sanitizeName.ts';
import { consumeInviteCode, refundInviteCode } from '../../../../db/inviteRepo.ts';
import { checkRateLimit, recordFailure, clientIp } from '../../../../lib/authToken.ts';
import { makeLogger } from '../../../../lib/log.ts';

export const dynamic = 'force-dynamic';
const log = makeLogger('account');

/** 密码最短长度。这是熟人圈子工具，不强制复杂度，但太短没有意义 */
const MIN_PASSWORD = 8;

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `尝试次数过多，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再试` },
      { status: 429 },
    );
  }

  let body: { name?: string; password?: string; invite?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求格式错误' }, { status: 400 }); }

  const name = sanitizeName(body.name ?? '');
  const password = body.password ?? '';
  if (!name) return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json({ error: `密码至少 ${MIN_PASSWORD} 位` }, { status: 400 });
  }

  // 邀请码放在最后校验、也就是所有格式问题都排除之后：
  // 用户名重复或密码太短就把码消耗掉，那一次额度就白扔了
  const invite = consumeInviteCode(body.invite ?? '');
  if (!invite.ok) {
    recordFailure(ip);
    return NextResponse.json({ error: invite.reason }, { status: 403 });
  }

  const user = createUser(name, await hashPassword(password));
  if (!user) {
    // 码已经核销但账号没建成，把这一次退回去 —— 否则用户换个名字重试
    // 就会发现码莫名其妙少了一次，而他什么都没得到
    refundInviteCode(body.invite ?? '');
    recordFailure(ip);
    return NextResponse.json({ error: '这个用户名已经被用了' }, { status: 409 });
  }

  // 注册成功直接登录，省一步
  const token = newSessionToken();
  createSession(user.id, hashToken(token), Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  log.info(`新账号: ${name}（邀请码剩余 ${invite.remaining} 次${invite.label ? `，备注 ${invite.label}` : ''}）`);

  const res = NextResponse.json({ ok: true, name: user.name });
  // 不要手动 encodeURIComponent —— cookies.set 已经会编码，
  // 手动再编一次会产生 %25E8%2580 这种双重编码（用户名 cookie 上踩过）
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/', maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
