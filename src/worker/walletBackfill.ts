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

const FIVE_MINUTES = 300;

/**
 * 同时刻的实时 candle 与 GMGN 历史 candle 如果稳定相差超过这个倍数，
 * 视为两个数据源的报价口径不同，而不是行情真的在同一时刻跳变。
 *
 * 取 1.5 是有意偏保守的：暴涨最低档是 2x，1.5 倍的口径误差已经足以
 * 把接近 2x 的真实行情推过报警线，或者把一个本来不到 2x 的行情伪造成
 * 报警。只有至少两个同时间、已完成的样本都稳定落在这条线外才整批拒绝，
 * 单个异常点和不同步的真实趋势不会触发。
 */
export const STABLE_SOURCE_RATIO = '1.5';

/** 10x 单点 fallback 只允许拿这么近的历史与实时价比较。 */
export const MAX_LIVE_PRICE_AGE_SECONDS = 30 * 60;

/** 覆盖率达到这个比例就认为不需要回填。留余量是因为数据源会省略无成交的 candle */
const COVERAGE_RATIO = 0.5;

/**
 * 回填数据与实时报价允许的最大偏离倍数。
 *
 * GMGN 与 DexScreener 会对同一个币给出不同口径的价格 —— 实测「不对劲」
 * 相差 126 倍、「哈夫币」相差 119 倍（同一时刻，不是涨跌）。两个源的
 * 数据混进同一条 candle 序列，会算出 100 多倍的假涨幅。
 *
 * 当同 ts 重叠样本不足时，fallback 才比较**回填的最后一根 K 线**与实时价：
 * 两者必须只相隔 30 分钟以内，本该几乎相等。用最后一根而不是最低价，
 * 所以真实的大涨不会因为拿最低点比较而被误杀。
 *
 * 阈值 10 倍，与 backfill.ts 里那道旧守卫（当初为「牛来」加的）一致。
 * 偏向拦截：拦错了只是没有历史，窗口会诚实地标 too_young；
 * 放过了就是推一条 126 倍的假报警，而工具喊一次狼来了就会被关掉。
 */
export const MAX_PRICE_DEVIATION = 10;
const MAX_PRICE_DEVIATION_DECIMAL = new Decimal(String(MAX_PRICE_DEVIATION));

const TRUSTED_LIVE_SOURCES = [
  'dexscreener', 'wallet-batch', 'wallet-dexscreener', 'wallet-xxyy',
];

interface CompletedCandleClose {
  ts: number;
  c: string | null;
}

/**
 * 规范化上游结果：先按时间升序，再裁掉窗口外、未来以及当前未完成桶，
 * 最后对同一 ts 去重。相同 ts 的重复结果取上游排序后的最后一条，保持
 * 结果确定，同时不让同一根被重复计数。
 */
export function normalizeBackfillRows(rows: Candle[], now: number): Candle[] {
  const currentBucket = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
  const since = currentBucket - BACKFILL_SECONDS;
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.ts - b.row.ts || a.index - b.index);
  const unique = new Map<number, Candle>();
  for (const { row } of sorted) {
    // 当前桶和未来桶都由实时路径负责，GMGN 只补已完成的历史桶。
    if (row.ts < since || row.ts >= currentBucket) continue;
    unique.set(row.ts, row);
  }
  return [...unique.values()];
}

function readCompletedLiveCandles(tokenId: string, since: number, currentBucket: number): Map<number, Decimal> {
  const sourcePlaceholders = TRUSTED_LIVE_SOURCES.map(() => '?').join(', ');
  const rows = getRawDb().prepare(
    `SELECT ts, c FROM candles
       WHERE token_id = ? AND timeframe = '5m'
         AND ts >= ? AND ts < ? AND c IS NOT NULL
         AND source IN (${sourcePlaceholders})
       ORDER BY ts`,
  ).all(tokenId, since, currentBucket, ...TRUSTED_LIVE_SOURCES) as CompletedCandleClose[];

  const out = new Map<number, Decimal>();
  for (const row of rows) {
    if (!row.c) continue;
    try {
      const close = new Decimal(row.c);
      if (close.isFinite() && close.gt(0)) out.set(row.ts, close);
    } catch {
      // 损坏的旧行不能成为拒绝新回填的依据。
    }
  }
  return out;
}

function symmetricRatio(a: Decimal, b: Decimal): Decimal | null {
  if (!a.isFinite() || !b.isFinite() || a.lte(0) || b.lte(0)) return null;
  return a.gte(b) ? a.div(b) : b.div(a);
}

/**
 * 判断同 ts 的重叠样本是否呈现稳定的源口径倍率。
 *
 * 只看超过 1.5 的样本，并要求方向一致且最大/最小倍率也不超过 1.5；
 * 这样“实时价在上涨、两个接口恰好取到不同时间”的倍率变化不会被当成
 * 恒定的 3x 口径错误。返回值只表示是否应该整批拒绝。
 */
export function hasStableOverlapMismatch(
  rows: Candle[], liveCandles: Map<number, Decimal>,
): boolean {
  const threshold = new Decimal(STABLE_SOURCE_RATIO);
  const mismatches: Array<{ ratio: Decimal; direction: -1 | 1 }> = [];
  for (const row of rows) {
    const live = liveCandles.get(row.ts);
    if (!live) continue;
    const ratio = symmetricRatio(row.c, live);
    if (!ratio || !ratio.gt(threshold)) continue;
    mismatches.push({ ratio, direction: row.c.gte(live) ? 1 : -1 });
  }
  if (mismatches.length < 2) return false;

  const direction = mismatches[0]!.direction;
  if (mismatches.some((m) => m.direction !== direction)) return false;

  let min = mismatches[0]!.ratio;
  let max = mismatches[0]!.ratio;
  for (const mismatch of mismatches.slice(1)) {
    if (mismatch.ratio.lt(min)) min = mismatch.ratio;
    if (mismatch.ratio.gt(max)) max = mismatch.ratio;
  }
  return max.div(min).lte(threshold);
}

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

  const currentBucket = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
  const since = currentBucket - BACKFILL_SECONDS;
  const inWindow = normalizeBackfillRows(rows, now);
  if (inWindow.length === 0) return 0;

  /**
   * 先用同 ts 的已完成实时 candle 做多点校验。当前桶不在这里，避免把
   * 正在变化的实时值与已经收盘的历史值强行混在一起。
   */
  const liveCandles = readCompletedLiveCandles(tokenId, since, currentBucket);
  const overlapCount = inWindow.reduce((count, row) => count + (liveCandles.has(row.ts) ? 1 : 0), 0);
  if (overlapCount >= 2) {
    if (hasStableOverlapMismatch(inWindow, liveCandles)) {
      log.warn(
        `${tokenId} 回填与实时 candle 在 ${overlapCount} 个已完成时刻稳定相差 ` +
        `超过 ${STABLE_SOURCE_RATIO} 倍，整批丢弃 —— 两个数据源口径不一致`,
      );
      return 0;
    }
  } else if (livePrice && livePrice.gt(0)) {
    // 重叠不足时保留旧的极端守卫，但历史必须足够新；否则一段很久以前的
    // 1 -> 12 真实上涨会被误认为是两个源的 12x 口径错误。
    const latest = inWindow[inWindow.length - 1]!;
    const latestAge = now - latest.ts;
    if (latestAge <= MAX_LIVE_PRICE_AGE_SECONDS) {
      const ratio = symmetricRatio(latest.c, livePrice);
      if (ratio && ratio.gt(MAX_PRICE_DEVIATION_DECIMAL)) {
        log.warn(
          `${tokenId} 回填数据与实时价相差 ${ratio.toFixed(1)} 倍 ` +
          `(回填 ${latest.c.toString()} vs 实时 ${livePrice.toString()}，历史距现在 ${latestAge}s)，整批丢弃 —— ` +
          `两个数据源口径不一致，混用会算出假涨幅`,
        );
        return 0;
      }
    } else {
      log.debug(
        `${tokenId} 回填最新历史距现在 ${latestAge}s，超过 ${MAX_LIVE_PRICE_AGE_SECONDS}s，跳过 10x 单点口径守卫`,
      );
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
