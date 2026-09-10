/**
 * XXYY 批量报价。
 *
 * 存在的理由只有一个：**批量规模**。实测一次请求可以带 1,200 个地址、
 * 1.56 秒返回，而 DexScreener 的批量接口一次只吃 30 个。同样 2,500 个币：
 *   DexScreener  83 个请求 ≈ 25 秒（受 2 req/s 节流）
 *   XXYY          3 个请求 ≈  5 秒
 * 请求预算就是这套系统的容量上限，这个差距直接决定能盯多少币。
 *
 * **它不能全盘替代 DexScreener**：只回 priceUSD / marketCap / pairAddress，
 * 没有流动性和成交量 —— 而过滤层（一个币要不要进监控）正是靠那两个。
 * 当前职责是：XXYY 独立决定已监控币的暴涨与 ATH 当前价；DexScreener
 * 并行维护资格、元数据与回撤看板，两者不在报警关键路径上互相等待。
 *
 * **这是没有公开文档的接口。** 对方随时可能改路径、改字段、加鉴权，
 * 而最危险的是**静默地改** —— 比如某天开始给所有币回 0。所以调用方必须
 * 做请求、格式、零覆盖和覆盖率掉崖监控，不能把 HTTP 200 当成健康证明。
 */
import PQueue from 'p-queue';
import { httpPostJson } from '../lib/http.ts';
import { SourceError, type SourceFailureKind } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';
import { Decimal } from '../lib/decimal.ts';
import { normalizeAddress } from '../lib/tokenIdentity.ts';

export const SOURCE_ID = 'xxyy';
const log = makeLogger(SOURCE_ID);
const URL = 'https://www.xxyy.io/api/data/list/getTokenPrices';

/**
 * 我们的链名 -> XXYY 的 X-CHAIN。
 *
 * 逐个验过：robinhood 要写 `robin`（写全名回空数组）。与 chainLinks 里
 * 那张表是同一套命名，但那边是 URL 路径、这边是请求头，各验各的。
 */
const CHAIN: Record<string, string> = {
  bsc: 'bsc',
  robinhood: 'robin',
  ethereum: 'eth',
  base: 'base',
  solana: 'sol',
};

export function supportsChain(chain: string): boolean {
  return CHAIN[chain] !== undefined;
}

/** EVM 地址大小写不敏感；Solana mint 大小写敏感，绝不能统一转小写。 */
export function normalizeMint(chain: string, mint: string): string {
  return normalizeAddress(chain, mint);
}

/**
 * 一次请求带多少个地址。
 *
 * 实测 1,200 个仍然 1.56 秒、无截断。留在 500 是**保守**：这是别人的
 * 私有接口，没有公开的限额说明，把单请求撑到极限等于把风险也撑到极限；
 * 500 个已经让请求数比 DexScreener 少一个数量级，够用了。
 */
export const BATCH_SIZE = 500;

/** 并发 1、每次间隔 300ms。私有接口，克制着用 */
const queue = new PQueue({ concurrency: 1, interval: 300, intervalCap: 1 });

export interface XxyyQuote {
  priceUsd: string;
  marketCapUsd: number | null;
  pairAddress: string | null;
  /** 解析时保留来源链和规范化后的 mint；旧注入调用方可以省略。 */
  chain?: string;
  mint?: string;
  fetchedAt?: number;
}

export interface XxyyBatchFailure {
  /** 本批没有成功报价的地址；保留调用方传入的原始大小写。 */
  addresses: string[];
  kind: SourceFailureKind;
  reason: string;
  status?: number;
}

export interface XxyyPricesDetailedResult {
  quotes: Map<string, XxyyQuote>;
  failures: XxyyBatchFailure[];
}

type BatchRequest = (
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export interface FetchXxyyPricesOptions {
  /** 测试/回放注入请求器；省略时使用生产 httpPostJson。 */
  request?: BatchRequest;
}

interface RawRow {
  mint?: unknown;
  priceUSD?: unknown;
  marketCap?: unknown;
  pairAddress?: unknown;
}

/**
 * 解析一次响应。
 *
 * **priceUSD 为 0 要当成"没有数据"，不是"价格是零"。** 实测主流币
 * （USDT / WBNB / USDC）一律回 0，它显然不是真的不值钱 —— 把 0 当价格
 * 会算出无穷大的倍数。
 */
export function parseXxyyPrices(
  body: string,
  chain: string,
  fetchedAt = Math.floor(Date.now() / 1000),
): Map<string, XxyyQuote> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `非 JSON 响应: ${body.slice(0, 120)}`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '响应根节点不是对象' });
  }
  const root = parsed as { code?: unknown; msg?: unknown; data?: unknown };
  if (root.code !== 0) {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `code=${String(root.code)} ${String(root.msg ?? '')}`.trim(),
    });
  }
  if (!Array.isArray(root.data)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: 'data 不是数组' });
  }

  const out = new Map<string, XxyyQuote>();
  for (const r of root.data as RawRow[]) {
    if (typeof r !== 'object' || r === null) continue;
    const mint = typeof r.mint === 'string' ? normalizeMint(chain, r.mint) : null;
    if (!mint) continue;
    let price: Decimal;
    try {
      price = new Decimal(String(r.priceUSD));
    } catch {
      continue;
    }
    if (!price.isFinite() || price.lte(0)) continue;          // 0 = 没数据
    const mc = typeof r.marketCap === 'number' && Number.isFinite(r.marketCap) && r.marketCap > 0
      ? r.marketCap : null;
    out.set(mint, {
      // 后续一律走 Decimal；这里也不使用 Number 做价格校验或算术。
      priceUsd: price.toString(),
      marketCapUsd: mc,
      pairAddress: typeof r.pairAddress === 'string'
        ? normalizeAddress(chain, r.pairAddress) : null,
      chain: chain.trim().toLowerCase(),
      mint,
      fetchedAt,
    });
  }
  return out;
}

export async function fetchXxyyPrices(
  chain: string, addresses: string[], options?: FetchXxyyPricesOptions,
): Promise<Map<string, XxyyQuote>> {
  return (await fetchXxyyPricesDetailed(chain, addresses, options)).quotes;
}

function failureFromError(error: unknown, addresses: string[]): XxyyBatchFailure {
  const sourceError = error instanceof SourceError ? error : null;
  const reason = error instanceof Error ? error.message : String(error);
  return {
    addresses: [...addresses],
    kind: sourceError?.kind ?? 'network',
    reason: reason.slice(0, 240),
  };
}

/**
 * 拉取全部 XXYY 批次并保留每批结果。
 *
 * 一个批次的 429、网络异常、非 200 或坏 JSON 只会记录该批失败并继续；
 * `quotes` 永远保留此前已经成功的批次，`failures` 则明确列出地址和原因，
 * 供主线程稍后接入健康和调度。
 */
export async function fetchXxyyPricesDetailed(
  chain: string, addresses: string[], options: FetchXxyyPricesOptions = {},
): Promise<XxyyPricesDetailedResult> {
  const xchain = CHAIN[chain];
  if (!xchain) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain, message: `不支持链 ${chain}` });
  }
  const merged = new Map<string, XxyyQuote>();
  const failures: XxyyBatchFailure[] = [];
  const request = options.request ?? ((url: string, body: unknown, timeoutMs: number, headers: Record<string, string>) =>
    httpPostJson(url, body, timeoutMs, headers));

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    let res;
    try {
      res = await queue.add(
        () => request(URL, { tokenMints: batch }, 25_000,
          { 'X-CHAIN': xchain, 'X-VERSION': '1' }),
        { throwOnTimeout: true },
      );
    } catch (error) {
      const failure = failureFromError(error, batch);
      failures.push(failure);
      log.warn(`${chain} XXYY 批量报价请求失败，本批 ${batch.length} 个地址跳过: ${failure.reason}`);
      continue;
    }
    if (res.status === 429) {
      failures.push({ addresses: [...batch], kind: 'rate_limited', reason: '429 限流', status: 429 });
      continue;
    }
    if (res.status !== 200) {
      failures.push({
        addresses: [...batch], kind: 'http_error', reason: `HTTP ${res.status}`, status: res.status,
      });
      continue;
    }
    let parsed: Map<string, XxyyQuote>;
    try {
      parsed = parseXxyyPrices(res.body, chain);
    } catch (error) {
      const failure = failureFromError(error, batch);
      failures.push(failure);
      log.warn(`${chain} XXYY 批量报价响应解析失败，本批 ${batch.length} 个地址跳过: ${failure.reason}`);
      continue;
    }
    for (const [k, v] of parsed) merged.set(k, v);

    const missing = batch.filter((address) => !parsed.has(normalizeMint(chain, address)));
    if (missing.length > 0) {
      failures.push({
        addresses: missing,
        kind: parsed.size === 0 ? 'empty_response' : 'partial_response',
        reason: parsed.size === 0 ? 'HTTP 200 返回空报价' : '响应未包含这些地址的有效报价',
        status: 200,
      });
    }
  }
  return { quotes: merged, failures };
}
