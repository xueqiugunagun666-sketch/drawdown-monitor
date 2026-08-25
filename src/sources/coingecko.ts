/**
 * CoinGecko 请求的统一入口。
 *
 * 实时报价（60s 一次）与历史回填（3 symbol × 2 区间的突发）如果各自直连，
 * 会互相抢免费档配额并把对方打成 429。所有 CoinGecko 请求都要走这里的
 * 共享队列，串行 + 限速。
 */
import PQueue from 'p-queue';
import { httpGet, sleep } from '../lib/http.ts';
import { SourceError } from '../lib/errors.ts';
import { getSecrets } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('coingecko');

/** 免费档实测：6 个请求连发必 429。5 秒一个 = 12 req/min，留足余量 */
const MIN_INTERVAL_MS = 5_000;
const queue = new PQueue({ concurrency: 1, interval: MIN_INTERVAL_MS, intervalCap: 1 });

export function apiBase(): string {
  return getSecrets().coingeckoApiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
}

export function withKey(url: string): string {
  const key = getSecrets().coingeckoApiKey;
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + `x_cg_pro_api_key=${key}`;
}

/** 经共享队列发起请求；429 自动退避重试，用尽才抛 */
export async function cgGet(url: string, label: string, timeoutMs = 30_000): Promise<string> {
  return queue.add(async () => {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await httpGet(withKey(url), timeoutMs);
      if (res.status === 200) return res.body;
      if (res.status === 429) {
        if (attempt === MAX_ATTEMPTS) {
          throw new SourceError({ sourceId: 'coingecko', kind: 'rate_limited',
            message: `CoinGecko 持续限流 (${label})` });
        }
        const wait = 12_000 * attempt;
        log.debug(`429 (${label})，${wait / 1000}s 后重试 (${attempt}/${MAX_ATTEMPTS})`);
        await sleep(wait);
        continue;
      }
      throw new SourceError({ sourceId: 'coingecko', kind: 'http_error',
        message: `CoinGecko HTTP ${res.status} (${label})` });
    }
    throw new SourceError({ sourceId: 'coingecko', kind: 'http_error', message: `CoinGecko 失败 (${label})` });
  }) as Promise<string>;
}
