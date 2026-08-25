import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import { sanitizeName, readName, USER_COOKIE } from '../../../lib/user.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  return NextResponse.json({ name: readName(req) });
}

export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: { name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  const name = sanitizeName(String(body.name ?? ''));
  if (!name) return NextResponse.json({ error: '名字不能为空' }, { status: 400 });

  const res = NextResponse.json({ name });
  // 署名而非身份，不需要 httpOnly —— 前端要读它来显示当前用户。
  // **不要手动 encodeURIComponent**：NextResponse.cookies.set 自己会编码，
  // 再编一次就成了 %25E8%2580... 这种双重编码，读出来是一串百分号。
  res.cookies.set(USER_COOKIE, name, {
    sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
