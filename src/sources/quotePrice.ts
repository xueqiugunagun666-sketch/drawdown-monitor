/**
 * 计价代币的美元价校正。
 *
 * **为什么需要**：DexScreener 的 priceUsd 是
 *   priceUsd = priceNative × 计价代币的美元价
 * 算出来的。拿主流资产（USDT / WBNB / WETH…）计价时这没问题，
 * 但小众代币计价时，DexScreener 对计价代币的美元估值可能错得离谱。
 *
 * 线上实测（2026-09-05）：GMEB 被估成 $2,307，而它自己的 GMEB/USDT 池
 * （流动性 $40 万、24h 成交 $250 万）显示只值 $19.16 —— 差 120 倍。
 * 结果是拿 GMEB 计价的 9 个币持仓价值全部虚高 120 倍：一个真实价值
 * $130 的持仓被显示成 $15,663。同批还查出 SOXLB 虚高 57 倍、MRNAB 4.7 倍。
 *
 * **注意涨幅不受影响**：分子分母同比例虚高，比值不变。错的只有价值，
 * 但价值会决定「值不值得吵醒你」（$1 底线与每人自定义的小额阈值），
 * 所以不能不管。
 *
 * 做法：拿 priceUsd ÷ priceNative 反推"这个池子认为计价代币值多少"，
 * 与计价代币自己的美元价对比，差太多就用真实价重算。
 */
import { Decimal } from '../lib/decimal.ts';
import {
  isTrustedQuoteIdentity,
  type QuoteIdentityTrust,
} from '../lib/tokenIdentity.ts';

/**
 * 主流计价资产。用这些计价时 DexScreener 的美元价可以直接信 ——
 * 它们本身有深度足够的美元池，估值不会离谱。
 *
 * 按**符号**判断而不是地址：同一个符号在四条链上地址各不相同，
 * 维护一张跨链地址表既啰嗦又容易漏。冒充主流符号的假币会因此蒙混过关，
 * 但那种币的 priceNative 同样不可信，多一道地址校验也救不了。
 */
export const MAJOR_QUOTES = new Set([
  'WBNB', 'BNB', 'USDT', 'USDC', 'BUSD', 'USD1', 'FDUSD', 'DAI',
  'WETH', 'ETH', 'WBTC', 'BTCB', 'SOL', 'WSOL',
]);

export function isMajorQuote(symbol: string | null | undefined): boolean {
  return MAJOR_QUOTES.has((symbol ?? '').toUpperCase());
}

/**
 * 暴露精确计价币身份判定，但本轮不把它接入正式校正分支。
 *
 * `isMajorQuote` 仍保持原有符号兼容行为；调用方可以额外保存这个结果，
 * 将“符号看起来主流”和“链+合约确实已确认”区分开来。
 */
export function quoteIdentityStatus(
  chain: string,
  quoteAddress: string | null,
  quoteSymbol: string | null,
): QuoteIdentityTrust {
  return isTrustedQuoteIdentity(chain, quoteAddress, quoteSymbol);
}

/**
 * 判定"差太多"的倍数。
 *
 * 定在 3 倍：小于它的差距可能是两个池子的正常价差、更新延迟或滑点，
 * 贸然改价反而制造噪音；真正的错误都是几十上百倍量级（实测 4.7 / 57 / 120）。
 * 偏保守 —— 改错一个价比漏改一个更难被发现。
 */
export const DEVIATION_THRESHOLD = 3;

/** 这个池子隐含的"计价代币值多少美元"。任一为 0 或缺失时返回 null */
export function impliedQuoteUsd(
  priceUsd: string | null, priceNative: string | null,
): Decimal | null {
  if (!priceUsd || !priceNative) return null;
  let pu: Decimal, pn: Decimal;
  try {
    pu = new Decimal(priceUsd);
    pn = new Decimal(priceNative);
  } catch {
    return null;
  }
  if (pu.lte(0) || pn.lte(0)) return null;
  return pu.div(pn);
}

export interface Correction {
  /** 校正后的美元价 */
  priceUsd: string;
  /** 真的改了吗 */
  corrected: boolean;
  /** 偏离倍数，日志用 */
  deviation: Decimal | null;
}

/**
 * 校正一个池子的美元价。
 *
 * realQuoteUsd 为 null（查不到计价代币的独立报价）时**原样返回** ——
 * 不知道对不对就别动，瞎改比不改危险。
 */
export function correctPrice(
  priceUsd: string, priceNative: string | null, realQuoteUsd: Decimal | null,
): Correction {
  const implied = impliedQuoteUsd(priceUsd, priceNative);
  if (implied === null || realQuoteUsd === null || realQuoteUsd.lte(0)) {
    return { priceUsd, corrected: false, deviation: null };
  }
  const deviation = Decimal.max(implied.div(realQuoteUsd), realQuoteUsd.div(implied));
  if (deviation.lt(DEVIATION_THRESHOLD)) {
    return { priceUsd, corrected: false, deviation };
  }
  // priceNative 一定存在：implied 非 null 就意味着它能解析成正数
  const fixed = new Decimal(priceNative!).mul(realQuoteUsd);
  return { priceUsd: fixed.toString(), corrected: true, deviation };
}

/**
 * 市值必须跟着**我们实际用的那个价**走。
 *
 * 数据源给的 marketCap 是「该池价格 × 供应量」—— 每个池自洽，但我们一旦
 * 换了价（校正了计价代币、或改用看板的中位价），原来那个市值就对不上了。
 * 供应量不变，所以按价格比例缩放即可。
 *
 * 线上实测（Monkey，2026-09-06）：同一个币，离群的 XAUt 池报市值
 * $50,548,989，正常池报 $1.4M —— 差 36 倍。价格取一个、市值取另一个，
 * 显示出来的就是这种数。
 */
export function scaleMarketCap(
  rawMarketCap: number | null, rawPrice: string | null, usedPrice: string | null,
): number | null {
  if (rawMarketCap === null || !Number.isFinite(rawMarketCap)) return null;
  if (!rawPrice || !usedPrice) return rawMarketCap;
  let from: Decimal, to: Decimal;
  try {
    from = new Decimal(rawPrice);
    to = new Decimal(usedPrice);
  } catch {
    return rawMarketCap;
  }
  if (from.lte(0) || to.lte(0)) return rawMarketCap;
  if (from.eq(to)) return rawMarketCap;
  /**
   * 市值是展示用的量级数字，这里落回 number 是可以的 —— 它不参与阈值判定，
   * 也不做链式运算。比例本身用 Decimal 算，避免小数价格上的精度塌陷。
   */
  return Number(to.div(from).mul(rawMarketCap).toString());
}
