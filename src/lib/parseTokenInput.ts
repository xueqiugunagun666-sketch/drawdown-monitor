/**
 * 解析用户粘贴的内容 —— 规格 §9.4。
 *
 * 支持四种形式：
 *   1. 纯地址：Solana base58 / EVM 0x...
 *   2. chain:address
 *   3. DexScreener / GeckoTerminal / GMGN 的链接
 *   4. 一行一个，批量
 *
 * EVM 地址无法从字面判断属于哪条链，返回 candidates 供后续探测。
 */
import { CHAIN_IDS, type ChainId } from '../sources/types.ts';

/** 各站点的链名 -> 我们的 ChainId */
const SITE_CHAIN_ALIASES: Record<string, ChainId> = {
  ethereum: 'ethereum', eth: 'ethereum',
  base: 'base',
  bsc: 'bsc', binance: 'bsc', bnb: 'bsc',
  solana: 'solana', sol: 'solana',
  robinhood: 'robinhood',
};

export type ParsedKind =
  | { kind: 'token'; address: string }
  /** 链接指向的是池子，需要再查一次才知道是哪个代币 */
  | { kind: 'pool'; address: string };

export interface ParsedInput {
  raw: string;
  chain: ChainId | null;
  /** chain 为 null 时的候选链（EVM 地址无法从字面区分） */
  candidates: ChainId[];
  target: ParsedKind | null;
  error: string | null;
}

const EVM_CHAINS: ChainId[] = ['ethereum', 'base', 'bsc', 'robinhood'];

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
// Solana base58：不含 0 O I l，长度 32-44
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function classifyAddress(addr: string): { chain: ChainId | null; candidates: ChainId[] } | null {
  if (EVM_ADDRESS.test(addr)) return { chain: null, candidates: EVM_CHAINS };
  if (SOLANA_ADDRESS.test(addr)) return { chain: 'solana', candidates: ['solana'] };
  return null;
}

function fail(raw: string, error: string): ParsedInput {
  return { raw, chain: null, candidates: [], target: null, error };
}

/** 从 URL 里抽出链与地址 */
function parseUrl(raw: string): ParsedInput | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  // dexscreener.com/{chain}/{pairAddress}
  if (host.endsWith('dexscreener.com')) {
    const [chainSeg, addr] = parts;
    const chain = chainSeg ? SITE_CHAIN_ALIASES[chainSeg.toLowerCase()] : undefined;
    if (!chain || !addr) return fail(raw, 'DexScreener 链接格式无法识别');
    // DexScreener 的详情页地址是**池子**，不是代币
    return { raw, chain, candidates: [chain], target: { kind: 'pool', address: addr }, error: null };
  }

  // geckoterminal.com/{network}/pools/{pool} 或 /{network}/tokens/{token}
  if (host.endsWith('geckoterminal.com')) {
    const [netSeg, type, addr] = parts;
    const chain = netSeg ? SITE_CHAIN_ALIASES[netSeg.toLowerCase()] : undefined;
    if (!chain || !addr) return fail(raw, 'GeckoTerminal 链接格式无法识别');
    const kind = type === 'pools' ? 'pool' : 'token';
    return { raw, chain, candidates: [chain], target: { kind, address: addr }, error: null };
  }

  // gmgn.ai/{chain}/token/{address}
  if (host.endsWith('gmgn.ai')) {
    const [chainSeg, , addr] = parts;
    const chain = chainSeg ? SITE_CHAIN_ALIASES[chainSeg.toLowerCase()] : undefined;
    if (!chain || !addr) return fail(raw, 'GMGN 链接格式无法识别');
    return { raw, chain, candidates: [chain], target: { kind: 'token', address: addr }, error: null };
  }

  // 其他站点：尝试从路径里捞出一个像地址的片段
  for (const seg of [...parts].reverse()) {
    const c = classifyAddress(seg);
    if (c) return { raw, ...c, target: { kind: 'token', address: seg }, error: null };
  }
  return fail(raw, '无法从该链接中识别代币地址');
}

export function parseOne(input: string): ParsedInput {
  const raw = input.trim();
  if (!raw) return fail(input, '空行');

  if (/^https?:\/\//i.test(raw)) {
    return parseUrl(raw) ?? fail(raw, '无法识别的链接');
  }

  // chain:address
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const maybeChain = raw.slice(0, colon).toLowerCase();
    const rest = raw.slice(colon + 1).trim();
    const chain = SITE_CHAIN_ALIASES[maybeChain];
    if (chain) {
      if (!classifyAddress(rest)) return fail(raw, `"${rest}" 不像是有效地址`);
      return { raw, chain, candidates: [chain], target: { kind: 'token', address: rest }, error: null };
    }
    if ((CHAIN_IDS as string[]).includes(maybeChain)) {
      return { raw, chain: maybeChain as ChainId, candidates: [maybeChain as ChainId],
        target: { kind: 'token', address: rest }, error: null };
    }
  }

  const c = classifyAddress(raw);
  if (!c) return fail(raw, '既不是 Solana base58 地址，也不是 EVM 0x 地址');
  return { raw, ...c, target: { kind: 'token', address: raw }, error: null };
}

/** 批量：一行一个，忽略空行 */
export function parseMany(text: string): ParsedInput[] {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseOne);
}
