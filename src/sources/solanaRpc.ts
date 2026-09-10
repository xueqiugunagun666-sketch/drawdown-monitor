/**
 * Solana 钱包持仓快照。
 *
 * 一次批量请求同时读取经典 SPL Token 与 Token-2022。只有两项都成功、
 * 每个账户都能严格解析时才返回完整快照；调用方随后才允许删除旧持仓。
 * 这样上游部分响应或格式变化不会被误解为“用户已经卖掉”。
 */
import PQueue from 'p-queue';
import { getSecrets } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';
import { httpPostJson } from '../lib/http.ts';
import { isSolanaWalletAddress } from '../lib/walletAddress.ts';

export const SOURCE_ID = 'xxyy-solana-rpc';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const queue = new PQueue({ concurrency: 1, interval: 250, intervalCap: 1 });

export interface SolanaTokenBalance {
  mint: string;
  balance: string;
  decimals: number;
}

export interface SolanaWalletSnapshot {
  slot: number;
  balances: Map<string, SolanaTokenBalance>;
}

interface RpcItem { id?: unknown; result?: unknown; error?: { message?: unknown } }

function malformed(message: string): SourceError {
  return new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain: 'solana', message });
}

function parseResult(item: RpcItem | undefined, id: number): { slot: number; value: unknown[] } {
  if (!item) throw malformed(`RPC 批量响应缺少 id=${id}`);
  if (item.error) throw new SourceError({
    sourceId: SOURCE_ID, kind: 'http_error', chain: 'solana',
    message: `RPC id=${id}: ${String(item.error.message ?? '未知错误')}`,
  });
  if (!item.result || typeof item.result !== 'object') throw malformed(`RPC id=${id} result 格式错误`);
  const result = item.result as { context?: { slot?: unknown }; value?: unknown };
  const slot = result.context?.slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < 0 || !Array.isArray(result.value)) {
    throw malformed(`RPC id=${id} 缺少有效 context.slot 或 value`);
  }
  return { slot: slot as number, value: result.value };
}

function parseAccount(raw: unknown, wallet: string): SolanaTokenBalance {
  if (!raw || typeof raw !== 'object') throw malformed('token account 不是对象');
  const account = (raw as { account?: unknown }).account;
  if (!account || typeof account !== 'object') throw malformed('token account 缺少 account');
  const data = (account as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw malformed('token account 不是 jsonParsed');
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== 'object') throw malformed('token account 缺少 parsed');
  const info = (parsed as { info?: unknown }).info;
  if (!info || typeof info !== 'object') throw malformed('token account 缺少 info');

  const value = info as {
    mint?: unknown; owner?: unknown;
    tokenAmount?: { amount?: unknown; decimals?: unknown };
  };
  if (value.owner !== wallet) throw malformed('token account owner 与请求钱包不一致');
  if (typeof value.mint !== 'string' || !isSolanaWalletAddress(value.mint)) {
    throw malformed('token account mint 无效');
  }
  const amount = value.tokenAmount?.amount;
  const decimals = value.tokenAmount?.decimals;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) throw malformed('token amount 不是无符号整数字符串');
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw malformed('token decimals 无效');
  }
  return { mint: value.mint, balance: amount, decimals: decimals as number };
}

export function parseSolanaTokenAccounts(body: string, wallet: string): SolanaWalletSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw malformed(`非 JSON 响应: ${body.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) throw malformed('RPC 批量响应不是数组');

  const byId = new Map<number, RpcItem>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') throw malformed('RPC 批量元素不是对象');
    const item = raw as RpcItem;
    if (!Number.isInteger(item.id)) throw malformed('RPC 批量元素缺少整数 id');
    byId.set(item.id as number, item);
  }
  const classic = parseResult(byId.get(1), 1);
  const token2022 = parseResult(byId.get(2), 2);
  const merged = new Map<string, SolanaTokenBalance>();

  for (const raw of [...classic.value, ...token2022.value]) {
    const next = parseAccount(raw, wallet);
    const old = merged.get(next.mint);
    if (old && old.decimals !== next.decimals) {
      throw malformed(`同一 mint 的 decimals 不一致: ${next.mint}`);
    }
    const total = (old ? BigInt(old.balance) : 0n) + BigInt(next.balance);
    merged.set(next.mint, { ...next, balance: total.toString() });
  }

  for (const [mint, balance] of merged) {
    if (BigInt(balance.balance) === 0n) merged.delete(mint);
  }
  return { slot: Math.min(classic.slot, token2022.slot), balances: merged };
}

export async function fetchSolanaWalletSnapshot(wallet: string): Promise<SolanaWalletSnapshot> {
  if (!isSolanaWalletAddress(wallet)) throw malformed('Solana 钱包地址无效');
  const url = getSecrets().solanaRpcUrl;
  if (!url) throw malformed('SOLANA_RPC_URL 未配置');

  const payload = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId, index) => ({
    jsonrpc: '2.0', id: index + 1, method: 'getTokenAccountsByOwner',
    params: [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  }));
  const run = async () => {
    const res = await httpPostJson(url, payload, 30_000);
    if (res.status !== 200) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: res.status === 429 ? 'rate_limited' : 'http_error', chain: 'solana',
        message: `HTTP ${res.status}: ${res.body.slice(0, 120)}`,
      });
    }
    return parseSolanaTokenAccounts(res.body, wallet);
  };
  return queue.add(run, { throwOnTimeout: true }) as Promise<SolanaWalletSnapshot>;
}
