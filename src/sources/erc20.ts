/**
 * ERC20 只读调用的手写编解码 —— 项目里没有 viem/ethers，也不为这点事引入。
 *
 * 只涉及静态类型（address / uint256 / uint8），ABI 编码就是
 * "4 字节选择器 + 每个参数左补零到 32 字节"，没有动态类型的偏移量问题。
 * 实测已在 BSC 上验证：WBNB 与 CAKE 的 balanceOf、WBNB 的 decimals 均正确。
 *
 * 为什么不用 Multicall3：它要对 (address,bool,bytes)[] 这种嵌套动态类型
 * 做 ABI 编码，手写容易错，引编码库又是新依赖；而 JSON-RPC 批量请求
 * 拿到了同样的"一次往返读很多个"的收益，还不依赖任何合约在链上部署
 * （Robinhood 这种新链未必有 Multicall3）。
 */
import { Decimal } from '../lib/decimal.ts';

export const SELECTOR_BALANCE_OF = '0x70a08231';   // balanceOf(address)
export const SELECTOR_DECIMALS = '0x313ce567';     // decimals()
export const SELECTOR_SYMBOL = '0x95d89b41';       // symbol()

/** 地址左补零到 32 字节（64 个 hex 字符，不含 0x），用作 calldata 参数或 topic 过滤 */
export function padAddress(addr: string): string {
  return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

export function encodeBalanceOf(owner: string): string {
  return SELECTOR_BALANCE_OF + padAddress(owner);
}

/**
 * 32 字节 hex → 十进制字符串。走 BigInt，绝不经过 Number ——
 * 18 位小数的代币余额轻易超过 2^53，过一次 Number 就永久失真。
 */
export function decodeUint256(hex: string): string {
  if (!hex || hex === '0x') return '0';
  try {
    return BigInt(hex).toString();
  } catch {
    return '0';
  }
}

/**
 * decimals 读不到时返回 null，**不猜默认值**。
 * 猜 18 会让一个 6 位小数的代币余额被算大 10^12 倍，然后静静地
 * 进入监控，最后报出一个荒谬的持仓价值 —— 调用方必须显式处理"不知道"。
 */
export function decodeUint8(hex: string): number | null {
  if (!hex || hex === '0x') return null;
  try {
    const v = BigInt(hex);
    return v >= 0n && v <= 255n ? Number(v) : null;
  } catch {
    return null;
  }
}

/** 原始整数余额 + decimals → 人类数量。decimals 未知时返回 null。 */
export function toHumanAmount(raw: string, decimals: number | null): Decimal | null {
  if (decimals === null) return null;
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}
