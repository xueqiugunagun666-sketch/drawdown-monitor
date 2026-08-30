/**
 * EVM RPC 连通性与持仓发现的自检。
 *   npm run check:rpc              只查块高
 *   npm run check:rpc -- 0x地址     顺带扫该地址的持仓代币
 *
 * 输出里**不应出现完整的 RPC URL** —— 出现了说明 config.ts 的
 * registerSecret 没生效。
 */
import { supportedChains, blockNumber } from '../src/sources/evmRpc.ts';
import { scanWalletTokens } from '../src/sources/walletScan.ts';
import { safeErrorMessage } from '../src/lib/mask.ts';

const addr = process.argv[2];

for (const chain of supportedChains()) {
  try {
    const head = await blockNumber(chain);
    if (!addr) {
      console.log(`${chain.padEnd(10)} 块高 ${head}`);
      continue;
    }
    const t0 = Date.now();
    const tokens = await scanWalletTokens(chain, addr, 0, head);
    console.log(`${chain.padEnd(10)} 块高 ${head}  代币 ${tokens.size} 个  ${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`${chain.padEnd(10)} 失败: ${safeErrorMessage(err)}`);
  }
}
