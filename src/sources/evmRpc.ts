/**
 * EVM JSON-RPC 客户端 —— 四条链共用一个代理端点，路径末尾是 chain id。
 *
 * 实测要点（以实测为准，不信文档）：
 *   - 端点接受 JSON-RPC 批量请求（请求体是数组），返回也是数组，
 *     但**返回顺序不保证**，必须按 id 归位。
 *   - eth_getLogs 的限制是**响应体积**，不是块跨度。带地址过滤时
 *     全链范围（0 → latest）一次就能查完 —— Robinhood 链 4990 万块、
 *     1076 条日志、4.5 秒。不带过滤时几千个块就会超限。
 *   - 网关过载返回的是纯文本 "error code: 504"，不是 JSON。
 *   - 端点 URL 本身按密钥处理（见 config.ts 的 registerSecret）。
 */
import PQueue from 'p-queue';
import { httpPostJson } from '../lib/http.ts';
import { getSecrets } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';

export const SOURCE_ID = 'evm-rpc';

/** 本期支持的链。solana 不在其中 —— 公共节点封了 getTokenAccountsByOwner。 */
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, bsc: 56, base: 8453, robinhood: 4663,
};

export function chainIdOf(chain: string): number | null {
  return CHAIN_IDS[chain] ?? null;
}

export function supportedChains(): string[] {
  return Object.keys(CHAIN_IDS);
}

/** 并发 2 —— 实测公共节点两条并发就开始 429，自有端点也不该往死里打。 */
const queue = new PQueue({ concurrency: 2 });

export interface BatchItem { id: number; result: string | null; error: string | null }

function requireJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `非 JSON 响应: ${body.slice(0, 120)}`,
    });
  }
}

export function parseRpcResponse<T = string>(body: string): T {
  const j = requireJson(body) as { result?: T; error?: { message?: string } };
  if (j.error) {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'http_error',
      message: j.error.message ?? JSON.stringify(j.error),
    });
  }
  // 注意用 'result' in j 而不是 j.result !== undefined：
  // result 为 null 是合法响应（比如查一个不存在的区块）
  if (!('result' in j)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '响应既无 result 也无 error' });
  }
  return j.result as T;
}

export function parseBatchResponse(body: string, ids: number[]): BatchItem[] {
  const j = requireJson(body);
  if (!Array.isArray(j)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '批量请求未返回数组' });
  }
  const byId = new Map<number, { result?: string; error?: { message?: string } }>();
  for (const item of j as Array<{ id: number }>) byId.set(item.id, item as never);
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, result: null, error: '响应中缺少该 id' };
    if (r.error) return { id, result: null, error: r.error.message ?? JSON.stringify(r.error) };
    return { id, result: r.result ?? null, error: null };
  });
}

function endpoint(chain: string): string {
  const base = getSecrets().evmRpcBase;
  if (!base) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: 'EVM_RPC_BASE 未配置' });
  }
  const id = chainIdOf(chain);
  if (id === null) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain, message: `不支持的链 ${chain}` });
  }
  return `${base.replace(/\/+$/, '')}/${id}`;
}

export async function rpc<T = string>(
  chain: string, method: string, params: unknown[], timeoutMs = 60_000,
): Promise<T> {
  const url = endpoint(chain);
  const run = async (): Promise<T> => {
    const res = await httpPostJson(url, { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
    if (res.status !== 200) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: res.status === 429 ? 'rate_limited' : 'http_error', chain,
        message: `HTTP ${res.status}: ${res.body.slice(0, 120)}`,
      });
    }
    return parseRpcResponse<T>(res.body);
  };
  return queue.add(run, { throwOnTimeout: true }) as Promise<T>;
}

/** 批量调用。返回数组顺序与传入的 calls 一致。 */
export async function rpcBatch(
  chain: string, calls: Array<{ method: string; params: unknown[] }>, timeoutMs = 60_000,
): Promise<BatchItem[]> {
  if (calls.length === 0) return [];
  const url = endpoint(chain);
  const ids = calls.map((_, i) => i + 1);
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params }));
  const run = async (): Promise<BatchItem[]> => {
    const res = await httpPostJson(url, payload, timeoutMs);
    if (res.status !== 200) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: res.status === 429 ? 'rate_limited' : 'http_error', chain,
        message: `HTTP ${res.status}: ${res.body.slice(0, 120)}`,
      });
    }
    return parseBatchResponse(res.body, ids);
  };
  return queue.add(run, { throwOnTimeout: true }) as Promise<BatchItem[]>;
}

export async function blockNumber(chain: string): Promise<number> {
  return Number(BigInt(await rpc<string>(chain, 'eth_blockNumber', [])));
}
