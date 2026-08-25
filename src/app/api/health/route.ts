import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import { getConfig } from '../../../lib/config.ts';
import { nowSec } from '../../../lib/time.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const cfg = getConfig();
  const tokens = repo.listAllTokens();
  const cutoff = nowSec() - cfg.polling.staleMinutes * 60;
  const stale = tokens.filter(
    (t) => t.enabled === 1 && t.frozen === 0 && (t.lastQuoteAt === null || t.lastQuoteAt < cutoff),
  );
  const lastRun = repo.getLastPollRun();

  // 投递失败的报警（§8.3：UI 顶部横幅）
  const failedDeliveries = repo.listAlerts(50).filter((a) => {
    if (!a.delivered) return a.firedAt > nowSec() - 7200;
    try {
      return (JSON.parse(a.delivered) as Array<{ ok: boolean }>).some((d) => !d.ok);
    } catch { return true; }
  }).length;

  return NextResponse.json({
    tokens: tokens.length,
    enabled: tokens.filter((t) => t.enabled === 1).length,
    staleTokens: stale.map((t) => ({ id: t.id, lastQuoteAt: t.lastQuoteAt, failCount: t.failCount })),
    failedDeliveries,
    lastPoll: lastRun
      ? { startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt,
          requested: lastRun.tokensRequested, covered: lastRun.tokensCovered,
          errors: lastRun.errors ? JSON.parse(lastRun.errors) : [] }
      : null,
    sources: repo.listSourceHealth(),
  });
}
