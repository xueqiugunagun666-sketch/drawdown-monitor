/**
 * 数据源适配器接口 —— 规格 §4.1（v0.3 修订）。
 */
import type { Decimal } from '../lib/decimal.ts';

export type ChainId = 'ethereum' | 'base' | 'bsc' | 'solana' | 'robinhood';
export const CHAIN_IDS: ChainId[] = ['ethereum', 'base', 'bsc', 'solana', 'robinhood'];

export type Timeframe = '5m' | '1h' | '1d';

export interface Txns { buys: number; sells: number }

export interface PoolRef {
  chain: ChainId;
  address: string;
  dex: string | null;
  quoteSymbol: string | null;
  quoteAddress: string | null;
  liquidityUsd: number;
  createdAt: number | null;
  /** 该池自身的 USD 报价，用于 §2.4 的离群判定与 UI 展示 */
  priceUsd: string;
  /** §2.4：价格偏离中位数过大，已从 primary 选举与 liquidity_total 中排除 */
  isOutlier: boolean;
}

export interface TokenQuote {
  chain: ChainId;
  address: string;
  symbol: string | null;
  name: string | null;
  /** 主池 USD 价格 */
  priceUsd: Decimal;
  /**
   * 原生币计价 —— §2.3：由 priceUsd / nativeCoinUsdPrice 推导，
   * **不取数据源的 priceNative 字段**（那是池报价代币计价，语义不同）。
   * 原生币报价缺失时为 null，不得回退成 priceUsd。
   */
  priceNative: Decimal | null;
  /** 主池流动性 */
  liquidityPrimary: number;
  /** 主要池合计（前 30 池），§2.4：min_liquidity_usd 门槛用这个 */
  liquidityTotal: number;
  fdvUsd: number | null;
  /** 流通市值；DexScreener 的 marketCap，缺失时为 null（不拿 fdv 冒充） */
  marketCapUsd: number | null;
  volume: { m5: number; h1: number; h24: number };
  txns: { m5: Txns; h1: Txns; h24: Txns };
  primaryPool: PoolRef;
  /** 全部 base 池，含被排除的离群池（isOutlier 标记） */
  allPools: PoolRef[];
  /** §2.4：跨池价格中位数 */
  medianPriceUsd: Decimal;
  /** 池数 < 3 时无法交叉验证，UI 需标注「无交叉验证」 */
  crossValidated: boolean;
  fetchedAt: number;
  source: string;
}

export interface Candle {
  ts: number;
  o: Decimal; h: Decimal; l: Decimal; c: Decimal;
  volumeUsd: number;
}
