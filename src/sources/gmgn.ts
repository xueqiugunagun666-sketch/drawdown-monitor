/**
 * GMGN OpenAPI 适配器 —— OHLCV 历史回填的主源，GeckoTerminal 退为兜底。
 *
 * 实测要点（文档与实际有出入，以实测为准）：
 *   - 只读接口不需要签名，但 query 必须带 timestamp（Unix 秒）与 client_id（UUID），
 *     少任何一个都返回 401 AUTH_INVALID。签名（X-Signature）只有下单类接口才要，
 *     本项目不做交易，因此永远用不到私钥。
 *   - 时间戳单位是**毫秒**（文档写的 "Unix seconds" 是错的，传秒返回空数组）。
 *   - 翻页参数是 `to`，不是 before/end/until 之类；`from` 被完全忽略。
 *   - `limit` 上限 1000，与 GeckoTerminal 相同。
 *   - **限流按 IP 共享，不按 Key**：实测把公共 Key 打爆后，同一 IP 上的个人 Key
 *     立刻一起 429。所以多申请 Key 提速是无效的，这里只维护一个全局队列。
 *   - 串行约 100 req/min 可稳定跑满（零 429）；一加并发立刻触顶。
 *
 * 字段陷阱：`volume` 是**美元金额**，`amount` 是**代币数量**，两者差若干数量级。
 * vol_floor 与展示都要用 volume。
 */
import PQueue from 'p-queue';
import { randomUUID } from 'node:crypto';
import { httpGet, sleep } from '../lib/http.ts';
import { parsePrice } from '../lib/decimal.ts';
import { SourceError } from '../lib/errors.ts';
import { getSecrets } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import type { Candle, Timeframe } from './types.ts';

const log = makeLogger('gmgn');
export const SOURCE_ID = 'gmgn';
const HOST = 'https://openapi.gmgn.ai';

/** 实测串行 ~100 req/min 零 429；留出余量按 80/min 跑 */
const MIN_INTERVAL_MS = 750;
const queue = new PQueue({ concurrency: 1, interval: MIN_INTERVAL_MS, intervalCap: 1 });

export const MAX_LIMIT = 1000;

/** 我们的 timeframe -> GMGN 的 resolution */
const RESOLUTION: Record<Timeframe, string> = { '5m': '5m', '1h': '1h', '1d': '1d' };

/** 我们的 ChainId -> GMGN 的 chain 参数 */
const CHAIN_MAP: Record<string, string> = {
  ethereum: 'eth', base: 'base', bsc: 'bsc', solana: 'sol', robinhood: 'robinhood',
};

export function isConfigured(): boolean {
  return Boolean(getSecrets().gmgnApiKey);
}

export function supportsChain(chain: string): boolean {
  return chain in CHAIN_MAP;
}

interface RawKline {
  time: number;      // 毫秒
  open: string; close: string; high: string; low: string;
  volume: string;    // 美元金额
  amount: string;    // 代币数量 —— 不要用
}

/**
 * 拉一页 K 线。
 * @param beforeTsSeconds 秒级；返回该时刻之前的数据（内部转成毫秒的 `to`）
 */
export async function fetchKlinePage(
  chain: string,
  tokenAddress: string,
  timeframe: Timeframe,
  beforeTsSeconds?: number,
): Promise<Candle[]> {
  const apiKey = getSecrets().gmgnApiKey;
  if (!apiKey) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: 'GMGN_API_KEY 未配置' });
  }
  const gmgnChain = CHAIN_MAP[chain];
  if (!gmgnChain) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain, message: `GMGN 不支持链 ${chain}` });
  }

  return queue.add(async () => {
    const MAX_ATTEMPTS = 4;
    let lastMsg = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const params = new URLSearchParams({
        chain: gmgnChain,
        address: tokenAddress,
        resolution: RESOLUTION[timeframe],
        limit: String(MAX_LIMIT),
        // 服务端校验 timestamp 在 ±5 秒内，必须每次现取
        timestamp: String(Math.floor(Date.now() / 1000)),
        client_id: randomUUID(),
      });
      if (beforeTsSeconds !== undefined) params.set('to', String(beforeTsSeconds * 1000));

      let res;
      try {
        res = await httpGet(`${HOST}/v1/market/token_kline?${params}`, 25_000, { 'X-APIKEY': apiKey });
      } catch (err) {
        lastMsg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
        break;
      }

      if (res.status === 429) {
        // 实测触发限流后要约 292 秒才恢复，退避必须是分钟级，
        // 20 秒那种量级只会白白重试完然后失败
        const wait = 90_000 * attempt;
        lastMsg = '429 限流';
        log.debug(`${chain}:${tokenAddress.slice(0, 10)} 429，${wait / 1000}s 后重试 (${attempt}/${MAX_ATTEMPTS})`);
        if (attempt < MAX_ATTEMPTS) { await sleep(wait); continue; }
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'rate_limited', chain,
          message: `GMGN 持续限流: ${chain}:${tokenAddress}` });
      }
      if (res.status === 401 || res.status === 403) {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'http_error', chain,
          message: `GMGN 鉴权失败 (HTTP ${res.status}) —— 检查 GMGN_API_KEY；另注意该 API 不支持 IPv6` });
      }
      if (res.status !== 200) {
        lastMsg = `HTTP ${res.status}`;
        if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
        break;
      }

      let parsed: { code?: number; data?: { list?: RawKline[] }; message?: string };
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain,
          message: `GMGN 响应不是合法 JSON: ${chain}:${tokenAddress}` });
      }
      if (parsed.code !== undefined && parsed.code !== 0) {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'http_error', chain,
          message: `GMGN 返回错误 code=${parsed.code}: ${parsed.message ?? ''}` });
      }

      const list = parsed.data?.list;
      if (!Array.isArray(list)) {
        throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain,
          message: `GMGN 响应缺少 data.list: ${chain}:${tokenAddress}` });
      }

      const out: Candle[] = [];
      for (const r of list) {
        const o = parsePrice(r.open), h = parsePrice(r.high);
        const l = parsePrice(r.low), c = parsePrice(r.close);
        if (!o || !h || !l || !c) continue;
        out.push({
          ts: Math.floor(r.time / 1000),          // 毫秒 -> 秒，与 GT 及库内统一
          o, h, l, c,
          volumeUsd: Number(r.volume) || 0,        // 注意不是 amount
        });
      }
      out.sort((a, b) => a.ts - b.ts);
      return out;
    }
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'http_error', chain,
      message: `GMGN 取 K 线失败 ${chain}:${tokenAddress}: ${lastMsg}` });
  }) as Promise<Candle[]>;
}
