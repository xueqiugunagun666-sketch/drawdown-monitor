import { NextResponse } from 'next/server';
import { checkAuth } from '../../../../../lib/auth.ts';
import * as repo from '../../../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  const url = new URL(req.url);
  const timeframe = url.searchParams.get('timeframe') ?? '5m';
  const from = Number(url.searchParams.get('from') ?? 0);
  const quoteMode = url.searchParams.get('quoteMode') ?? 'usd';

  if (!repo.getToken(tokenId)) {
    return NextResponse.json({ error: '代币不存在' }, { status: 404 });
  }

  const rows = repo.getCandles(tokenId, timeframe, from);
  // 图表用 number —— 仅供显示，不参与任何阈值判定，那些一律走 Decimal
  const candles = rows.flatMap((r) => {
    const o = quoteMode === 'usd' ? r.o : r.oNative;
    const h = quoteMode === 'usd' ? r.h : r.hNative;
    const l = quoteMode === 'usd' ? r.l : r.lNative;
    const c = quoteMode === 'usd' ? r.c : r.cNative;
    if (!o || !h || !l || !c) return [];
    return [{ time: r.ts, open: +o, high: +h, low: +l, close: +c }];
  });

  return NextResponse.json({ timeframe, quoteMode, count: candles.length, candles });
}
