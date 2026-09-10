/**
 * 双源报价的逐币决策。
 *
 * `decideQuote` 保留描述切源前的双源影子诊断并写入 quote_shadow；正式
 * 钱包报警已经由 xxyyAlertEngine 独立执行，不读取这里的 current 结果。
 * `selectAlertPrice` 则锁住新规则：XXYY 有效就用，缺失就暂停，绝不 DS 冒充。
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

/**
 * 暴涨与 ATH 真正使用的价格。
 *
 * 用户在 XXYY 交易，因此“可执行价格”必须以 XXYY 为准。DexScreener 继续
 * 提供流动性、成交量、池子与社交元数据，但不能再等它追价之后才报警。
 * XXYY 缺失时返回 null：DexScreener 仍可更新过滤与元数据，但不能冒充
 * XXYY 触发钱包报警。故障由独立健康看护显式通知管理员。
 */
export interface AlertPriceQuote {
  priceUsd: string;
  marketCapUsd: number | null;
  source: 'xxyy';
  fetchedAt: number | null;
}

export function selectAlertPrice(
  _ds: BatchQuote | null, xxyy: XxyyQuote | null,
): AlertPriceQuote | null {
  const xxyyPrice = price(xxyy?.priceUsd);
  if (xxyyPrice) {
    return {
      priceUsd: xxyyPrice.toString(),
      marketCapUsd: xxyy?.marketCapUsd ?? null,
      source: 'xxyy',
      fetchedAt: xxyy?.fetchedAt ?? null,
    };
  }

  return null;
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
