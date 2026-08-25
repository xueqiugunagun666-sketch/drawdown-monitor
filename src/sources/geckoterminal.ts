/**
 * GeckoTerminal 适配器 —— P1，用于 OHLCV 历史回填（规格 §4.3）。
 *
 * Phase 0 实测的硬约束：
 *   - limit 上限 1000（limit=2000 -> HTTP 400）
 *   - 时间戳为**秒**，返回**倒序**（新 -> 旧）
 *   - before_timestamp 分页**边界包含**，相邻页首尾重复 1 根，需去重
 *   - 免费档持续可用速率仅 5–8 req/min（文档称 30）：
 *     实测 5.7 req/min 成功率 100%，8 req/min 降到 88%
 *   - 历史深度约 6 个月（日线一次返回 181 根）
 *
 * 每次请求覆盖的时间跨度：
 *   5m -> 1000 根 ≈ 3.47 天   （90 天需 26 次）
 *   1h -> 1000 根 ≈ 41.6 天   （180 天需 5 次）
 */
import PQueue from 'p-queue';
import { httpGet, sleep } from '../lib/http.ts';
import { parsePrice, type Decimal } from '../lib/decimal.ts';
import { SourceError } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';
import type { Candle, Timeframe } from './types.ts';

const log = makeLogger('geckoterminal');
export const SOURCE_ID = 'geckoterminal';

/** 12 秒一次 = 5 req/min，实测该速率成功率 100% */
const MIN_INTERVAL_MS = 12_000;

const queue = new PQueue({ concurrency: 1, interval: MIN_INTERVAL_MS, intervalCap: 1 });

export function pendingRequests(): number {
  return queue.size + queue.pending;
}

const TF_PATH: Record<Timeframe, { path: string; aggregate: number; seconds: number }> = {
  '5m': { path: 'minute', aggregate: 5, seconds: 300 },
  '1h': { path: 'hour', aggregate: 1, seconds: 3600 },
  '1d': { path: 'day', aggregate: 1, seconds: 86400 },
};

/** 单次请求最多返回多少根 */
export const MAX_LIMIT = 1000;

/** 估算覆盖 days 天需要多少次请求 */
export function estimateRequests(timeframe: Timeframe, days: number): number {
  const perRequest = (MAX_LIMIT * TF_PATH[timeframe].seconds) / 86400;
  return Math.max(1, Math.ceil(days / perRequest));
}

interface OhlcvRow extends Array<number> {}

/**
 * 拉一页 OHLCV。
 * @param beforeTimestamp 秒级；返回该时刻**及之前**的数据（边界包含）
 * @param currency 'usd' 取 USD 计价；'token' 取报价代币计价（本项目只用 usd，
 *                 native 计价按 §2.3 由 USD 除以原生币报价推导）
 */
export async function fetchOHLCVPage(
  network: string,
  poolAddress: string,
  timeframe: Timeframe,
  beforeTimestamp?: number,
): Promise<Candle[]> {
  const tf = TF_PATH[timeframe];
  const params = new URLSearchParams({
    aggregate: String(tf.aggregate),
    limit: String(MAX_LIMIT),
    currency: 'usd',
    token: 'base',
  });
  if (beforeTimestamp !== undefined) params.set('before_timestamp', String(beforeTimestamp));
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${tf.path}?${params}`;

  return queue.add(async () => {
    const MAX_ATTEMPTS = 4;
    let lastMsg = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await httpGet(url, 25_000);
      } catch (err) {
        lastMsg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
        break;
      }

      if (res.status === 429) {
        // 限流是常态而非异常，退避后重试；用尽才抛
        const wait = 15_000 * attempt;
        lastMsg = `429 限流`;
        log.debug(`${network}/${poolAddress.slice(0, 10)} 429，${wait / 1000}s 后重试 (${attempt}/${MAX_ATTEMPTS})`);
        if (attempt < MAX_ATTEMPTS) { await sleep(wait); continue; }
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'rate_limited',
          message: `GT 持续限流: ${network}/${poolAddress}` });
      }
      if (res.status !== 200) {
        lastMsg = `HTTP ${res.status}`;
        if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
        break;
      }

      let parsed: { data?: { attributes?: { ohlcv_list?: OhlcvRow[] } } };
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed',
          message: `GT 响应不是合法 JSON: ${network}/${poolAddress}` });
      }

      const list = parsed.data?.attributes?.ohlcv_list;
      if (!Array.isArray(list)) {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed',
          message: `GT 响应缺少 ohlcv_list: ${network}/${poolAddress}` });
      }

      // 空列表在回填语境下是合法结果（表示该时点之前没有数据了），不是失败
      const out: Candle[] = [];
      for (const row of list) {
        const [ts, o, h, l, c, v] = row;
        if (ts === undefined) continue;
        const po = parsePrice(String(o)), ph = parsePrice(String(h));
        const pl = parsePrice(String(l)), pc = parsePrice(String(c));
        if (!po || !ph || !pl || !pc) continue;
        out.push({ ts, o: po, h: ph, l: pl, c: pc, volumeUsd: Number(v) || 0 });
      }
      // GT 返回倒序，统一转为升序
      out.sort((a, b) => a.ts - b.ts);
      return out;
    }

    throw new SourceError({ sourceId: SOURCE_ID, kind: 'http_error',
      message: `GT 取 OHLCV 失败 ${network}/${poolAddress}: ${lastMsg}` });
  }) as Promise<Candle[]>;
}

/**
 * 向前翻页拉取，直到覆盖 sinceTs 或没有更多数据。
 * @param onPage 每页回调，便于断点续传时逐页落库
 */
export async function fetchOHLCVRange(
  network: string,
  poolAddress: string,
  timeframe: Timeframe,
  sinceTs: number,
  onPage?: (candles: Candle[], oldestTs: number) => void,
): Promise<Candle[]> {
  const all: Candle[] = [];
  const seen = new Set<number>();
  let before: number | undefined;

  for (let page = 0; page < 60; page++) {
    const batch = await fetchOHLCVPage(network, poolAddress, timeframe, before);
    if (batch.length === 0) break;

    // before_timestamp 边界包含 -> 相邻页首尾重复 1 根，去重
    const fresh = batch.filter((c) => !seen.has(c.ts));
    for (const c of fresh) seen.add(c.ts);
    all.push(...fresh);

    const oldest = batch[0]!.ts;
    onPage?.(fresh, oldest);

    if (oldest <= sinceTs) break;
    if (fresh.length === 0) break;   // 再翻也拿不到新数据，防止死循环
    before = oldest;
  }

  all.sort((a, b) => a.ts - b.ts);
  return all.filter((c) => c.ts >= sinceTs);
}
