/**
 * 一次性清理：删掉"按虚高价存下来的" K 线历史。
 *
 *   npm run purge:mispriced          # 只报告，不动数据
 *   npm run purge:mispriced -- --yes # 真的删
 *
 * 背景见 src/sources/quotePrice.ts：DexScreener 对小众计价代币的美元估值
 * 可能错上百倍（实测 GMEB 虚高 120 倍，牵连 9 个币）。校正上线之后新的
 * K 线是对的，而库里旧的那些还是虚高价 —— 两段接在一起，序列里会凭空
 * 出现一次百倍暴跌，暴涨窗口的基准也停留在虚高时代，这些币要一整天
 * 才自己恢复正常。
 *
 * 删掉是诚实的做法：那些数据本来就是错的。代价是这些币的窗口会有一段
 * 时间标 too_young —— 系统本来就会如实显示，比拿错数据算出个数强。
 *
 * **判据用"这条报价被校正过"，不是"现价和历史差得多"。** 后者会把真的
 * 暴跌了的币误删。
 */
import { runMigrations } from '../src/db/migrate.ts';
import { getRawDb } from '../src/db/index.ts';
import { fetchBatchQuotes } from '../src/sources/dexscreenerBatch.ts';
import { makeLogger } from '../src/lib/log.ts';
import { safeErrorMessage } from '../src/lib/mask.ts';

const log = makeLogger('purge-mispriced');

async function main(): Promise<void> {
  runMigrations();
  const dryRun = !process.argv.includes('--yes');
  const db = getRawDb();

  const ids = (db.prepare(
    `SELECT DISTINCT token_id FROM holdings WHERE decimals IS NOT NULL`,
  ).all() as Array<{ token_id: string }>).map((r) => r.token_id);

  const byChain = new Map<string, string[]>();
  for (const id of ids) {
    const [chain, addr] = id.split(':');
    if (!chain || !addr) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(addr);
  }

  const hits: Array<{ tokenId: string; quote: string; candles: number }> = [];
  for (const [chain, addrs] of byChain) {
    let quotes;
    try {
      quotes = await fetchBatchQuotes(chain, addrs);
    } catch (err) {
      log.warn(`${chain} 取报价失败，跳过: ${safeErrorMessage(err)}`);
      continue;
    }
    for (const [addr, q] of quotes) {
      if (!q.priceCorrected) continue;
      const tokenId = `${chain}:${addr}`;
      const n = (db.prepare(
        `SELECT COUNT(*) AS c FROM candles WHERE token_id = ?`,
      ).get(tokenId) as { c: number }).c;
      hits.push({ tokenId, quote: q.quoteSymbol ?? '?', candles: n });
    }
  }

  if (hits.length === 0) {
    log.info('没有需要清理的币');
    process.exit(0);
  }

  log.info(`${hits.length} 个币的报价被校正过，历史 K 线需要重建：`);
  for (const h of hits) {
    log.info(`  ${h.tokenId}  计价=${h.quote}  ${h.candles} 根`);
  }

  if (dryRun) {
    log.info('这是预演。确认无误后加 --yes 真的执行');
    process.exit(0);
  }

  /**
   * K 线与暴涨状态机一起清，放在同一个事务里。
   *
   * 状态机也要清：它记着"这个档位已经报过了"，而那些判断是基于虚高价
   * 做出的。不清的话，价格校正后这些档位仍然是 FIRED，币真的涨起来时
   * 一条都不会报 —— 静默失效，比多报一条危险得多。
   */
  const purge = db.transaction((rows: typeof hits) => {
    let candles = 0, states = 0;
    for (const h of rows) {
      candles += db.prepare(`DELETE FROM candles WHERE token_id = ?`).run(h.tokenId).changes;
      states += db.prepare(`DELETE FROM pump_states WHERE token_id = ?`).run(h.tokenId).changes;
    }
    return { candles, states };
  });
  const r = purge(hits);
  log.info(`已删除 ${r.candles} 根 K 线、${r.states} 条档位状态。下一轮开始重建`);
  process.exit(0);
}

void main().catch((err: unknown) => {
  log.exception('清理失败', err);
  process.exit(1);
});
