/**
 * GMGN 代币基础信息 —— 目前只用 holder_count。
 *
 * 几十万持有人的币基本都是空投盘：币是白送的，持有人数虚高，
 * 那种"从 2e-09 拉到 1.6e-06"的曲线是开盘假量，不是行情。
 *
 * 为什么用绝对值而不是比例：实测比例法分不开这两类 ——
 * USDT 的持有人/24h成交量是 13.0，比空投盘 MOONALD 的 2.71 还"差"，
 * 因为稳定币人人持有但人均交易少。
 *
 * 实测四条链（eth / bsc / base / robinhood）都能返回 holder_count。
 */
import { randomUUID } from 'node:crypto';
import { httpGet } from '../lib/http.ts';
import { getSecrets } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('gmgn-info');
export const SOURCE_ID = 'gmgn-token-info';
const HOST = 'https://openapi.gmgn.ai';

/** 与 gmgn.ts 的 CHAIN_MAP 保持一致 */
const CHAIN_MAP: Record<string, string> = {
  ethereum: 'eth', base: 'base', bsc: 'bsc', solana: 'sol', robinhood: 'robinhood',
};

export interface TokenInfo {
  symbol: string | null;
  holderCount: number | null;
}

type TokenInfoRequest = (
  url: string, timeoutMs: number, headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export interface FetchTokenInfoOptions {
  /** 测试注入；生产省略时读取环境里的密钥。 */
  apiKey?: string;
  request?: TokenInfoRequest;
}

/** 从原始响应里取我们要的字段。单独导出便于测试，不必打网络 */
export function parseTokenInfo(body: string): TokenInfo | null {
  let j: { code?: number; data?: { symbol?: string; holder_count?: number } };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    return null;
  }
  if (j.code !== 0 || !j.data) return null;
  const h = j.data.holder_count;
  return {
    symbol: j.data.symbol ?? null,
    // 0 是合法值（新币还没有持有人），不能用 || 兜底成 null
    holderCount: typeof h === 'number' && Number.isFinite(h) ? h : null,
  };
}

export function supportsChain(chain: string): boolean {
  return chain in CHAIN_MAP;
}

export async function fetchTokenInfo(
  chain: string, address: string, options: FetchTokenInfoOptions = {},
): Promise<TokenInfo | null> {
  const apiKey = options.apiKey ?? getSecrets().gmgnApiKey;
  const gmgnChain = CHAIN_MAP[chain];
  if (!apiKey || !gmgnChain) return null;
  const request = options.request ?? httpGet;

  const params = new URLSearchParams({
    chain: gmgnChain,
    address,
    // 服务端校验 timestamp 在 ±5 秒内，必须每次现取
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: randomUUID(),
  });

  let res;
  try {
    res = await request(`${HOST}/v1/token/info?${params}`, 15_000, { 'X-APIKEY': apiKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`${chain}:${address.slice(0, 10)} 请求失败: ${message}`);
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'network', chain, message });
  }
  if (res.status === 429) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'rate_limited', chain, message: '429 限流' });
  }
  if (res.status !== 200) {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'http_error', chain, message: `HTTP ${res.status}`,
    });
  }
  return parseTokenInfo(res.body);
}
