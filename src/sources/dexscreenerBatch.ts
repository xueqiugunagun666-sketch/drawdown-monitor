/**
 * DexScreener 批量报价 —— 钱包币专用。
 *
 * 与 dexscreener.ts 的区别：那个走 /token-pairs/v1/，拉一个代币的全部池
 * 做主池选举与跨池中位数校验；钱包币只需要"价格 + 流动性 + 24h 量"，
 * 走 /tokens/v1/{chain}/{addr1,addr2,...}，一次最多 30 个地址。
 *
 * 实测（BSC，三个地址）：返回数组，每项含 baseToken.address、priceUsd、
 * liquidity.usd、volume.h24、volume.h1、marketCap，以及项目方付费绑定的
 * info（头像 / 官网 / 推特 / 电报）。每个代币回一个池。
 *
 * **响应可能不覆盖全部请求地址** —— 这是 errors.ts 里已经记录过的坑：
 * DexScreener 会在结果超限时静默丢弃多余代币。缺失的地址必须显式标出，
 * 绝不能当作"流动性为 0"，否则一次接口抖动就会把正常的币踢出监控。
 */
import PQueue from 'p-queue';
import { httpGet } from '../lib/http.ts';
import { getConfig } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('ds-batch');
export const SOURCE_ID = 'dexscreener-batch';

/** DexScreener 的 /tokens/v1/ 一次最多 30 个地址 */
export const MAX_BATCH = 30;

/**
 * 自带节流：钱包循环独立于价格轮询器调用它，不受后者的 maxConcurrency 约束。
 * DexScreener 对该端点的公开限额是 300 req/min，这里按 120/min 留足余量。
 */
const queue = new PQueue({ concurrency: 1, interval: 500, intervalCap: 1 });

export interface BatchQuote {
  priceUsd: string;          // 保持字符串 —— 中途不许过 Number
  liquidityUsd: number;
  volume24hUsd: number;
  /**
   * 1 小时成交量。同一个响应里本来就有，白拿。
   *
   * 存在的理由是 24h 量守不住「币刚醒」这件事：实测 FLETCH 在 9-03 凌晨
   * 因为 24h 量跌破退出线被降级，17:15 行情启动时 24h 量还远没爬回
   * $10,000，靠它重新进监控要等一整天。而那五分钟的成交已经是 $3,705，
   * 1 小时口径立刻就看得见。
   */
  volume1hUsd: number;
  /** 市值。用户是按市值思考的（「从 50K 涨到 100K」），报警里要能说人话 */
  marketCapUsd: number | null;
  symbol: string | null;
  /**
   * 项目方在 DexScreener 付费绑定的官网与社交账号，以及代币头像。
   * 同一个响应里本来就有（info 字段），白拿 —— 零额外请求。
   * 没买增强信息的币就没有 info，这几项都是 null/空数组。
   */
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
}

interface RawPair {
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  marketCap?: number;
  info?: {
    imageUrl?: unknown;
    websites?: unknown;
    socials?: unknown;
  };
}

/**
 * 只认 https 的绝对地址。
 *
 * 这些 URL 来自项目方自己填的内容，会原样变成页面上可点的链接 ——
 * 不校验就等于让第三方往我们页面里塞任意 href（javascript: 之类）。
 */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

interface RawLink { url?: unknown; label?: unknown; type?: unknown }

function pickSocial(socials: unknown, type: string): string | null {
  if (!Array.isArray(socials)) return null;
  for (const s of socials as RawLink[]) {
    if (typeof s?.type === 'string' && s.type.toLowerCase() === type) {
      const u = safeUrl(s.url);
      if (u) return u;
    }
  }
  return null;
}

function pickWebsite(websites: unknown): string | null {
  if (!Array.isArray(websites)) return null;
  for (const w of websites as RawLink[]) {
    const u = safeUrl(w?.url);
    if (u) return u;
  }
  return null;
}

export function chunkAddresses(addrs: string[], size = MAX_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < addrs.length; i += size) out.push(addrs.slice(i, i + size));
  return out;
}

/** 地址归一：EVM 大小写不敏感 */
const norm = (a: string) => (a.startsWith('0x') ? a.toLowerCase() : a);

export function parseBatchQuotes(body: string, requested: string[]): Map<string, BatchQuote> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `非 JSON 响应: ${body.slice(0, 120)}`,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '未返回数组' });
  }

  const want = new Set(requested.map(norm));
  const out = new Map<string, BatchQuote>();

  for (const p of parsed as RawPair[]) {
    const addr = p.baseToken?.address ? norm(p.baseToken.address) : null;
    if (!addr || !want.has(addr)) continue;      // 没请求过的忽略
    if (!p.priceUsd) continue;                   // 没价格等于没报价
    const liq = p.liquidity?.usd ?? 0;
    const prev = out.get(addr);
    // 同一代币多个池时取流动性最高的
    if (prev && prev.liquidityUsd >= liq) continue;
    out.set(addr, {
      priceUsd: p.priceUsd,
      liquidityUsd: liq,
      volume24hUsd: p.volume?.h24 ?? 0,
      volume1hUsd: p.volume?.h1 ?? 0,
      // 市值可能真的没有（新币未定供应量），缺就是 null，不拿 0 冒充
      marketCapUsd: typeof p.marketCap === 'number' ? p.marketCap : null,
      symbol: p.baseToken?.symbol ?? null,
      imageUrl: safeUrl(p.info?.imageUrl),
      websiteUrl: pickWebsite(p.info?.websites),
      twitterUrl: pickSocial(p.info?.socials, 'twitter'),
      telegramUrl: pickSocial(p.info?.socials, 'telegram'),
    });
  }
  return out;
}

/**
 * 拉一批报价。返回的 Map 只含拿到报价的地址；**缺的地址不在 Map 里**，
 * 调用方必须把它当作"报价缺失"而不是"流动性为 0"。
 */
export async function fetchBatchQuotes(
  chain: string, addresses: string[],
): Promise<Map<string, BatchQuote>> {
  const chainCfg = getConfig().chains[chain as keyof ReturnType<typeof getConfig>['chains']];
  if (!chainCfg) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain, message: `未知链 ${chain}` });
  }
  const merged = new Map<string, BatchQuote>();

  for (const batch of chunkAddresses(addresses)) {
    const url = `https://api.dexscreener.com/tokens/v1/${chainCfg.dexscreenerId}/${batch.join(',')}`;
    const res = await queue.add(() => httpGet(url, 20_000), { throwOnTimeout: true });
    if (res.status === 429) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: 'rate_limited', chain,
        message: '429 限流', missing: batch,
      });
    }
    if (res.status !== 200) {
      // 单批失败不拖垮整轮：记下来继续下一批，拿到的先用
      log.warn(`${chain} 批量报价 HTTP ${res.status}，本批 ${batch.length} 个地址跳过`);
      continue;
    }
    for (const [k, v] of parseBatchQuotes(res.body, batch)) merged.set(k, v);
  }

  const missing = addresses.map(norm).filter((a) => !merged.has(a));
  if (missing.length > 0) {
    log.debug(`${chain} 有 ${missing.length}/${addresses.length} 个地址没拿到报价`);
  }
  return merged;
}
