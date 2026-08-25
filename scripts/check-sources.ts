/**
 * 数据源冒烟测试：不写库，只验证适配器能拿到数据。
 * 用法: npm run check:sources
 */
import { fetchNativePrices } from '../src/sources/nativePrices.ts';
import { fetchQuote } from '../src/sources/dexscreener.ts';
import { formatPrice } from '../src/lib/decimal.ts';
import { safeErrorMessage } from '../src/lib/mask.ts';
import type { ChainId } from '../src/sources/types.ts';

const SAMPLES: Array<[ChainId, string, string]> = [
  ['solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['solana', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
  ['robinhood', '0x020bfC650A365f8BB26819deAAbF3E21291018b4', 'CASHCAT'],
];

const native = await fetchNativePrices();
console.log('原生币报价:', Object.entries(native).map(([k, v]) => `${k}=$${formatPrice(v, 6)}`).join('  '));
console.log();

let failures = 0;
for (const [chain, addr, label] of SAMPLES) {
  const nativeSym = chain === 'solana' ? 'SOL' : chain === 'bsc' ? 'BNB' : 'ETH';
  try {
    const q = await fetchQuote(chain, addr, native[nativeSym] ?? null);
    console.log(`${label} (${chain})`);
    console.log(`  priceUsd      ${formatPrice(q.priceUsd, 8)}`);
    console.log(`  priceNative   ${q.priceNative ? formatPrice(q.priceNative, 8) + ' ' + nativeSym : 'null'}`);
    console.log(`  primary pool  ${q.primaryPool.address.slice(0, 16)} (${q.primaryPool.dex}, quote=${q.primaryPool.quoteSymbol})`);
    console.log(`  liq primary   $${Math.round(q.liquidityPrimary).toLocaleString()}`);
    console.log(`  liq total     $${Math.round(q.liquidityTotal).toLocaleString()}  (${q.allPools.length} 池, primary/total=${(q.liquidityPrimary / q.liquidityTotal).toFixed(3)})`);
    console.log(`  txns h1       买 ${q.txns.h1.buys} / 卖 ${q.txns.h1.sells}`);
    console.log(`  vol h24       $${Math.round(q.volume.h24).toLocaleString()}`);
  } catch (err) {
    failures++;
    console.error(`${label} (${chain}) 失败: ${safeErrorMessage(err)}`);
  }
  console.log();
}
process.exit(failures > 0 ? 1 : 0);
