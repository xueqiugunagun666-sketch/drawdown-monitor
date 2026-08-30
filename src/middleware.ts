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
const WALLET_COOKIE = 'wallet_session';

/** 不需要全站口令就能访问的路径 */
const PUBLIC_PATHS = ['/login', '/api/login'];

/**
 * 钱包区：在全站口令之上再要一次个人账号登录。
 * 这几条自己不能被拦，否则会重定向到自己形成死循环。
 */
const WALLET_PREFIXES = ['/wallet', '/api/wallet'];
const WALLET_PUBLIC = ['/wallet/login', '/api/account'];

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
  const siteOk = provided === expected || bearer === expected;
  if (siteOk) return walletGate(req, pathname);

  // API 请求返回 401，页面请求跳登录
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

/**
 * 钱包区的第二道闸。
 *
 * 中间件跑在 edge runtime，**不能查数据库**，所以这里只看 cookie 在不在。
 * 会话是否真的有效由各路由里的 currentUser() 判定 —— 这是有意的两层：
 * 中间件挡掉未登录的浏览，路由做真正的鉴权。只有中间件是不够的。
 */
function walletGate(req: NextRequest, pathname: string) {
  const needsAccount = WALLET_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (!needsAccount) return NextResponse.next();
  if (WALLET_PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (req.cookies.get(WALLET_COOKIE)?.value) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/wallet/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // 静态资源与图标不拦
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
