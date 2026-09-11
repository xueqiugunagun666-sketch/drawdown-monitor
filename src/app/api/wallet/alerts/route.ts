import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { pumpAlertSnapshot } from '../../../../db/walletRepo.ts';
import { enrichAlerts } from '../../../../db/alertEnrich.ts';
import { listSourceHealth } from '../../../../db/repo.ts';
import { FAIL_STREAK_BEFORE_ALERT } from '../../../../worker/sourceWatch.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  const url = new URL(req.url);
  const activeSourceFailures = listSourceHealth()
    .filter((row) => row.consecutiveFailures >= FAIL_STREAK_BEFORE_ALERT)
    .map((row) => row.sourceId);
  // 页面有故障横幅时每 30 秒只取这份很小的集合，不重复拉七天报警历史。
  if (url.searchParams.get('source_health') === '1') {
    return NextResponse.json({ activeSourceFailures });
  }
  const since = Number(url.searchParams.get('since') ?? 0);
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
    activeSourceFailures,
  });
}
