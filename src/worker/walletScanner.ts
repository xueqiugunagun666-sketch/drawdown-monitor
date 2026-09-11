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
import {
  fetchSolanaWalletSnapshot, SOURCE_ID as SOLANA_RPC_SOURCE_ID,
  type SolanaWalletSnapshot,
} from '../sources/solanaRpc.ts';
import * as wr from '../db/walletRepo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { nowSec } from '../lib/time.ts';
import { recordVerdict } from './sourceWatch.ts';

const log = makeLogger('wallet-scanner');

/** 扫描间隔：余额变化远比价格慢，12 分钟一轮足够 */
export const SCAN_INTERVAL_SECONDS = 12 * 60;
/** 网络瞬断后不必把红字挂满一整轮；两分钟后进入高优先级重试。 */
export const FAILED_SCAN_RETRY_SECONDS = 2 * 60;
/**
 * 生产每个 sweep 最多处理这些去重钱包组，然后让出一分钟并重建优先队列。
 * 否则 100 多个到期钱包可能让一个 sweep 跑几十分钟，早期失败的钱包在
 * processed 集合里永远等不到重试。
 */
export const PRODUCTION_SCAN_SWEEP_GROUP_BUDGET = 12;
export const CANDIDATE_RETRY_MAX_SECONDS = 6 * 3600;

/** 首次失败 12 分钟后重试，随后指数退避，最高每 6 小时一次。 */
export function candidateRetryDelay(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  return Math.min(CANDIDATE_RETRY_MAX_SECONDS, SCAN_INTERVAL_SECONDS * (2 ** exponent));
}

export interface ScanDeps {
  blockNumber: (chain: string) => Promise<number>;
  scanTokens: (chain: string, wallet: string, from: number, to: number) => Promise<Set<string>>;
  readBalances: (
    chain: string, wallet: string, tokens: string[], known: Map<string, number | null>,
  ) => Promise<Map<string, TokenBalance>>;
  solanaSnapshot: (wallet: string) => Promise<SolanaWalletSnapshot>;
}

export const realDeps: ScanDeps = {
  blockNumber: rpcBlockNumber,
  scanTokens: scanWalletTokens,
  readBalances: rpcReadBalances,
  solanaSnapshot: fetchSolanaWalletSnapshot,
};

export function walletScanKey(wallet: wr.WalletRow): string {
  return `${wallet.chain}:${wallet.address}`;
}

/**
 * 每次只领取一个最高优先级的“链 + 地址”组。
 *
 * NULL（从未扫过）永远排最前；同一地址被多个用户添加时合成一组。processed
 * 只在当前 sweep 内生效，避免耗时超过 12 分钟后又从头重复，下一分钟会重置。
 */
export function nextWalletGroup(
  wallets: wr.WalletRow[], now: number, processed: ReadonlySet<string>,
): wr.WalletRow[] | null {
  const groups = new Map<string, wr.WalletRow[]>();
  for (const wallet of wallets) {
    const key = walletScanKey(wallet);
    if (processed.has(key)) continue;
    const group = groups.get(key);
    if (group) group.push(wallet);
    else groups.set(key, [wallet]);
  }

  const ranked = [...groups.entries()].filter(([, group]) =>
    group.some((wallet) => isScanDue(wallet, now))).map(([key, group]) => {
    const neverScanned = group.some((wallet) => wallet.lastScanAt === null);
    const retryingFailure = group.some((wallet) =>
      wallet.lastScanError !== null && isScanDue(wallet, now));
    const oldestScan = neverScanned ? -1 : Math.min(...group.map((wallet) => wallet.lastScanAt!));
    const oldestCreated = Math.min(...group.map((wallet) => wallet.createdAt));
    return { key, group, neverScanned, retryingFailure, oldestScan, oldestCreated };
  }).sort((a, b) => Number(b.neverScanned) - Number(a.neverScanned)
    || Number(b.retryingFailure) - Number(a.retryingFailure)
    || a.oldestScan - b.oldestScan
    || a.oldestCreated - b.oldestCreated
    || a.key.localeCompare(b.key));
  return ranked[0]?.group ?? null;
}

async function scanSolanaWallets(
  wallets: wr.WalletRow[], now: number, deps: ScanDeps, completedAt: () => number,
): Promise<void> {
  const wallet = wallets[0]!;
  const tag = `solana:${wallet.address.slice(0, 8)}…`;
  let snapshot: SolanaWalletSnapshot;
  try {
    snapshot = await deps.solanaSnapshot(wallet.address);
    recordVerdict(
      SOLANA_RPC_SOURCE_ID, { ok: true, reason: null }, completedAt(),
      '完整读取 Token 与 Token-2022',
    );
  } catch (err) {
    const msg = safeErrorMessage(err);
    const finishedAt = completedAt();
    recordVerdict(SOLANA_RPC_SOURCE_ID, { ok: false, reason: msg }, finishedAt, '钱包快照请求失败');
    for (const row of wallets) {
      wr.updateWalletScanState(row.id, row.lastScannedBlock, finishedAt, msg);
    }
    log.warn(`${tag} 扫描失败: ${msg}`);
    return;
  }

  const finishedAt = completedAt();
  const balances = [...snapshot.balances.values()].map((balance) => ({
    tokenId: `solana:${balance.mint}`,
    balance: balance.balance,
    decimals: balance.decimals,
  }));
  for (const row of wallets) {
    try {
      const applied = wr.applyWalletHoldingSnapshot(
        row.id, 'solana', balances, snapshot.slot, finishedAt,
      );
      log.info(`${tag} slot ${snapshot.slot}: 写入 ${applied.written}，清零 ${applied.removed}`);
    } catch (err) {
      // RPC 是好的、数据库写入失败；不要把本地故障记到数据源头上。
      const msg = safeErrorMessage(err);
      wr.updateWalletScanState(row.id, row.lastScannedBlock, finishedAt, msg);
      log.warn(`${tag} 快照入库失败: ${msg}`);
    }
  }
}

/** 同一链、同一地址只做一次链上发现和余额读取，再写入每个用户的钱包行。 */
export async function scanWalletGroup(
  wallets: wr.WalletRow[], now: number, deps: ScanDeps = realDeps,
  completedAt: () => number = () => now,
): Promise<void> {
  if (wallets.length === 0) return;
  const wallet = wallets[0]!;
  const key = walletScanKey(wallet);
  if (wallets.some((row) => walletScanKey(row) !== key)) {
    throw new Error('scanWalletGroup 只能处理相同链与地址');
  }
  const tag = `${wallet.chain}:${wallet.address.slice(0, 10)}…`;

  if (wallet.chain === 'solana') {
    await scanSolanaWallets(wallets, now, deps, completedAt);
    return;
  }

  if (chainIdOf(wallet.chain) === null) {
    // 不支持的链要写进错误让用户看见，
    // 而不是安静地什么都不做
    const finishedAt = completedAt();
    for (const row of wallets) {
      wr.updateWalletScanState(
        row.id, row.lastScannedBlock, finishedAt,
        `暂不支持链 ${row.chain}（支持 ethereum/bsc/base/robinhood/solana）`,
      );
    }
    return;
  }

  try {
    const head = await deps.blockNumber(wallet.chain);
    const from = Math.min(...wallets.map(
      (row) => row.lastScannedBlock === null ? 0 : row.lastScannedBlock + 1));

    const discovered = from <= head
      ? await deps.scanTokens(wallet.chain, wallet.address, from, head)
      : new Set<string>();

    const discoveredIds = [...discovered]
      .map((address) => `${wallet.chain}:${address.toLowerCase()}`);
    // 这是 A15 的关键顺序：先持久化“见过这个 CA”，再做可能部分失败的 RPC。
    for (const row of wallets) wr.rememberWalletTokenCandidates(row.id, discoveredIds, now);

    // 先取每个用户自己的持仓/候选，再合成一次共享 balanceOf 请求。
    const work = wallets.map((row) => {
      const candidates = wr.dueWalletTokenCandidates(row.id, now);
      const existing = wr.listHoldingsByWallet(row.id);
      return {
        wallet: row, candidates, existing,
        candidateByToken: new Map(candidates.map((candidate) => [candidate.tokenId, candidate])),
      };
    });
    const knownDecimals = new Map<string, number | null>();
    const sharedTokens = new Set<string>();
    for (const item of work) {
      for (const holding of item.existing) {
        const address = holding.tokenId.split(':')[1] ?? '';
        if (!address) continue;
        sharedTokens.add(address);
        if (!knownDecimals.has(address) || knownDecimals.get(address) === null) {
          knownDecimals.set(address, holding.decimals);
        }
      }
      for (const candidate of item.candidates) {
        const address = candidate.tokenId.split(':')[1] ?? '';
        if (address) sharedTokens.add(address);
      }
    }

    const balances = await deps.readBalances(
      wallet.chain, wallet.address, [...sharedTokens], knownDecimals,
    );

    const finishedAt = completedAt();
    for (const item of work) {
      const ownTokens = new Set<string>();
      for (const holding of item.existing) {
        const address = holding.tokenId.split(':')[1] ?? '';
        if (address) ownTokens.add(address);
      }
      for (const candidate of item.candidates) {
        const address = candidate.tokenId.split(':')[1] ?? '';
        if (address) ownTokens.add(address);
      }

      let written = 0, removed = 0, unreadable = 0;
      for (const addr of ownTokens) {
        const tokenId = `${wallet.chain}:${addr.toLowerCase()}`;
        const balance = balances.get(addr);
        if (!balance) {
          unreadable++;
          const candidate = item.candidateByToken.get(tokenId);
          if (candidate) {
            const nextAttempt = candidate.attemptCount + 1;
            wr.markWalletTokenCandidateFailed(
              item.wallet.id, tokenId, now, now + candidateRetryDelay(nextAttempt),
              'balanceOf 或 decimals 读取失败',
            );
          }
          continue;                                      // 读不到就保留原记录/候选
        }

        if (BigInt(balance.balance) === 0n) {
          wr.removeHolding(item.wallet.id, tokenId);
          wr.removeWalletTokenCandidate(item.wallet.id, tokenId);
          removed++;
          continue;
        }

        wr.upsertHolding(
          item.wallet.id, tokenId, balance.balance, balance.decimals, finishedAt,
          item.candidateByToken.get(tokenId)?.discoveredAt ?? finishedAt,
        );
        wr.removeWalletTokenCandidate(item.wallet.id, tokenId);
        written++;
        if (balance.decimals === null) {
          // 猜 18 会让 6 位小数的代币余额被算大 10^12 倍，
          // 然后静静进入监控、报出荒谬的持仓价值
          wr.setHoldingMonitored(
            item.wallet.id, tokenId, false, 'decimals 读取失败，无法换算数量', null);
        }
      }

      const partialError = unreadable > 0
        ? `${unreadable} 个代币余额读取失败，已进入候选重试队列`
        : null;
      wr.updateWalletScanState(item.wallet.id, head, finishedAt, partialError);
      log.info(`${tag} block ${from}-${head}: 发现 ${discovered.size}，写入 ${written}，清零 ${removed}${unreadable ? `，读取失败 ${unreadable}` : ''}${wallets.length > 1 ? `，共享扫描 ${wallets.length} 行` : ''}`);
    }
  } catch (err) {
    // 失败保持水位原样 —— 推进了那段区间就永远不会重扫。
    // 注意是原样而不是 ?? 0：从未扫过时写 0 等于声称"已扫到第 0 块"
    const msg = safeErrorMessage(err);
    const finishedAt = completedAt();
    for (const row of wallets) {
      wr.updateWalletScanState(row.id, row.lastScannedBlock, finishedAt, msg);
    }
    log.warn(`${tag} 扫描失败: ${msg}`);
  }
}

export async function scanWallet(
  wallet: wr.WalletRow, now: number, deps: ScanDeps = realDeps,
): Promise<void> {
  await scanWalletGroup([wallet], now, deps, () => now);
}

/**
 * 这个钱包该扫了吗？
 *
 * 按钱包各自的上次扫描时间判断，而不是让整个循环同步推进 ——
 * 否则刚加的钱包最长要等满一轮（12 分钟）才动，这期间页面上什么都没有，
 * 用户不知道是不是坏了。从未扫过的立刻扫。
 */
export function isScanDue(w: wr.WalletRow, now: number): boolean {
  if (w.lastScanAt === null) return true;
  const interval = w.lastScanError === null ? SCAN_INTERVAL_SECONDS : FAILED_SCAN_RETRY_SECONDS;
  return now - w.lastScanAt >= interval;
}

export async function scanAllWallets(
  now: number, deps: ScanDeps = realDeps, maxGroups = Number.POSITIVE_INFINITY,
): Promise<number> {
  const processed = new Set<string>();
  let scanNow = now;
  const limit = Math.max(0, Math.floor(maxGroups));
  while (processed.size < limit) {
    // 每处理完一组重新读库：循环中途新加的钱包也能立即以最高优先级被领取。
    const group = nextWalletGroup(wr.listAllEnabledWallets(), scanNow, processed);
    if (!group) return processed.size;
    processed.add(walletScanKey(group[0]!));
    await scanWalletGroup(group, scanNow, deps, nowSec);
    scanNow = nowSec();
  }
  return processed.size;
}
