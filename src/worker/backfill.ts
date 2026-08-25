/**
 * OHLCV 回填编排 —— 规格 §2.1 冷启动回填 / §13 Phase 2 第 8 项。
 *
 * 两条序列，成本差异很大，分别服务不同的 ATH 模式：
 *   5m / 90 天  -> rolling_90d   26 次请求
 *   1h / 180 天 -> all_time       5 次请求（GT 历史深度约 6 个月）
 *
 * all_time 不用 5m：那要 52 次请求，而找历史最高点用小时级足够。
 * rolling_90d 必须用 5m —— 与实时段粒度一致，否则窗口滑动时
 * ATH 的严格度会悄悄改变（见 §2.2）。
 *
 * 每次只推进一页，天然可断点续传：GT 免费档 5 req/min，
 * 100 个代币全量回填 10 小时以上，中途重启不能从头再来。
 */
import { getConfig } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { nowSec } from '../lib/time.ts';
import { priceToText, type Decimal } from '../lib/decimal.ts';
import { fetchOHLCVPage, estimateRequests } from '../sources/geckoterminal.ts';
import { loadNativeSeries } from '../sources/nativeHistory.ts';
import type { NativeSymbol } from '../sources/nativePrices.ts';
import * as repo from '../db/repo.ts';
import type { ChainId, Timeframe } from '../sources/types.ts';

const log = makeLogger('backfill');

export const ROLLING_DAYS = 90;
export const ALL_TIME_DAYS = 180;

interface Plan { timeframe: Timeframe; days: number }
const PLANS: Plan[] = [
  { timeframe: '5m', days: ROLLING_DAYS },
  { timeframe: '1h', days: ALL_TIME_DAYS },
];

/** 为一个代币建立回填任务（加币后立即调用，§9.4） */
export function enqueueBackfill(tokenId: string, poolAddress: string): void {
  const now = nowSec();
  for (const p of PLANS) {
    const existing = repo.getBackfillJob(tokenId, p.timeframe);
    // 已完成的不重排；主池换了才需要重来
    if (existing && existing.status === 'done' && existing.poolAddress === poolAddress) continue;
    repo.upsertBackfillJob({
      tokenId, timeframe: p.timeframe, poolAddress,
      status: 'pending',
      targetSinceTs: now - p.days * 86400,
      oldestDoneTs: existing?.poolAddress === poolAddress ? existing.oldestDoneTs : null,
      pagesDone: existing?.poolAddress === poolAddress ? existing.pagesDone : 0,
      pagesEstimated: estimateRequests(p.timeframe, p.days),
      candlesWritten: existing?.poolAddress === poolAddress ? existing.candlesWritten : 0,
      reachedSourceLimit: 0,
      lastError: null,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    });
  }
  log.info(`${tokenId} 已排入回填队列 (5m/${ROLLING_DAYS}天 + 1h/${ALL_TIME_DAYS}天)`);
}

/**
 * 推进一页。返回是否还有工作可做。
 * 由 worker 在轮询间隙调用 —— GT 的限流队列会自己控制节奏。
 */
export async function runBackfillStep(): Promise<boolean> {
  const job = repo.nextBackfillJob();
  if (!job) return false;

  const cfg = getConfig();
  const token = repo.getToken(job.tokenId);
  if (!token) {
    repo.updateBackfillJob(job.tokenId, job.timeframe, { status: 'failed', lastError: '代币已删除' });
    return true;
  }
  const network = cfg.chains[token.chain as ChainId]?.geckoId;
  if (!network) {
    repo.updateBackfillJob(job.tokenId, job.timeframe, { status: 'failed', lastError: `未知链 ${token.chain}` });
    return true;
  }

  if (job.status === 'pending') {
    repo.updateBackfillJob(job.tokenId, job.timeframe, { status: 'running', startedAt: job.startedAt ?? nowSec() });
  }

  try {
    // 续传：从已完成的最旧时刻继续往前翻
    const before = job.oldestDoneTs ?? undefined;
    const page = await fetchOHLCVPage(
      network, job.poolAddress, job.timeframe as Timeframe, token.address, before,
    );

    if (page.length === 0) {
      // GT 没有更早的数据了
      const reachedLimit = (job.oldestDoneTs ?? nowSec()) > job.targetSinceTs;
      repo.updateBackfillJob(job.tokenId, job.timeframe, {
        status: 'done',
        reachedSourceLimit: reachedLimit ? 1 : 0,
      });
      if (reachedLimit) {
        log.warn(`${job.tokenId} ${job.timeframe} 回填止于数据源上限，历史不完整（backfill_partial）`);
      } else {
        log.info(`${job.tokenId} ${job.timeframe} 回填完成`);
      }
      return true;
    }

    // 兜底校验：第一页是最新的数据，它的价格必须和 DexScreener 的实时价同一量级。
    // 对不上说明取到的根本不是这个代币的价格（例如 GT 与 DexScreener 对该池的
    // base/quote 判定相反），此时宁可让回填失败并报错，也绝不能把污染数据写进库 ——
    // 那会把 ATH 撑到天上，直接产生一条 -99.99% 的假报警。
    if (job.oldestDoneTs === null) {
      const guard = magnitudeMismatch(repo.getPrimaryPoolPrice(job.tokenId), page[page.length - 1]!.c);
      if (guard) {
        repo.updateBackfillJob(job.tokenId, job.timeframe, { status: 'failed', lastError: guard });
        log.error(`${job.tokenId} ${job.timeframe} 回填数据与实时价量级不符，已拒收: ${guard}`);
        return true;
      }
    }

    const written = repo.insertBackfillCandles(
      job.tokenId, job.timeframe,
      page.map((c) => ({
        ts: c.ts, o: priceToText(c.o), h: priceToText(c.h),
        l: priceToText(c.l), c: priceToText(c.c), volumeUsd: c.volumeUsd,
      })),
    );

    // §2.3：回填出的是 USD candle，native 计价由 USD 除以原生币报价推导。
    // 必须每页都补 —— 漏掉的话 native 的 ATH 窗口会比 USD 短几个数量级，
    // 而且从 ath_confidence 上完全看不出来。
    const nativeSymbol = (cfg.chains[token.chain as ChainId]?.nativeSymbol ?? 'ETH') as NativeSymbol;
    const series = loadNativeSeries(nativeSymbol);
    const nativeFilled = repo.fillNativeForCandles(
      job.tokenId, job.timeframe,
      new Map([...series].map(([ts, d]) => [ts, d.toString()])),
    );

    const oldest = page[0]!.ts;
    const pagesDone = job.pagesDone + 1;
    const reachedTarget = oldest <= job.targetSinceTs;
    // before_timestamp 边界包含：若最旧时刻没往前走，说明已到源的尽头
    const stalled = job.oldestDoneTs !== null && oldest >= job.oldestDoneTs;

    repo.updateBackfillJob(job.tokenId, job.timeframe, {
      oldestDoneTs: oldest,
      pagesDone,
      candlesWritten: job.candlesWritten + written,
      status: reachedTarget || stalled ? 'done' : 'running',
      reachedSourceLimit: stalled && !reachedTarget ? 1 : 0,
      lastError: null,
    });

    if (reachedTarget || stalled) {
      log.info(`${job.tokenId} ${job.timeframe} 回填完成: ${pagesDone} 页, ${job.candlesWritten + written} 根 candle`);
    }
    if (nativeFilled > 0) {
      log.debug(`${job.tokenId} ${job.timeframe} 补 native 计价 ${nativeFilled} 根`);
    }
    repo.recordSourceOk('geckoterminal');
    return true;
  } catch (err) {
    const msg = safeErrorMessage(err);
    // 失败留痕但保持 running，下次继续从 oldestDoneTs 续传
    repo.updateBackfillJob(job.tokenId, job.timeframe, { lastError: msg });
    repo.recordSourceFailure('geckoterminal', 'http_error', msg);
    log.warn(`${job.tokenId} ${job.timeframe} 回填出错，将续传: ${msg}`);
    return true;
  }
}

/** 回填数据允许与实时价相差的最大倍数。真实波动远不到这个量级，
 *  而 base/quote 取反那类错误动辄上千倍。 */
const MAX_PRICE_MAGNITUDE_RATIO = 10;

/**
 * 比对回填出的最新价与实时价。一致返回 null；对不上返回可读的原因。
 * 纯函数，便于测试。
 */
export function magnitudeMismatch(live: Decimal | null, backfilled: Decimal): string | null {
  if (!live || live.lte(0) || backfilled.lte(0)) return null;   // 没有参照物就不拦
  const ratio = backfilled.gt(live) ? backfilled.div(live) : live.div(backfilled);
  if (ratio.lte(MAX_PRICE_MAGNITUDE_RATIO)) return null;
  return `回填价 ${backfilled.toSignificantDigits(6)} 与实时价 ${live.toSignificantDigits(6)} 相差 ${ratio.toSignificantDigits(4)} 倍`;
}

/** 回填整体进度，供 UI 与 /api/health */
export function backfillProgress() {
  const jobs = repo.listBackfillJobs();
  const done = jobs.filter((j) => j.status === 'done').length;
  const pagesDone = jobs.reduce((s, j) => s + j.pagesDone, 0);
  const pagesTotal = jobs.reduce((s, j) => s + Math.max(j.pagesEstimated, j.pagesDone), 0);
  return {
    jobs: jobs.length,
    done,
    running: jobs.filter((j) => j.status === 'running').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    partial: jobs.filter((j) => j.reachedSourceLimit === 1).length,
    pagesDone,
    pagesTotal,
    pct: pagesTotal > 0 ? Math.round((pagesDone / pagesTotal) * 100) : 0,
    // 5 req/min 是实测可持续速率
    etaMinutes: Math.max(0, Math.ceil((pagesTotal - pagesDone) / 5)),
    errors: jobs.filter((j) => j.lastError).map((j) => ({ tokenId: j.tokenId, timeframe: j.timeframe, error: j.lastError })),
  };
}
