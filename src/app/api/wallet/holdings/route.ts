import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listHoldings, listWallets } from '../../../../db/walletRepo.ts';
import { getRawDb } from '../../../../db/index.ts';
import { Decimal } from '../../../../lib/decimal.ts';
import { toHumanAmount } from '../../../../sources/erc20.ts';
import { computeMultiples } from '../../../../worker/pumpWindows.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  const holdings = listHoldings(u.id);
  const walletLabel = new Map(listWallets(u.id).map((w) => [w.id, w.label ?? w.address]));
  const db = getRawDb();
  const now = Math.floor(Date.now() / 1000);

  const lastStmt = db.prepare(
    `SELECT c, ts FROM candles WHERE token_id = ? AND timeframe = '5m' ORDER BY ts DESC LIMIT 1`);
  const seriesStmt = db.prepare(
    `SELECT ts, o, l FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ? ORDER BY ts`);

  const rows = holdings.map((h) => {
    const last = lastStmt.get(h.tokenId) as { c: string | null; ts: number } | undefined;
    const amount = toHumanAmount(h.balance, h.decimals);
    const price = last?.c ? new Decimal(last.c) : null;

    /**
     * 当前涨幅倍数。用户需要在报警之前就看到什么在动 ——
     * 冷启动 seed 出来的 FIRED 状态不会产生报警（不为进入监控前的涨幅补报），
     * 所以只看报警记录的话，一个已经涨了 3 倍的币是完全不可见的。
     */
    let best: { multiple: string; timeframe: string; basis: string } | null = null;
    if (price && h.monitored === 1) {
      const candles = seriesStmt.all(h.tokenId, now - 86400 - 600) as
        Array<{ ts: number; o: string | null; l: string | null }>;
      const windows = computeMultiples(candles, price, now);
      for (const w of windows) {
        if (!best || w.multiple.gt(new Decimal(best.multiple))) {
          best = { multiple: w.multiple.toString(), timeframe: w.timeframe, basis: w.basis };
        }
      }
    }

    return {
      tokenId: h.tokenId,
      chain: h.tokenId.split(':')[0],
      address: h.tokenId.split(':')[1],
      symbol: h.symbol,
      wallet: walletLabel.get(h.walletId) ?? h.walletId,
      // 数量与价值都是十进制字符串，前端只负责显示，不做算术
      amount: amount ? amount.toString() : null,
      priceUsd: price ? price.toString() : null,
      valueUsd: amount && price ? amount.mul(price).toString() : null,
      monitored: h.monitored === 1,
      filterReason: h.filterReason,
      lastQuoteAt: last?.ts ?? null,
      decimalsKnown: h.decimals !== null,
      best,
    };
  });
  return NextResponse.json({ holdings: rows });
}
