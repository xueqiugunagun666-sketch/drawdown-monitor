/**
 * 给报警补上币名。
 *
 * **两条路径都必须用这个**：页面加载走 /api/wallet/alerts，
 * 实时推送走 SSE。曾经只有前者补了币名，于是刷新页面看历史有名字、
 * 而实时弹出的系统通知里只有一串 0x —— 偏偏通知里没法复制粘贴，
 * 用户看到一串十六进制完全不知道是哪个币。
 *
 * 币名是锦上添花，报警本身才是关键：查名字失败（表不存在、语句报错）
 * 时降级成"没有名字"，绝不能因此让整条报警发不出去。
 */
import { getRawDb } from './index.ts';
import type { PumpAlertRow } from './walletRepo.ts';
import { describeAthScope } from '../worker/athHistory.ts';

export interface EnrichedAlert extends PumpAlertRow {
  symbol: string | null;
  address: string | null;
  chain: string | null;
  /** ATH 报警专用：这个"新高"是多少天的口径。见 athHistory.describeAthScope */
  athScope: string | null;
}

const SOURCES = [
  `SELECT symbol FROM holdings WHERE token_id = ? AND symbol IS NOT NULL LIMIT 1`,
  `SELECT symbol FROM token_meta WHERE token_id = ?`,
  `SELECT symbol FROM tokens WHERE id = ?`,
];

export function lookupSymbol(tokenId: string): string | null {
  const db = getRawDb();
  for (const sql of SOURCES) {
    try {
      const r = db.prepare(sql).get(tokenId) as { symbol: string | null } | undefined;
      if (r?.symbol) return r.symbol;
    } catch {
      // 这张表可能还没建（迁移未跑），跳过继续试下一个来源
    }
  }
  return null;
}

/**
 * ATH 报警要说清楚这是多少天的"新高"。
 *
 * 覆盖不完整时把 6 天新高说成「历史新高」是这个系统最该避免的谎，
 * 所以口径跟着每条报警一起送到前端，而不是让前端自己猜。
 */
function lookupAthScope(tokenId: string): string | null {
  try {
    const r = getRawDb().prepare(
      `SELECT complete, history_start_ts FROM wallet_ath WHERE token_id = ?`,
    ).get(tokenId) as { complete: number; history_start_ts: number | null } | undefined;
    if (!r) return null;
    const secs = r.history_start_ts === null
      ? 0
      : Math.max(0, Math.floor(Date.now() / 1000) - r.history_start_ts);
    return describeAthScope({ complete: r.complete === 1, coverageSeconds: secs });
  } catch {
    return null;                 // 表还没建（迁移未跑），降级成"没有口径"
  }
}

export function enrichAlerts(rows: PumpAlertRow[]): EnrichedAlert[] {
  // 同一批里常有同一个币的多条，缓存一下省掉重复查询
  const cache = new Map<string, string | null>();
  const scopes = new Map<string, string | null>();
  return rows.map((a) => {
    if (!cache.has(a.tokenId)) cache.set(a.tokenId, lookupSymbol(a.tokenId));
    const isAth = a.kind === 'ath' || a.kind === 'ath-advance';
    if (isAth && !scopes.has(a.tokenId)) scopes.set(a.tokenId, lookupAthScope(a.tokenId));
    return {
      ...a,
      symbol: cache.get(a.tokenId) ?? null,
      address: a.tokenId.split(':')[1] ?? null,
      chain: a.tokenId.split(':')[0] ?? null,
      athScope: isAth ? scopes.get(a.tokenId) ?? null : null,
    };
  });
}
