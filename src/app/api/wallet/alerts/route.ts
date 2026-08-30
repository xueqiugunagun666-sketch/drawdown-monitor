import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listPumpAlerts } from '../../../../db/walletRepo.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
  const sinceTs = Number.isFinite(since) && since > 0
    ? since
    : Math.floor(Date.now() / 1000) - 7 * 86400;
  return NextResponse.json({ alerts: listPumpAlerts(u.id, sinceTs) });
}
