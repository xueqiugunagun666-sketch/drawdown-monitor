/**
 * 代币身份与报价缓存键。
 *
 * 地址本身不是全局唯一标识：同一个 EVM 地址可以出现在多条链上，
 * Solana mint 又是大小写敏感的。因此所有跨来源/跨链的身份比较都必须
 * 先经过这里，而不能在调用点各写一份 startsWith('0x')。
 */

export type QuoteIdentityTrust = 'trusted' | 'mismatch' | 'unknown';

export interface QuoteIdentity {
  chain: string;
  address: string | null;
  symbol: string | null;
  trust: QuoteIdentityTrust;
}

function normalizeChain(chain: string): string {
  return chain.trim().toLowerCase();
}

/**
 * 规范化代币地址。
 *
 * EVM 地址按不区分大小写处理；Solana mint 使用 base58，大小写是身份的
 * 一部分，必须原样保留。这里不尝试校验地址格式，格式校验属于输入解析层。
 */
export function normalizeAddress(chain: string, address: string): string {
  const value = address.trim();
  if (normalizeChain(chain) !== 'solana' && /^0x/i.test(value)) return value.toLowerCase();
  return value;
}

export function tokenKey(chain: string, address: string): string {
  return `${normalizeChain(chain)}:${normalizeAddress(chain, address)}`;
}

/** 来源、链、地址三段都进入缓存键，避免跨来源或跨链串价。 */
export function quoteCacheKey(source: string, chain: string, address: string): string {
  return `${source.trim().toLowerCase()}:${tokenKey(chain, address)}`;
}

/**
 * 已确认的主网计价币身份。
 *
 * 这里只放能确认的精确链+合约地址。没有把符号本身当成可信证据，
 * 也没有为 Robinhood 添加猜测地址；未登记的地址一律返回 unknown。
 */
export const TRUSTED_QUOTE_IDENTITIES: ReadonlyArray<{
  chain: string;
  address: string;
  symbol: string;
}> = Object.freeze([
  // Ethereum mainnet
  { chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH' },
  { chain: 'ethereum', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT' },
  { chain: 'ethereum', address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
  { chain: 'ethereum', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI' },

  // BNB Smart Chain mainnet
  { chain: 'bsc', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB' },
  { chain: 'bsc', address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT' },
  { chain: 'bsc', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC' },
  { chain: 'bsc', address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', symbol: 'DAI' },

  // Base mainnet
  { chain: 'base', address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  { chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' },
]);

const trustedByKey = new Map(
  TRUSTED_QUOTE_IDENTITIES.map((entry) => [tokenKey(entry.chain, entry.address), entry.symbol]),
);

/**
 * 判断一个计价币身份。
 *
 * - trusted：链、精确地址和预期 symbol 全部匹配；
 * - mismatch：地址已登记，但 symbol 与登记值不符；
 * - unknown：地址尚未登记，或者缺少必要的身份字段。
 */
export function isTrustedQuoteIdentity(
  chain: string,
  address: string | null | undefined,
  expectedSymbol: string | null | undefined,
): QuoteIdentityTrust {
  if (!address?.trim() || !expectedSymbol?.trim()) return 'unknown';
  const registered = trustedByKey.get(tokenKey(chain, address));
  if (!registered) return 'unknown';
  return registered === expectedSymbol.trim().toUpperCase() ? 'trusted' : 'mismatch';
}

export function makeQuoteIdentity(
  chain: string,
  address: string | null | undefined,
  symbol: string | null | undefined,
): QuoteIdentity {
  const normalizedAddress = address?.trim() ? normalizeAddress(chain, address) : null;
  const normalizedSymbol = symbol?.trim() ? symbol.trim().toUpperCase() : null;
  return {
    chain: normalizeChain(chain),
    address: normalizedAddress,
    symbol: normalizedSymbol,
    trust: isTrustedQuoteIdentity(chain, normalizedAddress, normalizedSymbol),
  };
}
