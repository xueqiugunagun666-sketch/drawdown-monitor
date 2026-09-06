import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { pumpAlertSnapshot } from '../../../../db/walletRepo.ts';
import { enrichAlerts } from '../../../../db/alertEnrich.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
  const sinceTs = Number.isFinite(since) && since > 0
    ? since
    : Math.floor(Date.now() / 1000) - 7 * 86400;
  /**
   * 补上币名。没有它，用户听到播报打开页面看到的是一串十六进制，
   * 根本不知道是哪个币暴涨了 —— 这正是这个功能存在的意义。
   */
  const snapshot = pumpAlertSnapshot(u.id, sinceTs);
  return NextResponse.json({
    snapshotSeq: snapshot.snapshotSeq,
    alerts: enrichAlerts(snapshot.alerts),
  });
}
