/**
 * 两个报价源的一致性核对。
 *
 * 存在的理由是**今天一天被数据源坑了三次**，而三次的共同点是：接口正常
 * 返回 200、字段齐全、看不出任何异常，只是数字是错的。
 *   Sue      历史最高取错口径，低估 38%
 *   Monkey   两个源的价格量级差 258 倍
 *   Monkey   看板与钱包两条流水线口径打架，报出 34852 倍
 *
 * 所以接入 XXYY（一个**没有公开文档的私有接口**）时，不能等它报错才发现
 * 出问题 —— 最危险的失效方式是它某天开始给所有币回 0，或者悄悄换了口径。
 * 这里每轮拿两个源的重叠部分对一次，把"静默地错"变成"看得见的错"。
 */
import { Decimal } from '../lib/decimal.ts';

/** 单个币的价格偏离超过这个倍数就算不一致 */
export const PRICE_TOLERANCE = 1.10;

export interface AgreementReport {
  /** 两边都有价的币数 */
  compared: number;
  /** 其中价格一致的 */
  agreed: number;
  /** 只有 DexScreener 有、XXYY 缺的 */
  missingInB: number;
  /** 一致率；compared 为 0 时是 null（无从判断，不能当成 0%） */
  rate: number | null;
  /** 偏离最大的几个，日志里带出来便于排查 */
  worst: Array<{ key: string; a: string; b: string; ratio: number }>;
}

export function compareQuotes(
  a: Map<string, { priceUsd: string }>,
  b: Map<string, { priceUsd: string }>,
  tolerance = PRICE_TOLERANCE,
  worstLimit = 3,
): AgreementReport {
  let compared = 0, agreed = 0, missingInB = 0;
  const diffs: AgreementReport['worst'] = [];

  for (const [key, av] of a) {
    const bv = b.get(key);
    if (!bv) { missingInB++; continue; }
    let ap: Decimal, bp: Decimal;
    try {
      ap = new Decimal(av.priceUsd);
      bp = new Decimal(bv.priceUsd);
    } catch { continue; }
    if (ap.lte(0) || bp.lte(0)) continue;

    compared++;
    const ratio = Decimal.max(ap.div(bp), bp.div(ap));
    if (ratio.lte(tolerance)) agreed++;
    else diffs.push({ key, a: av.priceUsd, b: bv.priceUsd, ratio: Number(ratio.toFixed(2)) });
  }

  diffs.sort((x, y) => y.ratio - x.ratio);
  return {
    compared, agreed, missingInB,
    rate: compared === 0 ? null : agreed / compared,
    worst: diffs.slice(0, worstLimit),
  };
}

/**
 * 一致率低到什么程度算"这个源坏了"。
 *
 * 定在 0.9：正常的价差来自采样时刻不同与主池选择不同，实测重叠部分
 * 绝大多数在 10% 以内。掉到九成以下说明不是抖动，是口径出了问题。
 */
export const MIN_AGREEMENT_RATE = 0.9;

/**
 * 覆盖率下限。两边都有价的币少于这个比例时，说明新源大面积缺数据 ——
 * 那也是一种静默失效（它照常返回 200，只是里面什么都没有）。
 */
export const MIN_COVERAGE = 0.5;

export interface HealthVerdict {
  ok: boolean;
  /** 出问题时说清楚是哪一种，报给管理员的消息直接用它 */
  reason: string | null;
}

export function judge(
  r: AgreementReport, expected: number,
  minRate = MIN_AGREEMENT_RATE, minCoverage = MIN_COVERAGE,
): HealthVerdict {
  if (expected <= 0) return { ok: true, reason: null };

  const coverage = r.compared / expected;
  if (coverage < minCoverage) {
    return {
      ok: false,
      reason: `覆盖率只有 ${(coverage * 100).toFixed(0)}%`
        + `（${r.compared}/${expected}）—— 新源大面积缺数据`,
    };
  }
  if (r.rate !== null && r.rate < minRate) {
    const w = r.worst[0];
    return {
      ok: false,
      reason: `价格一致率 ${(r.rate * 100).toFixed(0)}%（${r.agreed}/${r.compared}）`
        + (w ? `，最大偏离 ${w.ratio} 倍（${w.key.slice(0, 14)}…）` : ''),
    };
  }
  return { ok: true, reason: null };
}
