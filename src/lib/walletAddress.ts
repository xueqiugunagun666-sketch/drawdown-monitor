/** 钱包地址识别。EVM 地址大小写不敏感；Solana base58 地址大小写敏感。 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export type WalletAddressKind = 'evm' | 'solana';

export function isEvmWalletAddress(address: string): boolean {
  return EVM_ADDRESS.test(address.trim());
}

/**
 * Solana 公钥必须是 base58 编码后的 32 字节。只查正则会把不少长度合适、
 * 实际解码后不是 32 字节的字符串放进扫描队列，最后被误判成 RPC 故障。
 */
export function isSolanaWalletAddress(address: string): boolean {
  const value = address.trim();
  if (!SOLANA_BASE58.test(value)) return false;

  const bytes: number[] = [0];
  for (const ch of value) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return false;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      const n = bytes[i]! * 58 + carry;
      bytes[i] = n & 0xff;
      carry = n >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes++;
  return bytes.length + leadingZeroes === 32;
}

export function walletAddressKind(address: string): WalletAddressKind | null {
  if (isEvmWalletAddress(address)) return 'evm';
  if (isSolanaWalletAddress(address)) return 'solana';
  return null;
}

export function normalizeWalletAddress(address: string): string {
  const trimmed = address.trim();
  // 仓储层也会被迁移脚本和测试夹具直接调用；凡是 0x 地址都按 EVM
  // 规则归一。API 层仍负责严格校验完整 40 位格式。
  return /^0x/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}
