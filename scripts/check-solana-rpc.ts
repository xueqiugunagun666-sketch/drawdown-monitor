/**
 * Solana RPC 只读自检。
 *   npm run check:solana-rpc
 *   npm run check:solana-rpc -- <Solana 钱包地址>
 *
 * 同时验证经典 SPL Token 与 Token-2022 的批量响应；只输出 slot、
 * 非零 mint 数量和耗时，不打印 RPC URL、账户余额或完整持仓列表。
 */
import { safeErrorMessage } from '../src/lib/mask.ts';
import { isSolanaWalletAddress } from '../src/lib/walletAddress.ts';
import { fetchSolanaWalletSnapshot } from '../src/sources/solanaRpc.ts';

const PUBLIC_EXAMPLE_WALLET = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
const wallet = process.argv[2] ?? PUBLIC_EXAMPLE_WALLET;

if (!isSolanaWalletAddress(wallet)) {
  console.error('失败: Solana 钱包地址无效');
  process.exitCode = 1;
} else {
  const startedAt = Date.now();
  try {
    const snapshot = await fetchSolanaWalletSnapshot(wallet);
    console.log(`Solana RPC 正常  slot=${snapshot.slot}  非零代币=${snapshot.balances.size}  ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.error(`Solana RPC 失败: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
