/**
 * 双源报价的逐币决策。
 *
 * 目前生产行为仍由 `current*` 描述：DS 是正式来源，只有 XXYY 同轮接近且
 * 整轮健康时才取两者较低价。`hypothetical*` 是下一版冲突暂停规则的影子
 * 结果，只落库、不参与窗口、状态机和通知。
 */
import { Decimal } from '../lib/decimal.ts';
import type { BatchQuote } from '../sources/dexscreenerBatch.ts';
import type { XxyyQuote } from '../sources/xxyy.ts';

export type QuoteDecisionKind =
  | 'consensus'
  | 'conflict'
  | 'ds-only'
  | 'xxyy-only'
  | 'unavailable';

export interface QuoteDecision {
  kind: QuoteDecisionKind;
  ratio: string | null;
  roundHealthy: boolean;
  currentPriceUsd: string | null;
  currentSource: 'dexscreener' | 'xxyy' | null;
  /** null = 下一版会暂停该币，等待可信核验。 */
  hypotheticalPriceUsd: string | null;
  hypotheticalSource: 'dexscreener' | 'xxyy' | null;
}

function price(raw: string | undefined): Decimal | null {
  if (raw === undefined) return null;
  try {
    const value = new Decimal(raw);
    return value.isFinite() && value.gt(0) ? value : null;
  } catch {
    return null;
  }
}

export function decideQuote(
  ds: BatchQuote | null,
  xxyy: XxyyQuote | null,
  roundHealthy: boolean,
  tolerance = new Decimal('1.10'),
): QuoteDecision {
  const dsPrice = price(ds?.priceUsd);
  const xxyyPrice = price(xxyy?.priceUsd);

  if (!dsPrice && !xxyyPrice) {
    return {
      kind: 'unavailable', ratio: null, roundHealthy,
      currentPriceUsd: null, currentSource: null,
      hypotheticalPriceUsd: null, hypotheticalSource: null,
    };
  }

  if (dsPrice && !xxyyPrice) {
    return {
      kind: 'ds-only', ratio: null, roundHealthy,
      currentPriceUsd: dsPrice.toString(), currentSource: 'dexscreener',
      hypotheticalPriceUsd: dsPrice.toString(), hypotheticalSource: 'dexscreener',
    };
  }

  if (!dsPrice && xxyyPrice) {
    return {
      kind: 'xxyy-only', ratio: null, roundHealthy,
      // 当前正式规则没有 DS 的流动性/成交量元数据，不能只拿候选价继续判定。
      currentPriceUsd: null, currentSource: null,
      hypotheticalPriceUsd: null, hypotheticalSource: null,
    };
  }

  const ratio = Decimal.max(dsPrice!.div(xxyyPrice!), xxyyPrice!.div(dsPrice!));
  if (ratio.gt(tolerance)) {
    return {
      kind: 'conflict', ratio: ratio.toString(), roundHealthy,
      // 这是现有正式行为；影子结果则暂停，避免把 DS 回退误称为可信。
      currentPriceUsd: dsPrice!.toString(), currentSource: 'dexscreener',
      hypotheticalPriceUsd: null, hypotheticalSource: null,
    };
  }

  const lower = Decimal.min(dsPrice!, xxyyPrice!);
  const lowerSource = xxyyPrice!.lt(dsPrice!) ? 'xxyy' : 'dexscreener';
  return {
    kind: 'consensus', ratio: ratio.toString(), roundHealthy,
    currentPriceUsd: roundHealthy ? lower.toString() : dsPrice!.toString(),
    currentSource: roundHealthy ? lowerSource : 'dexscreener',
    // 单币已经一致；即使整轮因其它币覆盖不足降级，也把这个事实保留供对照。
    hypotheticalPriceUsd: lower.toString(), hypotheticalSource: lowerSource,
  };
}
