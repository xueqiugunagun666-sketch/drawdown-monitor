/**
 * 钱包扫描调度：发现代币 -> 读余额 -> 写 holdings -> 推进扫描水位。
 *
 * 两个容易写错的地方：
 *
 * 1. **发现是增量的，余额是全量的。** 新块里只能发现"新收到的代币"，
 *    但已知代币的余额可能变了（卖出、转出）。每轮都要对该钱包的
 *    全部已知代币重读 balanceOf，不只是新发现的。漏了这条，
 *    卖掉的币会永远留在监控里。
 *
 * 2. **读不到 ≠ 余额为 0。** 读取失败时保留原记录。当作 0 删掉的话，
 *    下一轮又会重新发现它，反复触发冷启动 seed 把状态机重置 ——
 *    结果是它真涨到 2 倍时可能一次都不报。
 */
import { blockNumber as rpcBlockNumber } from '../sources/evmRpc.ts';
import { chainIdOf } from '../sources/evmRpc.ts';
import { scanWalletTokens } from '../sources/walletScan.ts';
import { readBalances as rpcReadBalances, type TokenBalance } from '../sources/balances.ts';
import * as wr from '../db/walletRepo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';

const log = makeLogger('wallet-scanner');

/** 扫描间隔：余额变化远比价格慢，12 分钟一轮足够 */
export const SCAN_INTERVAL_SECONDS = 12 * 60;

export interface ScanDeps {
  blockNumber: (chain: string) => Promise<number>;
  scanTokens: (chain: string, wallet: string, from: number, to: number) => Promise<Set<string>>;
  readBalances: (
    chain: string, wallet: string, tokens: string[], known: Map<string, number | null>,
  ) => Promise<Map<string, TokenBalance>>;
}

export const realDeps: ScanDeps = {
  blockNumber: rpcBlockNumber,
  scanTokens: scanWalletTokens,
  readBalances: rpcReadBalances,
};

export async function scanWallet(
  wallet: wr.WalletRow, now: number, deps: ScanDeps = realDeps,
): Promise<void> {
  const tag = `${wallet.chain}:${wallet.address.slice(0, 10)}…`;

  if (chainIdOf(wallet.chain) === null) {
    // 本期只做四条 EVM 链。不支持的链要写进错误让用户看见，
    // 而不是安静地什么都不做
    wr.updateWalletScanState(
      wallet.id, wallet.lastScannedBlock, now,
      `暂不支持链 ${wallet.chain}（本期只做 ethereum/bsc/base/robinhood）`,
    );
    return;
  }

  try {
    const head = await deps.blockNumber(wallet.chain);
    const from = wallet.lastScannedBlock === null ? 0 : wallet.lastScannedBlock + 1;

    const discovered = from <= head
      ? await deps.scanTokens(wallet.chain, wallet.address, from, head)
      : new Set<string>();

    // 已知代币 + 新发现的，一起重读余额
    const existing = wr.listHoldingsByWallet(wallet.id);
    const knownDecimals = new Map<string, number | null>();
    const all = new Set<string>();
    for (const h of existing) {
      const addr = h.tokenId.split(':')[1] ?? '';
      if (addr) { all.add(addr); knownDecimals.set(addr, h.decimals); }
    }
    for (const a of discovered) all.add(a.toLowerCase());

    const balances = await deps.readBalances(
      wallet.chain, wallet.address, [...all], knownDecimals,
    );

    let written = 0, removed = 0, unreadable = 0;
    for (const addr of all) {
      const tokenId = `${wallet.chain}:${addr.toLowerCase()}`;
      const b = balances.get(addr);
      if (!b) { unreadable++; continue; }              // 读不到就保留原记录

      if (BigInt(b.balance) === 0n) {
        wr.removeHolding(wallet.id, tokenId);
        removed++;
        continue;
      }

      wr.upsertHolding(wallet.id, tokenId, b.balance, b.decimals, now);
      written++;
      if (b.decimals === null) {
        // 猜 18 会让 6 位小数的代币余额被算大 10^12 倍，
        // 然后静静进入监控、报出荒谬的持仓价值
        wr.setHoldingMonitored(wallet.id, tokenId, false, 'decimals 读取失败，无法换算数量', null);
      }
    }

    wr.updateWalletScanState(wallet.id, head, now, null);
    log.info(`${tag} block ${from}-${head}: 发现 ${discovered.size}，写入 ${written}，清零 ${removed}${unreadable ? `，读取失败 ${unreadable}` : ''}`);
  } catch (err) {
    // 失败保持水位原样 —— 推进了那段区间就永远不会重扫。
    // 注意是原样而不是 ?? 0：从未扫过时写 0 等于声称"已扫到第 0 块"
    const msg = safeErrorMessage(err);
    wr.updateWalletScanState(wallet.id, wallet.lastScannedBlock, now, msg);
    log.warn(`${tag} 扫描失败: ${msg}`);
  }
}

export async function scanAllWallets(now: number, deps: ScanDeps = realDeps): Promise<void> {
  for (const w of wr.listAllEnabledWallets()) {
    await scanWallet(w, now, deps);
  }
}
