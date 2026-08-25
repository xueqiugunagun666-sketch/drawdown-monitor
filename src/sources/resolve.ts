/**
 * 把用户粘贴的内容解析成确定的 (chain, tokenAddress)。
 *
 * 两件事需要联网：
 *   1. EVM 地址无法从字面定链 -> 逐条链探测，取有池子且流动性最高的那条
 *   2. 链接指向的是池子 -> 需查出该池的 base token
 */
import { httpGet } from '../lib/http.ts';
import { getConfig } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import type { ParsedInput } from '../lib/parseTokenInput.ts';
import type { ChainId } from './types.ts';

const log = makeLogger('resolve');

export interface Resolved {
  chain: ChainId;
  address: string;
  symbol: string | null;
  name: string | null;
  liquidityUsd: number;
  poolCount: number;
}

interface Probe { chain: ChainId; symbol: string | null; name: string | null; liquidityUsd: number; poolCount: number }

/** 查某条链上该代币有没有池子；没有返回 null */
async function probeChain(chain: ChainId, address: string): Promise<Probe | null> {
  const dsId = getConfig().chains[chain]?.dexscreenerId;
  if (!dsId) return null;
  try {
    const res = await httpGet(`https://api.dexscreener.com/token-pairs/v1/${dsId}/${address}`, 12_000);
    if (res.status !== 200) return null;
    const arr = JSON.parse(res.body) as Array<{
      baseToken?: { address?: string; symbol?: string; name?: string };
      liquidity?: { usd?: number };
    }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const mine = arr.filter(
      (p) => p.baseToken?.address && p.baseToken.address.toLowerCase() === address.toLowerCase(),
    );
    if (mine.length === 0) return null;
    return {
      chain,
      symbol: mine[0]!.baseToken?.symbol ?? null,
      name: mine[0]!.baseToken?.name ?? null,
      liquidityUsd: mine.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0),
      poolCount: mine.length,
    };
  } catch (err) {
    log.debug(`探测 ${chain}:${address.slice(0, 10)} 失败: ${safeErrorMessage(err)}`);
    return null;
  }
}

/** 池子地址 -> base token 地址。走 GeckoTerminal，它的池子端点比 DexScreener 的 legacy 端点可靠 */
async function poolToToken(chain: ChainId, poolAddress: string): Promise<string | null> {
  const net = getConfig().chains[chain]?.geckoId;
  if (!net) return null;
  try {
    const res = await httpGet(
      `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${poolAddress}`, 15_000,
    );
    if (res.status !== 200) return null;
    const parsed = JSON.parse(res.body) as {
      data?: { relationships?: { base_token?: { data?: { id?: string } } } };
    };
    const id = parsed.data?.relationships?.base_token?.data?.id;
    // 形如 "solana_DezXAZ..." / "eth_0x..."
    if (!id) return null;
    const idx = id.indexOf('_');
    return idx >= 0 ? id.slice(idx + 1) : id;
  } catch (err) {
    log.debug(`池子 ${poolAddress.slice(0, 10)} 解析失败: ${safeErrorMessage(err)}`);
    return null;
  }
}

export async function resolveInput(p: ParsedInput): Promise<{ ok: true; value: Resolved } | { ok: false; error: string }> {
  if (p.error || !p.target) return { ok: false, error: p.error ?? '无法解析' };

  let address = p.target.address;

  // 链接指向池子 -> 先查出代币
  if (p.target.kind === 'pool') {
    if (!p.chain) return { ok: false, error: '池子链接缺少链信息' };
    const tokenAddr = await poolToToken(p.chain, address);
    if (!tokenAddr) return { ok: false, error: `无法从池子 ${address.slice(0, 10)}… 查出对应代币` };
    address = tokenAddr;
  }

  const candidates = p.chain ? [p.chain] : p.candidates;
  if (candidates.length === 0) return { ok: false, error: '无法判断所属链' };

  const probes = (await Promise.all(candidates.map((c) => probeChain(c, address))))
    .filter((x): x is Probe => x !== null);

  if (probes.length === 0) {
    return {
      ok: false,
      error: `在 ${candidates.join(' / ')} 上都没找到该代币的交易池（地址写错了？或者该代币还没有 DEX 池子）`,
    };
  }

  // 多条链都有同名地址时，取流动性最高的那条
  probes.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const best = probes[0]!;
  if (probes.length > 1) {
    log.info(`${address.slice(0, 10)}… 在 ${probes.length} 条链上都有池子，选流动性最高的 ${best.chain}`);
  }
  return { ok: true, value: { chain: best.chain, address, symbol: best.symbol, name: best.name, liquidityUsd: best.liquidityUsd, poolCount: best.poolCount } };
}
