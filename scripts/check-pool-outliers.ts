/**
 * 诊断脚本：检查各代币跨池价格一致性。
 * 起因是 DexScreener 会对某些池给出错误的 USD 价格与流动性（见 §2.4）。
 * 用法: npm run check:outliers
 */
import { httpGet } from '../src/lib/http.ts';
import { Decimal } from '../src/lib/decimal.ts';

const TOKENS: Array<[string, string, string]> = [
  ['solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['solana', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
  ['solana', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
  ['ethereum', '0x6982508145454ce325ddbe47a25d4ec3d2311933', 'PEPE'],
  ['ethereum', '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', 'SHIB'],
  ['base', '0x532f27101965dd16442e59d40670faf5ebb142e4', 'BRETT'],
  ['robinhood', '0x020bfC650A365f8BB26819deAAbF3E21291018b4', 'CASHCAT'],
];

function median(xs: Decimal[]): Decimal {
  const s = [...xs].sort((a, b) => a.cmp(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : s[m - 1]!.plus(s[m]!).div(2);
}

for (const [chain, addr, label] of TOKENS) {
  let pairs: any[];
  try {
    const res = await httpGet(`https://api.dexscreener.com/token-pairs/v1/${chain}/${addr}`);
    pairs = JSON.parse(res.body);
    if (!Array.isArray(pairs) || pairs.length === 0) { console.log(`${label}: 空响应，跳过`); continue; }
  } catch (e) { console.log(`${label}: 请求失败`); continue; }

  const mine = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addr.toLowerCase() && p.priceUsd);
  if (mine.length === 0) { console.log(`${label}: 无 base 池`); continue; }

  const prices = mine.map((p) => new Decimal(p.priceUsd));
  const med = median(prices);
  const byLiq = [...mine].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const topPool = byLiq[0]!;
  const topRatio = new Decimal(topPool.priceUsd).div(med);

  // 各池价格相对中位数的偏离倍数
  const ratios = mine.map((p) => new Decimal(p.priceUsd).div(med).toNumber());
  const maxDev = Math.max(...ratios.map((r) => Math.max(r, 1 / r)));
  const outliers = mine.filter((p) => {
    const r = new Decimal(p.priceUsd).div(med).toNumber();
    return Math.max(r, 1 / r) > 1.5;
  });

  const totalAll = mine.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const totalClean = mine.filter((p) => {
    const r = new Decimal(p.priceUsd).div(med).toNumber();
    return Math.max(r, 1 / r) <= 1.5;
  }).reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);

  console.log(`${label} (${chain})  ${mine.length} 池`);
  console.log(`  中位价 ${med.toSignificantDigits(6)}  最大偏离 ${maxDev.toFixed(1)}x  >1.5x 的离群池 ${outliers.length} 个`);
  console.log(`  按流动性选出的主池: ${topPool.dexId}/${topPool.quoteToken?.symbol} price=${topPool.priceUsd} (中位数的 ${topRatio.toSignificantDigits(4)}x) ${topRatio.gt(1.5) || topRatio.lt(0.667) ? '  <== 主池价格离群！' : ''}`);
  console.log(`  liq_total 全部=$${Math.round(totalAll).toLocaleString()}  剔除离群后=$${Math.round(totalClean).toLocaleString()}  虚高 ${(totalAll / totalClean).toFixed(2)}x`);
  console.log();
}
