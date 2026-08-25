/**
 * 回撤引擎 —— 规格 §7。
 *
 * Phase 1 范围：since_added 模式、USD 计价、单档 80%。
 * rolling_90d / all_time（需 OHLCV 回填）与原生币计价的 ATH 属 Phase 2。
 */
import { Decimal, priceFromText, drawdownPct } from '../lib/decimal.ts';
import { nowSec } from '../lib/time.ts';
import { makeLogger } from '../lib/log.ts';
import { computeAth, type AthCandle } from './ath.ts';
import { evaluate } from './stateMachine.ts';
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
}

/** Phase 1 只算 since_added + usd */
const PHASE1_MODE = 'since_added';
const PHASE1_QUOTE_MODE = 'usd';

export function processQuote(token: TokenRow, quote: TokenQuote): FiredAlert[] {
  // 1. 写入/更新当前 5m candle
  repo.upsertCandle(token.id, quote);

  // 2. 主池迁移检测（§2.4）—— 迁移本身是值得关注的信号，必须可见
  const prevPrimary = repo.getPrimaryPoolAddress(token.id);
  if (prevPrimary && prevPrimary !== quote.primaryPool.address) {
    log.warn(`${token.id} 主池已迁移`, {
      from: prevPrimary, to: quote.primaryPool.address,
      dex: quote.primaryPool.dex, liquidityUsd: Math.round(quote.primaryPool.liquidityUsd),
    });
  }
  repo.syncPools(token.id, quote);

  // 3. 更新 ATH（回填与实时共用 computeAth，见 §2.2）
  const rows = repo.getCandles(token.id, '5m', 0);
  const athCandles: AthCandle[] = rows.flatMap((r) => {
    const h = priceFromText(r.h), c = priceFromText(r.c);
    return h && c ? [{ ts: r.ts, h, c, volumeUsd: r.volumeUsd, liquidityTotal: r.liquidityTotal }] : [];
  });

  const rules = repo.getRulesFor(token.id);
  const k = rules[0]?.athSustainCandles ?? 3;
  const ath = computeAth(athCandles, k);
  repo.saveAth(token.id, PHASE1_MODE, PHASE1_QUOTE_MODE, ath);

  if (!ath.athRobust) {
    // 合格 candle 不足 k 根，还不能判定回撤 —— 不是错误，但也不能假装有 ATH
    return [];
  }

  // 4. 逐规则、逐档位评估
  const fired: FiredAlert[] = [];
  const now = nowSec();

  for (const rule of rules) {
    if (rule.type !== 'drawdown') continue;   // bounce 是 Phase 3
    const drawdown = drawdownPct(ath.athRobust, quote.priceUsd);
    if (!drawdown) continue;

    let levels: number[];
    try {
      levels = JSON.parse(rule.levels) as number[];
    } catch {
      log.error(`规则 ${rule.id} 的 levels 不是合法 JSON，已跳过`, { levels: rule.levels });
      continue;
    }

    for (const level of levels) {
      const cur = repo.getAlertState(token.id, rule.id, level);
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

      const athUsd = ath.athRobust;
      // Phase 2 才有 native 计价的 ATH 序列。在那之前 drawdown_native 保持 null ——
      // 拿 USD 的 ATH 去和 native 的现价相除会得到一个看似合理、实则无意义的数字。
      const drawdownNative = null;

      const id = `${token.id}:${rule.id}:${level}:${now}`;
      const alert: FiredAlert = {
        id, token, level, drawdownUsd: drawdown, drawdownNative,
        priceUsd: quote.priceUsd, athUsd, athTs: ath.athTs, quote,
        athLiquidity: ath.athLiquidity,
      };
      repo.insertAlert({
        id, tokenId: token.id, ruleId: rule.id, type: 'drawdown', level,
        firedAt: now,
        priceUsd: quote.priceUsd.toString(),
        athUsd: athUsd.toString(),
        drawdownUsd: drawdown.toString(),
        drawdownNative: null,
        snapshot: JSON.stringify({
          liquidityPrimary: quote.liquidityPrimary,
          liquidityTotal: quote.liquidityTotal,
          athLiquidity: ath.athLiquidity,
          volH1AtAth: ath.volH1AtAth,
          volumeH1: quote.volume.h1,
          volumeH24: quote.volume.h24,
          txnsH1: quote.txns.h1,
          athConfidence: ath.athConfidence,
          crossValidated: quote.crossValidated,
          primaryPool: quote.primaryPool.address,
          primaryOverTotal: quote.liquidityTotal > 0 ? quote.liquidityPrimary / quote.liquidityTotal : null,
        }),
        verdict: null,          // Phase 3
        verdictBasis: ath.verdictBasis,
        delivered: null,
        ackedAt: null,
      });
      fired.push(alert);
      log.warn(`${token.id} 触发 ${level}% 档报警，回撤 ${drawdown.toFixed(2)}%`);
    }
  }

  return fired;
}
