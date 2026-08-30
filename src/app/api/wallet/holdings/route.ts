import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listHoldings, listWallets } from '../../../../db/walletRepo.ts';
import { getRawDb } from '../../../../db/index.ts';
import { Decimal } from '../../../../lib/decimal.ts';
import { toHumanAmount } from '../../../../sources/erc20.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  const holdings = listHoldings(u.id);
  const walletLabel = new Map(listWallets(u.id).map((w) => [w.id, w.label ?? w.address]));
  const db = getRawDb();

  const rows = holdings.map((h) => {
    // 最新价取该币最近一根 5m candle 的收盘
    const last = db.prepare(
      `SELECT c, ts FROM candles WHERE token_id = ? AND timeframe = '5m' ORDER BY ts DESC LIMIT 1`,
    ).get(h.tokenId) as { c: string | null; ts: number } | undefined;
    const meta = db.prepare(`SELECT symbol FROM tokens WHERE id = ?`).get(h.tokenId) as
      { symbol: string | null } | undefined;

    const amount = toHumanAmount(h.balance, h.decimals);
    const price = last?.c ? new Decimal(last.c) : null;
    return {
      tokenId: h.tokenId,
      chain: h.tokenId.split(':')[0],
      address: h.tokenId.split(':')[1],
      symbol: meta?.symbol ?? null,
      wallet: walletLabel.get(h.walletId) ?? h.walletId,
      // 数量与价值都是十进制字符串，前端只负责显示，不做算术
      amount: amount ? amount.toString() : null,
      priceUsd: price ? price.toString() : null,
      valueUsd: amount && price ? amount.mul(price).toString() : null,
      monitored: h.monitored === 1,
      filterReason: h.filterReason,
      lastQuoteAt: last?.ts ?? null,
      decimalsKnown: h.decimals !== null,
    };
  });
  return NextResponse.json({ holdings: rows });
}
