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
import { Decimal } from '../lib/decimal.ts';
import { isMajorQuote, correctPrice, scaleMarketCap } from './quotePrice.ts';
import { getConfig } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('ds-batch');
export const SOURCE_ID = 'dexscreener-batch';

/** DexScreener 的 /tokens/v1/ 一次最多 30 个地址 */
export const MAX_BATCH = 30;

/**
 * 自带节流：钱包循环独立于价格轮询器调用它，不受后者的 maxConcurrency 约束。
 * 限速预算（2026-09-06 重算）：
 *   DexScreener 公开限额        300 req/min（按 IP）
 *   看板轮询占用                 21 个币 / 30 秒 = 42 req/min（同一个 IP）
 *   留 20% 余量                  可用 240，扣掉看板 -> 钱包这边给 200/min
 *
 * 原先是 120/min，太保守：实测 19 个用户时峰值一轮 2,556 个币要 89 个请求，
 * 光排队就 54.9 秒，整轮 61.5 秒**超出 60 秒预算**。提到 200/min 后同样的
 * 轮次排队降到约 27 秒，并把每轮的天花板从 3,600 个币抬到 6,000 个。
 *
 * 单个请求实测只要 0.1 秒，所以真正的成本几乎全是这里的排队间隔 ——
 * 这个常数就是整个系统的容量上限，改它之前先把上面那本账重算一遍。
 */
const queue = new PQueue({ concurrency: 3, interval: 300, intervalCap: 1 });

/**
 * 撞到 429 时先停一会儿。
 *
 * 提速之后余量变薄，万一算错了账（比如看板加了币、或者对方收紧限额），
 * 没有这道缓冲就会**连续**撞 429，每次都丢掉一整批报价 —— 而丢报价是
 * 静默的：币还在监控，只是这一轮没判。停一下让窗口过去，比硬撞划算。
 */
const RATE_LIMIT_PAUSE_MS = 5000;

function backOffOnRateLimit(): void {
  if (queue.isPaused) return;            // 已经在退避中，别叠加
  log.warn(`撞到 429，暂停 ${RATE_LIMIT_PAUSE_MS / 1000} 秒 —— 限速预算可能算低了`);
  queue.pause();
  setTimeout(() => queue.start(), RATE_LIMIT_PAUSE_MS);
}

export interface BatchQuote {
  priceUsd: string;          // 保持字符串 —— 中途不许过 Number
  /** 最终价格来自哪里；其它流动性/成交量字段仍来自 DexScreener。 */
  priceSource?: 'dexscreener' | 'xxyy';
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
   * 这个池子用什么计价，以及以计价代币计的价格。
   *
   * 必须留着，因为 **priceUsd 不能无条件相信**：它是
   * priceUsd = priceNative × 计价代币的美元价 算出来的，而 DexScreener
   * 对小众计价代币的美元估值可能错得离谱。线上实测 GMEB 被估成 $2,307，
   * 而它自己的 GMEB/USDT 池（流动性 $40 万）显示只值 $19.16 —— 拿 GMEB
   * 计价的 9 个币持仓价值全部虚高 120 倍。有了这两项才能交叉验证并重算。
   */
  priceNative: string | null;
  quoteSymbol: string | null;
  quoteAddress: string | null;
  /**
   * 这条报价的美元价被校正过。
   *
   * 带出来是给一次性清理脚本用的：被校正的币，历史 K 线是按虚高价存的，
   * 留着会在序列里制造一次凭空的百倍暴跌。靠它精确定位要清理谁，
   * 比"拿现价和历史比，差太多就删"可靠 —— 后者会把真的暴跌了的币误删。
   */
  priceCorrected: boolean;
  /**
   * 建池时间（秒）。ATH 判定要靠它回答"我们的历史覆盖了这个币的全部生命吗"
   * —— 覆盖了才敢说「历史新高」，否则只能说「N 天新高」。
   * 同一个响应里本来就有，白拿。
   */
  pairCreatedAt: number | null;
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
  priceNative?: unknown;
  quoteToken?: { address?: string; symbol?: string };
  pairCreatedAt?: unknown;
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
      priceSource: 'dexscreener',
      liquidityUsd: liq,
      volume24hUsd: p.volume?.h24 ?? 0,
      volume1hUsd: p.volume?.h1 ?? 0,
      // 市值可能真的没有（新币未定供应量），缺就是 null，不拿 0 冒充
      marketCapUsd: typeof p.marketCap === 'number' ? p.marketCap : null,
      symbol: p.baseToken?.symbol ?? null,
      priceNative: typeof p.priceNative === 'string' ? p.priceNative : null,
      quoteSymbol: p.quoteToken?.symbol ?? null,
      quoteAddress: p.quoteToken?.address ? norm(p.quoteToken.address) : null,
      priceCorrected: false,
      // 毫秒转秒。缺失或不是数字时给 null —— 不知道币多老，就没资格说"全部历史"
      pairCreatedAt: typeof p.pairCreatedAt === 'number' && Number.isFinite(p.pairCreatedAt)
        ? Math.floor(p.pairCreatedAt / 1000) : null,
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
      backOffOnRateLimit();
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

  await applyQuoteCorrections(chain, chainCfg.dexscreenerId, merged);

  const missing = addresses.map(norm).filter((a) => !merged.has(a));
  if (missing.length > 0) {
    log.debug(`${chain} 有 ${missing.length}/${addresses.length} 个地址没拿到报价`);
  }
  return merged;
}


/* ---------------- 计价代币的美元价校正 ---------------- */

/**
 * 计价代币美元价的缓存。
 *
 * 值得缓存是因为**这一层的基数极小**：线上 435 个监控币里出现的不同
 * 计价代币只有 25 个，而且换得很慢。十分钟一刷，成本一次批量请求。
 */
const quoteUsdCache = new Map<string, { price: Decimal | null; at: number }>();
const QUOTE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 查一批计价代币自己的美元价。
 *
 * **只信它用主流资产计价的那个池子** —— 否则就是拿一个可疑的价去验另一个
 * 可疑的价，等于没验。查不到就记 null 并照样缓存，免得每轮都为同一个
 * 查不到的代币重发请求。
 */
async function resolveQuoteUsd(
  dexscreenerId: string, addrs: string[], now: number,
): Promise<Map<string, Decimal | null>> {
  const out = new Map<string, Decimal | null>();
  const need: string[] = [];
  for (const a of addrs) {
    const hit = quoteUsdCache.get(a);
    if (hit && now - hit.at < QUOTE_CACHE_TTL_MS) out.set(a, hit.price);
    else need.push(a);
  }
  if (need.length === 0) return out;

  for (const batch of chunkAddresses(need)) {
    const url = `https://api.dexscreener.com/tokens/v1/${dexscreenerId}/${batch.join(',')}`;
    let res;
    try {
      res = await queue.add(() => httpGet(url, 20_000), { throwOnTimeout: true });
    } catch {
      continue;                    // 校正是尽力而为，失败就保持原价
    }
    // 这条路与报价共用同一个限速预算，撞到 429 同样要退避 ——
    // 只 continue 的话会继续硬撞，把报价那边也拖下水
    if (res.status === 429) { backOffOnRateLimit(); continue; }
    if (res.status !== 200) continue;

    let pairs: unknown;
    try { pairs = JSON.parse(res.body); } catch { continue; }
    if (!Array.isArray(pairs)) continue;

    // 同一个代币可能有多个主流池，取流动性最高的那个
    const best = new Map<string, { price: Decimal; liq: number }>();
    for (const p of pairs as RawPair[]) {
      const a = p.baseToken?.address ? norm(p.baseToken.address) : null;
      if (!a || !batch.includes(a)) continue;
      if (!isMajorQuote(p.quoteToken?.symbol) || !p.priceUsd) continue;
      const liq = p.liquidity?.usd ?? 0;
      const prev = best.get(a);
      if (prev && prev.liq >= liq) continue;
      try { best.set(a, { price: new Decimal(p.priceUsd), liq }); } catch { /* 跳过 */ }
    }
    for (const a of batch) {
      const price = best.get(a)?.price ?? null;
      out.set(a, price);
      quoteUsdCache.set(a, { price, at: now });
    }
  }
  return out;
}

/**
 * 把一批报价里"用小众代币计价"的那些交叉验证一遍，错的重算。
 *
 * 见 quotePrice.ts 顶部：DexScreener 的 priceUsd 是 priceNative × 计价代币
 * 美元价，而它对小众计价代币的估值可能错上百倍。实测 GMEB 一个就让 9 个币
 * 的持仓价值虚高 120 倍。
 */
async function applyQuoteCorrections(
  chain: string, dexscreenerId: string, quotes: Map<string, BatchQuote>,
): Promise<void> {
  const suspects = new Set<string>();
  for (const q of quotes.values()) {
    if (q.quoteAddress && !isMajorQuote(q.quoteSymbol)) suspects.add(q.quoteAddress);
  }
  if (suspects.size === 0) return;

  const real = await resolveQuoteUsd(dexscreenerId, [...suspects], Date.now());
  let fixed = 0;
  for (const [addr, q] of quotes) {
    if (!q.quoteAddress || isMajorQuote(q.quoteSymbol)) continue;
    const r = correctPrice(q.priceUsd, q.priceNative, real.get(q.quoteAddress) ?? null);
    if (!r.corrected) continue;
    quotes.set(addr, {
      ...q,
      priceUsd: r.priceUsd,
      // 市值必须跟着走 —— 供应量不变，只是价错了。不改的话价格 ÷120
      // 而市值原封不动，显示出来就是个自相矛盾的数
      marketCapUsd: scaleMarketCap(q.marketCapUsd, q.priceUsd, r.priceUsd),
      priceCorrected: true,
    });
    fixed++;
    log.warn(
      `${chain}:${addr} 计价代币 ${q.quoteSymbol} 的美元价偏离 `
      + `${r.deviation!.toFixed(1)} 倍，价格由 ${q.priceUsd} 校正为 ${r.priceUsd}`,
    );
  }
  if (fixed > 0) log.info(`${chain} 本批校正了 ${fixed} 个币的美元价`);
}
