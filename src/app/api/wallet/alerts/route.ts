import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listPumpAlerts } from '../../../../db/walletRepo.ts';
import { getRawDb } from '../../../../db/index.ts';

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
  const db = getRawDb();

  /**
   * 币名是锦上添花，报警本身才是关键。
   * 查名字失败（表不存在、语句报错）时降级成"没有名字"，
   * 绝不能因此让整个报警列表 500 —— 那等于用户连报警都看不到了。
   */
  const lookupSymbol = (tokenId: string): string | null => {
    for (const sql of [
      `SELECT symbol FROM holdings WHERE token_id = ? AND symbol IS NOT NULL LIMIT 1`,
      `SELECT symbol FROM token_meta WHERE token_id = ?`,
    ]) {
      try {
        const r = db.prepare(sql).get(tokenId) as { symbol: string | null } | undefined;
        if (r?.symbol) return r.symbol;
      } catch {
        // 这张表可能还没建（迁移未跑），跳过继续试下一个来源
      }
    }
    return null;
  };

  const alerts = listPumpAlerts(u.id, sinceTs).map((a) => ({
    ...a,
    symbol: lookupSymbol(a.tokenId),
    address: a.tokenId.split(':')[1] ?? null,
    chain: a.tokenId.split(':')[0] ?? null,
  }));
  return NextResponse.json({ alerts });
}
