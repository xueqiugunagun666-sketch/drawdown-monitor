/**
 * 批量读 ERC20 余额与 decimals。
 *
 * 用 JSON-RPC 批量请求（一个 HTTP 请求里发一个调用数组），不用 Multicall3 ——
 * 后者要对 (address,bool,bytes)[] 这种嵌套动态类型做 ABI 编码，项目里没有
 * 编码库，手写容易错；而且 Robinhood 这种新链未必部署了 Multicall3。
 * JSON-RPC 批量拿到了同样的收益，代价是十行代码，且不依赖任何链上合约。
 */
import { rpcBatch, type BatchItem } from './evmRpc.ts';
import { encodeBalanceOf, SELECTOR_DECIMALS, decodeUint256, decodeUint8 } from './erc20.ts';

/** 每个 HTTP 请求里塞多少个 eth_call */
export const CALLS_PER_REQUEST = 50;

export interface PlannedCall {
  kind: 'balance' | 'decimals';
  token: string;
  data: string;
}

export interface TokenBalance {
  balance: string;              // 十进制字符串，绝不过 Number
  decimals: number | null;      // 读不到就是 null，不猜 18
}

export type BatchFn = (chain: string, calls: Array<{ method: string; params: unknown[] }>) => Promise<BatchItem[]>;

/**
 * decimals 只对未知的代币读 —— 它是不变量，读过一次就该存下来。
 * 每轮重读会让请求量翻倍。
 */
export function buildBalanceCalls(
  wallet: string, tokens: string[], knownDecimals: Map<string, number | null>,
): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const t of tokens) {
    // 注意参数是**钱包地址**不是代币地址。传错会读到代币合约自己的余额，
    // 有数字返回、不报错、但完全不是你的持仓
    calls.push({ kind: 'balance', token: t, data: encodeBalanceOf(wallet) });
    const d = knownDecimals.get(t);
    if (d === undefined || d === null) {
      calls.push({ kind: 'decimals', token: t, data: SELECTOR_DECIMALS });
    }
  }
  return calls;
}

export function mapBalanceResults(
  calls: PlannedCall[], results: BatchItem[], knownDecimals: Map<string, number | null>,
): Map<string, TokenBalance> {
  const balances = new Map<string, string>();
  const decimals = new Map<string, number | null>();
  const failed = new Set<string>();

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const r = results[i];
    if (!r || r.error !== null || r.result === null) {
      if (c.kind === 'balance') failed.add(c.token);
      continue;
    }
    if (c.kind === 'balance') balances.set(c.token, decodeUint256(r.result));
    else decimals.set(c.token, decodeUint8(r.result));
  }

  const out = new Map<string, TokenBalance>();
  for (const [token, balance] of balances) {
    if (failed.has(token)) continue;
    const d = decimals.has(token) ? decimals.get(token)! : (knownDecimals.get(token) ?? null);
    out.set(token, { balance, decimals: d });
  }
  return out;
}

/**
 * 按**代币边界**切批，不按调用数硬切。
 *
 * 硬切会把某个代币的 balanceOf 与 decimals 劈到两批里：前一批只有余额、
 * decimals 落到后一批，而后一批没有对应的余额调用，于是那个 decimals
 * 被丢弃，该代币的 decimals 永远是 null，静默地不进监控。
 *
 * 只有当已知与未知 decimals 混在一起、调用流错位时才会触发
 * （全部未知时每代币恰好 2 个调用，按 50 切正好落在边界上），
 * 所以这是个只在部分数据下出现、且不报错的 bug。
 */
export function chunkByToken(planned: PlannedCall[], limit = CALLS_PER_REQUEST): PlannedCall[][] {
  const out: PlannedCall[][] = [];
  let cur: PlannedCall[] = [];
  let i = 0;
  while (i < planned.length) {
    // 收集属于同一个代币的连续调用，整组要么都进当前批，要么都进下一批
    let j = i;
    while (j < planned.length && planned[j]!.token === planned[i]!.token) j++;
    const group = planned.slice(i, j);
    if (cur.length > 0 && cur.length + group.length > limit) {
      out.push(cur);
      cur = [];
    }
    cur.push(...group);
    i = j;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 可注入批量函数的版本，方便测试 */
export async function readBalancesWith(
  batch: BatchFn, chain: string, wallet: string,
  tokens: string[], knownDecimals: Map<string, number | null>,
): Promise<Map<string, TokenBalance>> {
  if (tokens.length === 0) return new Map();
  const out = new Map<string, TokenBalance>();

  for (const slice of chunkByToken(buildBalanceCalls(wallet, tokens, knownDecimals))) {
    const results = await batch(chain, slice.map((c) => ({
      method: 'eth_call',
      params: [{ to: c.token, data: c.data }, 'latest'],
    })));
    for (const [k, v] of mapBalanceResults(slice, results, knownDecimals)) out.set(k, v);
  }
  return out;
}

export function readBalances(
  chain: string, wallet: string, tokens: string[], knownDecimals: Map<string, number | null>,
): Promise<Map<string, TokenBalance>> {
  return readBalancesWith(rpcBatch, chain, wallet, tokens, knownDecimals);
}
