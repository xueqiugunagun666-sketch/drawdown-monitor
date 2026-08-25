/**
 * 回撤引擎 —— 规格 §7。
 *
 * 每轮报价：写 candle -> 更新三种 ATH 模式 × 两种计价 -> 逐规则逐档位评估状态机。
 * 规则用自己指定的 ath_mode / quote_mode 取 ATH；报警消息里两种计价都带上（§2.3）。
 */
import { Decimal, priceFromText, drawdownPct } from '../lib/decimal.ts';
import { nowSec } from '../lib/time.ts';
import { makeLogger } from '../lib/log.ts';
import {
  computeForMode, specFor, ATH_MODES, QUOTE_MODES, ROLLING_WINDOW_SECONDS,
  type AthMode, type QuoteMode,
} from './athModes.ts';
import { evaluate, seedState } from './stateMachine.ts';
import * as repo from '../db/repo.ts';
import type { TokenQuote } from '../sources/types.ts';
import type { TokenRow } from '../db/repo.ts';

const log = makeLogger('engine');

export interface FiredAlert {
  id: string;
  token: TokenRow;
  level: number;
  drawdownUsd: Decimal;
  drawdownNative: Decimal | null;
  priceUsd: Decimal;
  athUsd: Decimal;
  athTs: number | null;
  quote: TokenQuote;
  athLiquidity: number | null;
  /** ATH 时刻的市值；回填出的高点为 null */
  athMarketCap: number | null;
  athMode: AthMode;
  quoteMode: QuoteMode;
}

/** 回填止步处与窗口起点相差多久算「真的缺数据」 */
const COVERAGE_TOLERANCE_SECONDS = 2 * 3600;

/**
 * 判断某个模式的窗口是不是真的没被覆盖完整（§2.1 的 backfill_partial）。
 *
 * 关键：**代币比窗口年轻不等于数据不完整**。池子 11 天前才建，
 * 90 天窗口自然只有 11 天数据，但那已经是存在的全部 —— 此时标「不完整」
 * 是误导。只有当数据源确实还有更早的数据却拿不到时，才算不完整。
 */
function isWindowIncomplete(
  tokenId: string, mode: AthMode, poolCreatedAt: number | null, now: number,
): boolean {
  // since_added 的起点由我们自己决定，不存在覆盖不到的问题
  if (mode === 'since_added') return false;

  const timeframe = specFor(mode).timeframe;
  const job = repo.getBackfillJob(tokenId, timeframe);
  if (job?.reachedSourceLimit !== 1) return false;   // 回填正常完成

  const oldest = repo.getOldestCandleTs(tokenId, timeframe);
  if (oldest === null) return true;                  // 一根都没有，确实不完整

  // 该模式期望覆盖到的最早时刻
  const windowStart = mode === 'rolling_90d' ? now - ROLLING_WINDOW_SECONDS : 0;
  // 池子建成之前不可能有数据，期望值不应早于建池时刻
  const expectedStart = poolCreatedAt !== null ? Math.max(windowStart, poolCreatedAt) : windowStart;

  return oldest > expectedStart + COVERAGE_TOLERANCE_SECONDS;
}

export function processQuote(token: TokenRow, quote: TokenQuote): FiredAlert[] {
  // 1. 写入/更新当前 5m candle
  repo.upsertCandle(token.id, quote);

  // 2. 主池同步。换池了就提一句 —— 这本身是值得留意的信号，但不做特殊处理
  const prevPrimary = repo.getPrimaryPoolAddress(token.id);
  if (prevPrimary && prevPrimary !== quote.primaryPool.address) {
    log.info(`${token.id} 主池已换: ${prevPrimary.slice(0, 12)} -> ${quote.primaryPool.address.slice(0, 12)} (${quote.primaryPool.dex})`);
  }
  repo.syncPools(token.id, quote);

  // 2b. 汇总 5m -> 1h：all_time 读的是 1h 序列，回填只覆盖到回填那一刻，
  //     之后要靠实时数据滚动补齐，否则 all_time 会永远停在回填时的高点
  repo.rollup5mTo1h(token.id, 3);

  // 3. 更新全部 ATH 模式 × 计价模式（§2.1：三种同时计算并存储）
  const rules = repo.getRulesFor(token.id);
  const k = rules[0]?.athSustainCandles ?? 3;
  const now = nowSec();

  const poolCreatedAt = repo.getEarliestPoolCreatedAt(token.id);
  for (const mode of ATH_MODES) {
    const partial = isWindowIncomplete(token.id, mode, poolCreatedAt, now);
    for (const qm of QUOTE_MODES) {
      const r = computeForMode(token.id, mode, qm, k, token.addedAt, now);
      repo.saveAth(token.id, mode, qm, r, partial);
    }
  }

  // 4. 逐规则、逐档位评估 —— 每条规则用它自己指定的 ath_mode / quote_mode
  const fired: FiredAlert[] = [];

  for (const rule of rules) {
    if (rule.type !== 'drawdown') continue;   // bounce 是 Phase 3

    const mode = rule.athMode as AthMode;
    const qm = rule.quoteMode as QuoteMode;
    const ath = repo.getAth(token.id, mode, qm);
    const athRobust = priceFromText(ath?.athRobust ?? null);
    if (!athRobust) continue;   // 合格 candle 不足 k 根，还不能判定回撤

    const price = qm === 'usd' ? quote.priceUsd : quote.priceNative;
    if (!price) continue;       // native 报价缺失时不猜，宁可不判

    const drawdown = drawdownPct(athRobust, price);
    if (!drawdown) continue;

    // 展示用：另一种计价下的回撤，两个都带进报警消息
    const otherQm: QuoteMode = qm === 'usd' ? 'native' : 'usd';
    const otherAth = priceFromText(repo.getAth(token.id, mode, otherQm)?.athRobust ?? null);
    const otherPrice = otherQm === 'usd' ? quote.priceUsd : quote.priceNative;
    const drawdownOther = otherAth && otherPrice ? drawdownPct(otherAth, otherPrice) : null;

    let levels: number[];
    try {
      levels = JSON.parse(rule.levels) as number[];
    } catch {
      log.error(`规则 ${rule.id} 的 levels 不是合法 JSON，已跳过`, { levels: rule.levels });
      continue;
    }

    // 首次为该代币建立状态时，已跌破的档位直接置为 FIRED，不追溯报警
    const seeded: number[] = [];
    for (const level of levels) {
      let cur = repo.getAlertStateOrNull(token.id, rule.id, level);
      if (cur === null) {
        cur = seedState(drawdown, level, price, now);
        repo.saveAlertState(token.id, rule.id, level, cur);
        if (cur.state === 'FIRED') seeded.push(level);
      }
      const res = evaluate(cur, {
        drawdown,
        price: quote.priceUsd,
        liquidityTotal: quote.liquidityTotal,
        level,
        confirmTicks: rule.confirmTicks,
        hysteresis: rule.hysteresis,
        rearmMinutes: rule.rearmMinutes,
        minLiquidityUsd: rule.minLiquidityUsd,
        cooldownMinutes: rule.cooldownMinutes,
        lastAnyFiredAt: repo.getLastFiredAt(token.id),
        now,
      });
      repo.saveAlertState(token.id, rule.id, level, res.next);

      if (res.blockedBy === 'liquidity') {
        log.info(`${token.id} 回撤 ${drawdown.toFixed(2)}% 达 ${level}% 档，但流动性 $${Math.round(quote.liquidityTotal)} 低于门槛 $${rule.minLiquidityUsd}，未触发`);
      }

      if (!res.fire) continue;


      const athUsd = athRobust;
      const drawdownUsdVal = qm === 'usd' ? drawdown : drawdownOther;
      const drawdownNative = qm === 'native' ? drawdown : drawdownOther;

      const id = `${token.id}:${rule.id}:${level}:${now}`;
      const alert: FiredAlert = {
        id, token, level,
        drawdownUsd: drawdownUsdVal ?? drawdown, drawdownNative,
        priceUsd: quote.priceUsd, athUsd, athTs: ath?.athTs ?? null, quote,
        athLiquidity: ath?.athLiquidity ?? null,
        athMarketCap: ath?.athMarketCap ?? null,
        athMode: mode, quoteMode: qm,
      };
      repo.insertAlert({
        id, tokenId: token.id, ruleId: rule.id, type: 'drawdown', level,
        firedAt: now,
        priceUsd: quote.priceUsd.toString(),
        athUsd: athUsd.toString(),
        drawdownUsd: (drawdownUsdVal ?? drawdown).toString(),
        drawdownNative: drawdownNative ? drawdownNative.toString() : null,
        snapshot: JSON.stringify({
          liquidityPrimary: quote.liquidityPrimary,
          liquidityTotal: quote.liquidityTotal,
          athLiquidity: ath?.athLiquidity ?? null,
          athMarketCap: ath?.athMarketCap ?? null,
          marketCapNow: quote.marketCapUsd,
          volH1AtAth: ath?.volH1AtAth ?? null,
          volumeH1: quote.volume.h1,
          volumeH24: quote.volume.h24,
          txnsH1: quote.txns.h1,
          athConfidence: ath?.athConfidence ?? null,
          athMode: mode, quoteMode: qm,
          crossValidated: quote.crossValidated,
          primaryPool: quote.primaryPool.address,
          primaryOverTotal: quote.liquidityTotal > 0 ? quote.liquidityPrimary / quote.liquidityTotal : null,
        }),
        verdict: null,          // Phase 3
        verdictBasis: ath?.verdictBasis ?? null,
        delivered: null,
        ackedAt: null,
      });
      fired.push(alert);
      log.warn(`${token.id} 触发 ${level}% 档报警，回撤 ${drawdown.toFixed(2)}% (${mode}/${qm})`);
    }

    // 规则 4：不追溯报警这件事必须让人看得见，否则会以为系统漏报了
    if (seeded.length > 0) {
      log.info(
        `${token.id} 首次建立状态时回撤已达 ${drawdown.toFixed(1)}%，` +
        `${seeded.join('/')}% 档视为加入前已触发，不追溯推送；` +
        `日后回升再跌破会正常报警`,
      );
    }
  }

  return fired;
}
