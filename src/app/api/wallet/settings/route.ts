/**
 * 每人自己的钱包监控偏好。
 *
 * 注意这里改的**只是自己的东西**，所以不需要管理员判定 —— 与 /api/rules
 * 那种全局规则不是一类。但仍然必须自己校验登录：middleware 跑在 edge
 * runtime 上查不了库，它只看 cookie 存不存在。
 */
import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { getMinAlertValue, setMinAlertValue, MAX_MIN_ALERT_VALUE_USD } from '../../../../db/walletRepo.ts';
import { MIN_ALERT_VALUE_USD } from '../../../../worker/pumpEngine.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  return NextResponse.json({
    minAlertValueUsd: getMinAlertValue(u.id),
    defaultValue: MIN_ALERT_VALUE_USD,
    max: MAX_MIN_ALERT_VALUE_USD,
  });
}

export async function PUT(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  let body: { minAlertValueUsd?: unknown };
  try { body = await req.json() as { minAlertValueUsd?: unknown }; }
  catch { return NextResponse.json({ error: '请求不是合法 JSON' }, { status: 400 }); }

  const raw = body.minAlertValueUsd;
  // null 表示"恢复默认"。undefined 是漏传了字段，不是同一回事
  if (raw !== null && typeof raw !== 'number') {
    return NextResponse.json({ error: '阈值要是数字，清空请传 null' }, { status: 400 });
  }
  if (!setMinAlertValue(u.id, raw)) {
    return NextResponse.json(
      { error: `阈值要在 $0 到 $${MAX_MIN_ALERT_VALUE_USD.toLocaleString('en-US')} 之间` },
      { status: 400 },
    );
  }
  return NextResponse.json({ minAlertValueUsd: getMinAlertValue(u.id) });
}
