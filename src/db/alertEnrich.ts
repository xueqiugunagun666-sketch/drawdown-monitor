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
import { windowByKey, describeWindow } from '../worker/athWindows.ts';

export interface EnrichedAlert extends PumpAlertRow {
  symbol: string | null;
  address: string | null;
  chain: string | null;
  /** 当前用户持有该币的钱包备注；同地址跨链的重复备注已去重。 */
  walletLabels: string[];
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

export function lookupWalletLabels(userId: string, tokenId: string): string[] {
  try {
    const rows = getRawDb().prepare(
      `SELECT DISTINCT TRIM(w.label) AS label
         FROM holdings h
         INNER JOIN wallets w ON w.id = h.wallet_id
        WHERE w.user_id = ? AND h.token_id = ? AND w.enabled = 1
          AND w.label IS NOT NULL AND TRIM(w.label) <> ''
        ORDER BY label`,
    ).all(userId, tokenId) as Array<{ label: string }>;
    return rows.map((row) => row.label);
  } catch {
    // 备注是附加信息，查询失败不能阻断整批报警。
    return [];
  }
}

/**
 * ATH 报警的口径。
 *
 * 直接读报警行上记的窗口档次，**不再靠"我们覆盖了多少天"去推** ——
 * 那说的是我们的局限，而这里要说的是行情：突破 90 天高点和突破 3 天
 * 高点分量差得远，读的人要的是后者。
 *
 * 旧报警行没有 ath_window，退回按覆盖天数描述（老口径）。
 */
function lookupAthScope(
  tokenId: string, athWindow: string | null, priceRegime: string | null,
): string | null {
  if (athWindow) {
    if (athWindow === 'all' && priceRegime === 'xxyy-live-v1') return 'XXYY运行期新高';
    const w = windowByKey(athWindow);
    if (w) return describeWindow(w);
  }
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
    return null;
  }
}

export function enrichAlerts(rows: PumpAlertRow[]): EnrichedAlert[] {
  // 同一批里常有同一个币的多条，缓存一下省掉重复查询
  const cache = new Map<string, string | null>();
  const scopes = new Map<string, string | null>();
  const walletLabels = new Map<string, string[]>();
  return rows.map((a) => {
    if (!cache.has(a.tokenId)) cache.set(a.tokenId, lookupSymbol(a.tokenId));
    const isAth = a.kind === 'ath' || a.kind === 'ath-advance' || a.kind === 'pump-ath';
    const scopeKey = `${a.tokenId}|${a.athWindow ?? ''}|${a.priceRegime ?? ''}`;
    const walletKey = `${a.userId}|${a.tokenId}`;
    if (isAth && !scopes.has(scopeKey)) {
      scopes.set(scopeKey, lookupAthScope(a.tokenId, a.athWindow, a.priceRegime));
    }
    if (!walletLabels.has(walletKey)) {
      walletLabels.set(walletKey, lookupWalletLabels(a.userId, a.tokenId));
    }
    return {
      ...a,
      symbol: cache.get(a.tokenId) ?? null,
      address: a.tokenId.split(':')[1] ?? null,
      chain: a.tokenId.split(':')[0] ?? null,
      walletLabels: walletLabels.get(walletKey) ?? [],
      athScope: isAth ? scopes.get(scopeKey) ?? null : null,
    };
  });
}
