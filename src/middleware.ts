/**
 * 未登录一律挡在门外。
 *
 * 之前只有 API 路由检查鉴权，页面本身是裸奔的 —— 放到公网上
 * 任何人都能直接打开看板。这里统一在中间件拦。
 *
 * 中间件跑在 edge runtime，不能用 node 的 fs，因此直接读 env，
 * 不走 lib/config.ts。
 */
import { NextResponse, type NextRequest } from 'next/server';

const COOKIE_NAME = 'access_token';

/** 不需要登录就能访问的路径 */
const PUBLIC_PATHS = ['/login', '/api/login'];

export function middleware(req: NextRequest) {
  const expected = process.env.ACCESS_TOKEN;
  // 没设口令 = 本机开发模式，不拦（worker 启动时会打警告）
  if (!expected) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const provided = req.cookies.get(COOKIE_NAME)?.value;
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided === expected || bearer === expected) return NextResponse.next();

  // API 请求返回 401，页面请求跳登录
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // 静态资源与图标不拦
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
