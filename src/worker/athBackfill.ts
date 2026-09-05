/**
 * 长历史回填：给钱包币建立可信的历史最高价。
 *
 * 现有的实时回填只补 24 小时的 5 分钟线（够暴涨窗口用），而 ATH 需要
 * 覆盖这个币的**全部生命**。GMGN 一次最多 1000 根，所以按币龄挑分辨率：
 * 40 天以内用小时线，更老的用日线（1000 天）。
 *
 * 拉回来的长历史**不写进 candles 表**。那张表是暴涨窗口和回撤引擎在用的，
 * 混进不同分辨率的行会让"24 小时内有多少根 5m"这类覆盖率判断全乱套
 * （needsBackfill 就是这么算的）。这里只要一个 ATH 数字，算完存进
 * wallet_ath 即可 —— 少一张表的耦合，少一处能写错的地方。
 */
import { fetchKlinePage, supportsChain, isConfigured } from '../sources/gmgn.ts';
import { fetchBatchQuotes } from '../sources/dexscreenerBatch.ts';
import { summarizeAth, pickResolution, sourcesAgree } from './athHistory.ts';
import { MAX_PRICE_DEVIATION } from './walletBackfill.ts';
import { Decimal } from '../lib/decimal.ts';
import * as athRepo from '../db/athRepo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import type { Candle } from '../sources/types.ts';

const log = makeLogger('ath-backfill');

/** 多久重拉一次长历史。币龄在长大，覆盖范围会变，但不必频繁 */
export const REFRESH_SECONDS = 7 * 86400;

export interface AthBackfillDeps {
  fetchKline: (chain: string, address: string, tf: '1h' | '1d') => Promise<Candle[]>;
  fetchQuotes: typeof fetchBatchQuotes;
  supportsChain: (chain: string) => boolean;
  isConfigured: () => boolean;
}

export const realAthDeps: AthBackfillDeps = {
  fetchKline: (chain, address, tf) => fetchKlinePage(chain, address, tf),
  fetchQuotes: fetchBatchQuotes,
  supportsChain,
  isConfigured,
};

export interface BackfillOutcome {
  done: number;
  skipped: number;
  complete: number;
  /** 长历史与实时价不在一个口径，没建立参照线 */
  rejected: number;
}

/**
 * 给一批币补长历史。
 *
 * 先按链批量取 pairCreatedAt（一次请求 30 个），再逐个拉 K 线 ——
 * 建池时间决定用什么分辨率，也决定历史算不算完整，必须先拿到。
 */
export async function backfillAth(
  tokenIds: string[], now: number, deps: AthBackfillDeps = realAthDeps,
): Promise<BackfillOutcome> {
  const out: BackfillOutcome = { done: 0, skipped: 0, complete: 0, rejected: 0 };
  if (!deps.isConfigured()) {
    log.warn('GMGN 未配置，跳过长历史回填');
    return out;
  }

  const byChain = new Map<string, string[]>();
  for (const id of tokenIds) {
    const [chain, addr] = id.split(':');
    if (!chain || !addr) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(addr);
  }

  for (const [chain, addrs] of byChain) {
    if (!deps.supportsChain(chain)) {
      out.skipped += addrs.length;
      continue;
    }

    /**
     * 一次批量请求同时拿到两样东西：
     *   建池时间 —— 决定用什么分辨率，也决定历史算不算完整
     *   实时价   —— 用来校验长历史与实时报价是不是同一个口径
     */
    const created = new Map<string, number | null>();
    const live = new Map<string, Decimal | null>();
    try {
      for (const [addr, q] of await deps.fetchQuotes(chain, addrs)) {
        created.set(addr, q.pairCreatedAt);
        try { live.set(addr, new Decimal(q.priceUsd)); } catch { live.set(addr, null); }
      }
    } catch (err) {
      log.warn(`${chain} 取报价失败，本链按"币龄未知"处理: ${safeErrorMessage(err)}`);
    }

    for (const addr of addrs) {
      const tokenId = `${chain}:${addr}`;
      const createdAt = created.get(addr) ?? null;
      const ageDays = createdAt === null ? null : Math.floor((now - createdAt) / 86400);
      const tf = pickResolution(ageDays);

      let candles: Candle[];
      try {
        candles = await deps.fetchKline(chain, addr, tf);
      } catch (err) {
        // 单个币失败不拖垮整批 —— 下次刷新会再试
        log.debug(`${tokenId} 取 ${tf} 历史失败: ${safeErrorMessage(err)}`);
        out.skipped++;
        continue;
      }

      const s = summarizeAth(candles, createdAt, now);

      /**
       * 长历史与实时报价必须同口径，否则算出来的 ATH 毫无意义 ——
       * 实测 Monkey 两个源差 258 倍，导致任何实时价看着都像天量突破。
       * 对不上就**存 null**：没有参照线就不报，这是诚实的失败方式。
       */
      const lastClose = candles.length > 0 ? candles[candles.length - 1]!.c : null;
      const agree = sourcesAgree(lastClose, live.get(addr) ?? null, MAX_PRICE_DEVIATION);
      if (!agree) {
        log.warn(`${tokenId} 长历史与实时价不在一个口径，不建立 ATH 参照线`);
        out.rejected++;
      }

      athRepo.upsertWalletAth({
        tokenId,
        athPrice: agree && s.athPrice ? s.athPrice.toString() : null,
        athTs: agree ? s.athTs : null,
        historyStartTs: s.historyStartTs,
        pairCreatedAt: createdAt,
        complete: agree && s.complete,
        backfilledAt: now,
      });
      if (agree) { out.done++; if (s.complete) out.complete++; }
    }
  }
  return out;
}
