/**
 * 未登录一律挡在门外。
 *
 * 以前是两道门：全站共用一个口令进站，进来再登个人账号。共用口令
 * 已经撤掉 —— 它永不过期、发出去就收不回、也分不清是谁在用。现在
 * 只剩账号一道门，新人凭**邀请码**注册（见 src/db/inviteRepo.ts）。
 *
 * 中间件跑在 edge runtime，**不能查数据库**，所以这里只判断
 * `wallet_session` cookie 在不在，判断不了它有没有效。真正的校验
 * 由各路由的 requireActor() 做。这不是冗余而是分工：中间件挡掉
 * 未登录的浏览，路由做真鉴权。
 *
 * **每个路由都必须自查**，只读的也不例外 —— 手动设一个
 * wallet_session=x 就能过这一层。
 */
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'wallet_session';

/**
 * 不需要登录就能访问的路径：注册与登录入口本身。
 * 它们不能被闸门拦，否则会重定向到自己形成死循环。
 */
const PUBLIC_PATHS = ['/wallet/login', '/api/account'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  // API 请求返回 401，页面请求跳登录
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '需要登录' }, { status: 401 });
  }

  // 把原本想去的地方带上，登录后跳回去。
  // 不带的话，为了看看板而来的人登完会落在别处，还得自己找回来
  const url = req.nextUrl.clone();
  url.pathname = '/wallet/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * 静态资源与图标不拦。
   *
   * icon.svg 是 Next 的 app/icon.svg 约定生成的路径，必须一起放行 ——
   * 漏了它的后果是登录页没有图标：浏览器拿 307 重定向当不到图片，
   * 标签栏上就是个空白方块，而登录页恰恰是新人看到的第一个页面。
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.svg).*)'],
};
