/**
 * 钱包币的历史回填。
 *
 * 没有它，一个新加的钱包要等 24 小时四个窗口才全部可用 —— 历史是靠
 * 判定循环每 2 分钟攒一根 5m candle 攒出来的。系统的行为是诚实的
 * （历史不够的窗口标 too_young，不拿 5 分钟数据冒充 24 小时涨幅），
 * 但对用户来说第一天基本只有短窗口在工作。
 *
 * 成本很低：24 小时的 5m K 线是 288 根，GMGN 的 limit 上限是 1000，
 * **一个币一次请求就拿全**。按实测的 80 req/min，50 个币约 40 秒补完。
 */
import { fetchKlinePage, supportsChain as gmgnSupports, isConfigured as gmgnConfigured } from '../sources/gmgn.ts';
import { getRawDb } from '../db/index.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { Decimal } from '../lib/decimal.ts';
import type { Candle } from '../sources/types.ts';

const log = makeLogger('wallet-backfill');

/** 回填窗口：最长的判定窗口是 24h */
export const BACKFILL_SECONDS = 86400;

/** 覆盖率达到这个比例就认为不需要回填。留余量是因为数据源会省略无成交的 candle */
const COVERAGE_RATIO = 0.5;

/**
 * 回填数据与实时报价允许的最大偏离倍数。
 *
 * GMGN 与 DexScreener 会对同一个币给出不同口径的价格 —— 实测「不对劲」
 * 相差 126 倍、「哈夫币」相差 119 倍（同一时刻，不是涨跌）。两个源的
 * 数据混进同一条 candle 序列，会算出 100 多倍的假涨幅。
 *
 * 判据是**回填的最后一根 K 线**对比实时价：两者只相隔几十分钟，
 * 本该几乎相等。用最后一根而不是最低价，所以真实的大涨不会被误杀。
 *
 * 阈值 10 倍，与 backfill.ts 里那道旧守卫（当初为「牛来」加的）一致。
 * 偏向拦截：拦错了只是没有历史，窗口会诚实地标 too_young；
 * 放过了就是推一条 126 倍的假报警，而工具喊一次狼来了就会被关掉。
 */
export const MAX_PRICE_DEVIATION = 10;

export interface BackfillDeps {
  fetchKline: (chain: string, address: string, tf: '5m', beforeTs?: number) => Promise<Candle[]>;
  supportsChain: (chain: string) => boolean;
  isConfigured: () => boolean;
}

export const realBackfillDeps: BackfillDeps = {
  fetchKline: (chain, address, tf, beforeTs) => fetchKlinePage(chain, address, tf, beforeTs),
  supportsChain: gmgnSupports,
  isConfigured: gmgnConfigured,
};

/**
 * 判断是否需要回填：看窗口内已有多少根 candle。
 * 用比例而不是"最老的一根够不够老"，是因为后者对单根残留数据太敏感。
 */
export function needsBackfill(tokenId: string, now: number): boolean {
  const since = Math.floor(now / 300) * 300 - BACKFILL_SECONDS;
  const r = getRawDb().prepare(
    `SELECT COUNT(*) AS c FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ?`,
  ).get(tokenId, since) as { c: number };
  return r.c < (BACKFILL_SECONDS / 300) * COVERAGE_RATIO;
}

/**
 * 回填一个币的 24 小时 5m 历史。返回实际写入的根数。
 *
 * 用 DO NOTHING：实时轮询写的 candle 带流动性与成交笔数，回填只有
 * OHLCV 六字段，绝不能把已有的实时数据覆盖掉（会把 ath_confidence
 * 从 verified 降成 inferred —— 这是 repo.insertBackfillCandles 上
 * 已经写明的约定，这里遵循同一条）。
 */
export async function backfillWalletToken(
  tokenId: string, now: number, deps: BackfillDeps = realBackfillDeps,
  livePrice: Decimal | null = null,
): Promise<number> {
  const [chain, address] = tokenId.split(':');
  if (!chain || !address) return 0;
  if (!deps.isConfigured() || !deps.supportsChain(chain)) return 0;

  let rows: Candle[];
  try {
    rows = await deps.fetchKline(chain, address, '5m');
  } catch (err) {
    // 回填是尽力而为，失败不能拖垮判定循环
    log.debug(`${tokenId} 回填失败: ${safeErrorMessage(err)}`);
    return 0;
  }

  const since = Math.floor(now / 300) * 300 - BACKFILL_SECONDS;
  const inWindow = rows.filter((c) => c.ts >= since);
  if (inWindow.length === 0) return 0;

  // 口径校验：回填的最后一根应与实时价基本一致（相隔仅几十分钟）。
  // 差得离谱说明两个源不在一个口径上，整批都不能用 ——
  // 混进去会算出 100 多倍的假涨幅
  if (livePrice && livePrice.gt(0)) {
    const latest = inWindow[inWindow.length - 1]!.c;
    if (latest.gt(0)) {
      const ratio = Decimal.max(latest.div(livePrice), livePrice.div(latest));
      if (ratio.gt(MAX_PRICE_DEVIATION)) {
        log.warn(
          `${tokenId} 回填数据与实时价相差 ${ratio.toFixed(1)} 倍 ` +
          `(回填 ${latest.toString()} vs 实时 ${livePrice.toString()})，整批丢弃 —— ` +
          `两个数据源口径不一致，混用会算出假涨幅`,
        );
        return 0;
      }
    }
  }

  const db = getRawDb();
  const stmt = db.prepare(
    `INSERT INTO candles (token_id, timeframe, ts, o, h, l, c, volume_usd, source)
     VALUES (?, '5m', ?, ?, ?, ?, ?, ?, 'gmgn')
     ON CONFLICT(token_id, timeframe, ts) DO NOTHING`,
  );
  let written = 0;
  db.transaction(() => {
    for (const c of inWindow) {
      written += stmt.run(
        tokenId, c.ts,
        c.o.toString(), c.h.toString(), c.l.toString(), c.c.toString(),
        c.volumeUsd,
      ).changes;
    }
  })();

  if (written > 0) log.info(`${tokenId} 回填 ${written} 根 5m candle`);
  return written;
}
