/**
 * 轮询调度 —— 规格 §5。
 * 清单 < 100，全量 30 秒一轮，p-queue 限并发。
 */
import PQueue from 'p-queue';
import { getConfig } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { SourceError } from '../lib/errors.ts';
import { nowSec } from '../lib/time.ts';
import { fetchQuote, SOURCE_ID } from '../sources/dexscreener.ts';
import { fetchNativePrices, saveNativePrices, getLatestNativePrice, type NativeSymbol } from '../sources/nativePrices.ts';
import { processQuote } from './engine.ts';
import { enqueueBackfill } from './backfill.ts';
import { deliver, notifyPlain } from './notifier.ts';
import * as repo from '../db/repo.ts';
import type { ChainId } from '../sources/types.ts';

const log = makeLogger('poller');

/** 已发过失联通知的代币，恢复后清除，避免每轮重复刷屏 */
const staleNotified = new Set<string>();

export async function refreshNativePrices(): Promise<void> {
  try {
    const prices = await fetchNativePrices();
    saveNativePrices(prices);
    repo.recordSourceOk('coingecko');
  } catch (err) {
    const msg = safeErrorMessage(err);
    const kind = err instanceof SourceError ? err.kind : 'network';
    repo.recordSourceFailure('coingecko', kind, msg);
    // 原生币报价失败不阻断轮询，但 priceNative 会变 null 并在 UI 可见
    log.exception('原生币报价刷新失败，priceNative 将为 null', err);
  }
}

export async function pollOnce(): Promise<void> {
  const cfg = getConfig();
  const tokens = repo.listEnabledTokens().filter((t) => t.frozen === 0);
  if (tokens.length === 0) {
    log.debug('清单为空，跳过本轮');
    return;
  }

  const runId = repo.startPollRun(tokens.length);
  const queue = new PQueue({ concurrency: cfg.polling.maxConcurrency });
  const errors: string[] = [];
  let covered = 0;

  await queue.addAll(
    tokens.map((token) => async () => {
      const chain = token.chain as ChainId;
      const nativeSymbol = (cfg.chains[chain]?.nativeSymbol ?? 'ETH') as NativeSymbol;
      const nativeUsd = getLatestNativePrice(nativeSymbol);

      try {
        const quote = await fetchQuote(chain, token.address, nativeUsd);
        repo.markQuoteSuccess(token.id, quote);
        repo.recordSourceOk(SOURCE_ID);
        covered++;
        staleNotified.delete(token.id);

        const fired = processQuote(token, quote);
        for (const alert of fired) {
          await deliver(alert);
        }

        // 主池已知后才能排回填（OHLCV 是按池取的）
        if (!repo.getBackfillJob(token.id, '5m')) {
          enqueueBackfill(token.id, quote.primaryPool.address);
        }
      } catch (err) {
        const msg = safeErrorMessage(err);
        const kind = err instanceof SourceError ? err.kind : 'network';
        const fails = repo.markQuoteFailure(token.id);
        repo.recordSourceFailure(SOURCE_ID, kind, msg);
        errors.push(`${token.id}: ${msg}`);
        // 绝不吞异常：每次失败都留痕，连续失败会在 UI 高亮
        log.warn(`${token.id} 取价失败（连续 ${fails} 次）: ${msg}`);
      }
    }),
  );

  repo.finishPollRun(runId, covered, errors);
  log.info(`轮询完成 ${covered}/${tokens.length}${errors.length ? `，${errors.length} 个失败` : ''}`);

  await checkStale();
}

/** §4.4 失联检测：超过 stale_minutes 无有效报价 -> 通知一次 */
async function checkStale(): Promise<void> {
  const cfg = getConfig();
  const cutoff = nowSec() - cfg.polling.staleMinutes * 60;
  const stale = repo.listEnabledTokens().filter(
    (t) => t.frozen === 0 && (t.lastQuoteAt === null || t.lastQuoteAt < cutoff),
  );

  const fresh: string[] = [];
  for (const t of stale) {
    if (staleNotified.has(t.id)) continue;
    staleNotified.add(t.id);
    const since = t.lastQuoteAt ? `${Math.floor((nowSec() - t.lastQuoteAt) / 60)} 分钟` : '从未成功';
    log.error(`数据源失联: ${t.id} 已 ${since} 无有效报价（连续失败 ${t.failCount} 次）`);
    fresh.push(`${t.symbol ?? t.id}（${since}无报价，连续失败 ${t.failCount} 次）`);
  }
  if (stale.length > 0) {
    log.error(`共 ${stale.length} 个代币失联，UI 需高亮`);
  }
  // §4.4：失联要发通知，不能只写日志 —— 静默失效比误报危险
  if (fresh.length > 0) {
    await notifyPlain(`数据源失联\n\n${fresh.join('\n')}\n\n超过 ${cfg.polling.staleMinutes} 分钟无有效报价。`);
  }
}
