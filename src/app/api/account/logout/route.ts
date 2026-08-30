import { NextResponse } from 'next/server';
import { SESSION_COOKIE, hashToken } from '../../../../lib/session.ts';
import { deleteSession } from '../../../../db/walletRepo.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (m?.[1]) {
    // 服务端也要删，不能只清 cookie —— 否则被拷走的 token 仍然有效
    try { deleteSession(hashToken(decodeURIComponent(m[1]))); } catch { /* 已经无效 */ }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
