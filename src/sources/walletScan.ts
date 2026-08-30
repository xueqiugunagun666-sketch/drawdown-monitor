/**
 * 从链上发现"这个地址收过哪些代币"。
 *
 * 原理：ERC20 的 Transfer 事件第三个 topic 是收款方。按它过滤，
 * 结果集就只剩这个地址相关的转账，很小 —— 实测 Robinhood 链上
 * fromBlock=0 到 latest 一次查完，4990 万块 / 1076 条日志 / 30 个代币 / 4.5 秒。
 *
 * 为什么这样够：你不可能持有一个从未收到过的代币，"收过"是"持有"的超集。
 * 卖掉的那些由后续的 balanceOf 筛掉。
 *
 * 为什么不固定按 N 个块分片：节点的限制是**响应体积**不是块跨度
 * （同一个端点上，不带地址过滤时几千块就超限，带过滤时四千万块也没事）。
 * 固定分片会在冷清的链上白跑几千次请求。做法是先按全范围试，
 * 被拒绝了再对半拆，只在真正密集的地方细分。
 */
import { rpc } from './evmRpc.ts';
import { padAddress } from './erc20.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('wallet-scan');

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * 各家节点拒绝大结果集时的措辞都不一样，这里的模式是实测采集的。
 * 漏掉一种就会让二分不触发，直接把错误抛给调用方，表现为"扫描总是失败"；
 * 反过来放得太宽，会让鉴权失败之类的错误被当成容量问题反复二分重试。
 */
const TOO_BIG = /exceed|limited to|too many|timed\s*out|timedout|response size|block range/i;

export function isRangeTooBig(message: string): boolean {
  return TOO_BIG.test(message);
}

export interface LogEntry { address: string }
export type GetLogs = (from: number, to: number) => Promise<LogEntry[]>;

/**
 * 自适应二分。返回去重后的代币合约地址（全小写）。
 *
 * 终止条件是 from >= to：此时不能再拆，仍失败就抛错。
 * 没有这个条件就是无限递归，会把 RPC 端点打死。
 */
export async function discoverTokenAddresses(
  getLogs: GetLogs, from: number, to: number, out = new Set<string>(),
): Promise<Set<string>> {
  try {
    const logs = await getLogs(from, to);
    for (const l of logs) out.add(l.address.toLowerCase());
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isRangeTooBig(msg)) throw err;
    if (from >= to) {
      throw new Error(`区间不可再分仍被节点拒绝 (block ${from}..${to}): ${msg}`);
    }
    const mid = Math.floor((from + to) / 2);
    await discoverTokenAddresses(getLogs, from, mid, out);
    await discoverTokenAddresses(getLogs, mid + 1, to, out);
    return out;
  }
}

/** 绑定到真实 RPC 的版本 */
export async function scanWalletTokens(
  chain: string, wallet: string, fromBlock: number, toBlock: number,
): Promise<Set<string>> {
  const topic = '0x' + padAddress(wallet);
  const getLogs: GetLogs = async (from, to) => {
    const raw = await rpc<LogEntry[] | null>(chain, 'eth_getLogs', [{
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [TRANSFER_TOPIC, null, topic],
    }]);
    return Array.isArray(raw) ? raw : [];
  };
  const found = await discoverTokenAddresses(getLogs, fromBlock, toBlock);
  log.info(`${chain} ${wallet.slice(0, 10)}… block ${fromBlock}-${toBlock}: 发现 ${found.size} 个代币`);
  return found;
}
