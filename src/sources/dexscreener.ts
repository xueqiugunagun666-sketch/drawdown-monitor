/**
 * DexScreener 适配器 —— P0 主源（规格 §4.3 v0.3）。
 *
 * 单端点：/token-pairs/v1/{chainId}/{tokenAddress}
 *   一次调用返回该代币的全部池（上限 30），据此同时得到：
 *     - primary pool（流动性最高）→ 价格、txns、volume
 *     - liquidity_total（求和）→ §2.4 的报警门槛依据
 *
 * Phase 0 实测的两个静默失效，必须在这里挡住（绝对规则 4）：
 *   1. 间歇性返回 [] 或 {"pairs":null}，HTTP 200 无 error 字段
 *   2. 结果超过 30 条时静默截断
 * 两者都不能当成"该代币没有价格" —— 一律抛 SourceError。
 */
import { httpGet, sleep } from '../lib/http.ts';
import { parsePrice, Decimal } from '../lib/decimal.ts';
import { SourceError } from '../lib/errors.ts';
import { getConfig } from '../lib/config.ts';
import { selectPools } from './poolSelection.ts';
import { makeLogger } from '../lib/log.ts';
import type { ChainId, PoolRef, TokenQuote, Txns } from './types.ts';

const log = makeLogger('dexscreener');
export const SOURCE_ID = 'dexscreener';

/** DexScreener 单个 pair 的原始结构（只声明我们用到的字段） */
interface RawPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;   // 注意：池报价代币计价，§2.3 明确不使用
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  fdv?: number;
  pairCreatedAt?: number;
}

function txnsOf(raw: RawPair, key: string): Txns {
  const t = raw.txns?.[key];
  return { buys: t?.buys ?? 0, sells: t?.sells ?? 0 };
}

function liqOf(p: RawPair): number {
  return p.liquidity?.usd ?? 0;
}

/** 地址比较：EVM 大小写不敏感，Solana base58 大小写敏感 */
function addrEq(a: string, b: string): boolean {
  if (a.startsWith('0x') || b.startsWith('0x')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

async function fetchPairs(chain: ChainId, address: string): Promise<RawPair[]> {
  const cfg = getConfig();
  const chainCfg = cfg.chains[chain];
  if (!chainCfg) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain,
      message: `未知链 ${chain}` });
  }
  const url = `https://api.dexscreener.com/token-pairs/v1/${chainCfg.dexscreenerId}/${address}`;

  // 间歇性空响应会重试，但重试用尽仍为空 -> 抛错，绝不静默当作"无价格"
  const MAX_ATTEMPTS = 3;
  let lastKind: 'empty_response' | 'http_error' | 'network' = 'empty_response';
  let lastMsg = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await httpGet(url);
    } catch (err) {
      lastKind = 'network';
      lastMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
      break;
    }

    if (res.status === 429) {
      throw new SourceError({ sourceId: SOURCE_ID, kind: 'rate_limited', chain,
        message: `429 限流 (${chain}:${address})`, missing: [`${chain}:${address}`] });
    }
    if (res.status !== 200) {
      lastKind = 'http_error';
      lastMsg = `HTTP ${res.status}`;
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain,
        message: `响应不是合法 JSON (${chain}:${address})`, missing: [`${chain}:${address}`] });
    }

    // 该端点正常返回裸数组；legacy 形态可能是 {pairs: [...]}
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : (parsed as { pairs?: unknown }).pairs;

    if (Array.isArray(arr) && arr.length > 0) {
      if (arr.length >= 30) {
        // 上限 30，liquidity_total 实为"主要池合计"，UI 措辞需相应处理
        log.debug(`${chain}:${address} 返回 ${arr.length} 池（达上限，合计为前 30 池）`);
      }
      return arr as RawPair[];
    }

    lastKind = 'empty_response';
    lastMsg = `空响应（HTTP 200，${Array.isArray(arr) ? '[]' : 'pairs=null'}）`;
    if (attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }

  throw new SourceError({
    sourceId: SOURCE_ID, kind: lastKind, chain,
    message: `${chain}:${address} 取价失败（${MAX_ATTEMPTS} 次尝试）：${lastMsg}`,
    missing: [`${chain}:${address}`],
  });
}

/**
 * 取单个代币的完整行情：离群池剔除 -> primary 选举 -> 价格与流动性。
 *
 * @param nativeUsd 该链原生币的 USD 报价，用于按 §2.3 推导 priceNative；
 *                  缺失时 priceNative 为 null，**不得回退成 priceUsd**。
 */
export async function fetchQuote(
  chain: ChainId,
  address: string,
  nativeUsd: Decimal | null,
): Promise<TokenQuote> {
  const raw = await fetchPairs(chain, address);

  // 只保留该代币作为 base 的池 —— 作为 quote 出现时 priceUsd 是对手方的价格
  const mine = raw.filter(
    (p) => p.baseToken?.address && addrEq(p.baseToken.address, address) && parsePrice(p.priceUsd),
  );
  if (mine.length === 0) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'partial_response', chain,
      message: `${chain}:${address} 返回 ${raw.length} 个池，但没有一个是该代币为 base 且有有效 priceUsd`,
      missing: [`${chain}:${address}`] });
  }

  // §2.4：先剔除离群池，再选主池
  const candidates = mine.map((p) => ({
    raw: p,
    priceUsd: parsePrice(p.priceUsd)!,
    liquidityUsd: liqOf(p),
  }));
  const deviationMax = getConfig().defaultRule.poolPriceDeviationMax;
  const sel = selectPools(candidates, deviationMax);

  if (sel.outliers.length > 0) {
    // 规则 4：剔除必须可见，不能静默丢弃
    log.warn(
      `${chain}:${address} 剔除 ${sel.outliers.length} 个离群池（中位价 ${sel.medianPriceUsd.toSignificantDigits(6)}）`,
      {
        outliers: sel.outliers.map((o) => ({
          pool: o.raw.pairAddress,
          dex: o.raw.dexId,
          quote: o.raw.quoteToken?.symbol,
          priceUsd: o.priceUsd.toString(),
          liquidityUsd: Math.round(o.liquidityUsd),
        })),
      },
    );
  }

  const primary = sel.primary;
  const primaryRaw = primary.raw;
  const priceUsd = primary.priceUsd;

  const outlierPools = new Set(sel.outliers.map((o) => o.raw.pairAddress));
  const toPoolRef = (c: { raw: RawPair; priceUsd: Decimal; liquidityUsd: number }): PoolRef => ({
    chain,
    address: c.raw.pairAddress,
    dex: c.raw.dexId ?? null,
    quoteSymbol: c.raw.quoteToken?.symbol ?? null,
    quoteAddress: c.raw.quoteToken?.address ?? null,
    liquidityUsd: c.liquidityUsd,
    createdAt: c.raw.pairCreatedAt ? Math.floor(c.raw.pairCreatedAt / 1000) : null,
    priceUsd: c.priceUsd.toString(),
    isOutlier: outlierPools.has(c.raw.pairAddress),
  });

  return {
    chain,
    address,
    symbol: primaryRaw.baseToken?.symbol ?? null,
    name: primaryRaw.baseToken?.name ?? null,
    priceUsd,
    // §2.3：自行推导，不取数据源的 priceNative
    priceNative: nativeUsd && nativeUsd.gt(0) ? priceUsd.div(nativeUsd) : null,
    liquidityPrimary: primary.liquidityUsd,
    liquidityTotal: sel.liquidityTotal,
    fdvUsd: primaryRaw.fdv ?? null,
    volume: {
      m5: primaryRaw.volume?.['m5'] ?? 0,
      h1: primaryRaw.volume?.['h1'] ?? 0,
      h24: primaryRaw.volume?.['h24'] ?? 0,
    },
    txns: {
      m5: txnsOf(primaryRaw, 'm5'),
      h1: txnsOf(primaryRaw, 'h1'),
      h24: txnsOf(primaryRaw, 'h24'),
    },
    primaryPool: toPoolRef(primary),
    allPools: candidates.map(toPoolRef),
    medianPriceUsd: sel.medianPriceUsd,
    crossValidated: sel.crossValidated,
    fetchedAt: Math.floor(Date.now() / 1000),
    source: SOURCE_ID,
  };
}
