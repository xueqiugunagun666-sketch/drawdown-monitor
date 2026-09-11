process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import * as wr from '../db/walletRepo.ts';
import {
  scanWallet, scanWalletGroup, nextWalletGroup, walletScanKey, isScanDue,
  candidateRetryDelay, SCAN_INTERVAL_SECONDS, FAILED_SCAN_RETRY_SECONDS,
  CANDIDATE_RETRY_MAX_SECONDS, scanAllWallets, type ScanDeps,
} from './walletScanner.ts';

before(() => { runMigrations(); });

let seq = 0;
function setup() {
  const u = wr.createUser(`u${++seq}`, 'h');
  assert.ok(u);
  const w = wr.addWallet(u.id, 'bsc', `0xwallet${seq}`, null);
  assert.ok(w);
  return { user: u, walletId: w.id, wallet: wr.listWallets(u.id)[0]! };
}

const deps = (over: Partial<ScanDeps> = {}): ScanDeps => ({
  blockNumber: async () => 1000,
  scanTokens: async () => new Set(['0xt1']),
  readBalances: async (_c, _w, tokens) =>
    new Map(tokens.map((t) => [t, { balance: '100', decimals: 18 }])),
  solanaSnapshot: async () => ({ slot: 2000, balances: new Map() }),
  ...over,
});

test('首次扫描从 0 开始，之后从上次水位继续', async () => {
  const { walletId, wallet } = setup();
  const seen: Array<[number, number]> = [];
  await scanWallet(wallet, 500, deps({
    scanTokens: async (_c, _w, from, to) => { seen.push([from, to]); return new Set(['0xt1']); },
  }));
  assert.deepEqual(seen[0], [0, 1000], '首次应扫全量');

  const after = wr.listWallets(wallet.userId).find((x) => x.id === walletId)!;
  assert.equal(after.lastScannedBlock, 1000);

  seen.length = 0;
  await scanWallet(after, 600, deps({
    blockNumber: async () => 2000,
    scanTokens: async (_c, _w, from, to) => { seen.push([from, to]); return new Set(); },
  }));
  assert.deepEqual(seen[0], [1001, 2000], '第二次只扫新块');
});

test('已知代币即使不在新块里也会重读余额', async () => {
  // 发现是增量的，但余额是全量的 —— 漏了这条，卖掉的币会永远留在监控里
  const { walletId, wallet } = setup();
  wr.upsertHolding(walletId, 'bsc:0xold', '999', 18, 100);

  let asked: string[] = [];
  await scanWallet(wallet, 500, deps({
    scanTokens: async () => new Set(['0xnew']),      // 新块里只发现了 0xnew
    readBalances: async (_c, _w, tokens) => {
      asked = [...tokens];
      return new Map(tokens.map((t) => [t, { balance: '5', decimals: 18 }]));
    },
  }));
  assert.ok(asked.includes('0xold'), `已知代币必须重读，实际只问了 ${asked.join(',')}`);
  assert.ok(asked.includes('0xnew'));
});

test('余额归零的代币从 holdings 移除', async () => {
  const { walletId, wallet } = setup();
  wr.upsertHolding(walletId, 'bsc:0xsold', '999', 18, 100);
  await scanWallet(wallet, 500, deps({
    scanTokens: async () => new Set(),
    readBalances: async (_c, _w, tokens) =>
      new Map(tokens.map((t) => [t, { balance: '0', decimals: 18 }])),
  }));
  assert.equal(wr.listHoldingsByWallet(walletId).length, 0, '零余额应被删除');
});

test('扫描失败时不推进 last_scanned_block，且错误被记录', async () => {
  const { walletId, wallet } = setup();
  await scanWallet(wallet, 500, deps({ scanTokens: async () => { throw new Error('节点超时'); } }));
  const after = wr.listWallets(wallet.userId).find((x) => x.id === walletId)!;
  assert.equal(after.lastScannedBlock, null, '失败不能推进水位，否则那段区间永远不会重扫');
  assert.match(after.lastScanError ?? '', /节点超时/);
});

test('扫描成功后清掉上一次的错误', async () => {
  const { walletId, wallet } = setup();
  await scanWallet(wallet, 500, deps({ scanTokens: async () => { throw new Error('炸了'); } }));
  const failed = wr.listWallets(wallet.userId).find((x) => x.id === walletId)!;
  assert.ok(failed.lastScanError);
  await scanWallet(failed, 600, deps());
  const ok = wr.listWallets(wallet.userId).find((x) => x.id === walletId)!;
  assert.equal(ok.lastScanError, null);
});

test('decimals 读不到的代币写入但不进监控，且写明原因', async () => {
  // 猜 18 会让 6 位小数的代币余额被算大 10^12 倍
  const { walletId, wallet } = setup();
  await scanWallet(wallet, 500, deps({
    scanTokens: async () => new Set(['0xnodec']),
    readBalances: async (_c, _w, tokens) =>
      new Map(tokens.map((t) => [t, { balance: '100', decimals: null }])),
  }));
  const h = wr.listHoldingsByWallet(walletId).find((x) => x.tokenId === 'bsc:0xnodec');
  assert.ok(h, '仍应记录持仓');
  assert.equal(h!.monitored, 0);
  assert.match(h!.filterReason ?? '', /decimals/);
});

test('token_id 用 chain:address 格式，与 tokens 表一致', async () => {
  const { walletId, wallet } = setup();
  await scanWallet(wallet, 500, deps({ scanTokens: async () => new Set(['0xABC']) }));
  const ids = wr.listHoldingsByWallet(walletId).map((h) => h.tokenId);
  assert.ok(ids.includes('bsc:0xabc'), `地址应归一为小写，实际 ${ids.join(',')}`);
});

test('余额读取失败的代币保留原记录，不当作已卖出', async () => {
  // 读不到 ≠ 余额为 0。当作 0 删掉，下一轮又重新发现，
  // 会反复触发冷启动 seed 把状态机重置
  const { walletId, wallet } = setup();
  wr.upsertHolding(walletId, 'bsc:0xkeep', '777', 18, 100);
  await scanWallet(wallet, 500, deps({
    scanTokens: async () => new Set(),
    readBalances: async () => new Map(),        // 一个都没读到
  }));
  const h = wr.listHoldingsByWallet(walletId).find((x) => x.tokenId === 'bsc:0xkeep');
  assert.ok(h, '读取失败不该删除持仓');
  assert.equal(h!.balance, '777', '余额应保持原值');
});

test('新币首次余额读取失败后，即使没有新转账也会从候选队列重试成功', async () => {
  const { walletId, wallet } = setup();
  await scanWallet(wallet, 500, deps({
    scanTokens: async () => new Set(['0xretry']),
    readBalances: async () => new Map(),
  }));

  const failed = wr.listWallets(wallet.userId).find((x) => x.id === walletId)!;
  assert.equal(failed.lastScannedBlock, 1000, '候选已持久化后发现水位可以安全推进');
  assert.match(failed.lastScanError ?? '', /候选重试队列/);
  assert.equal(wr.listHoldingsByWallet(walletId).length, 0);

  let asked: string[] = [];
  await scanWallet(failed, 500 + SCAN_INTERVAL_SECONDS, deps({
    scanTokens: async () => new Set(),                // 再也没有新转账
    readBalances: async (_c, _w, tokens) => {
      asked = [...tokens];
      return new Map(tokens.map((t) => [t, { balance: '77', decimals: 18 }]));
    },
  }));
  assert.deepEqual(asked, ['0xretry']);
  assert.equal(wr.listHoldingsByWallet(walletId)[0]?.tokenId, 'bsc:0xretry');
  assert.equal(wr.listHoldingsByWallet(walletId)[0]?.firstSeenAt, 500,
    '重试成功时间不能覆盖最初发现时间，唤醒逻辑依赖这个字段');
  assert.equal(wr.dueWalletTokenCandidates(walletId, 999999).length, 0,
    '成功处理后候选应移除，不再无限重试');
});

test('失败候选按指数退避且最高不超过 6 小时', () => {
  assert.equal(candidateRetryDelay(1), SCAN_INTERVAL_SECONDS);
  assert.equal(candidateRetryDelay(2), SCAN_INTERVAL_SECONDS * 2);
  assert.equal(candidateRetryDelay(99), CANDIDATE_RETRY_MAX_SECONDS);
});

test('不支持的链跳过且明确写出错误', async () => {
  const u = wr.createUser(`unknown${++seq}`, 'h')!;
  wr.addWallet(u.id, 'arbitrum', '0xunknown', null);
  const w = wr.listWallets(u.id)[0]!;
  await scanWallet(w, 500, deps());
  const after = wr.listWallets(u.id)[0]!;
  assert.match(after.lastScanError ?? '', /不支持|arbitrum/i);
});

test('Solana 完整快照写入持仓并保留 mint 大小写', async () => {
  const u = wr.createUser(`sol${++seq}`, 'h')!;
  const address = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
  const added = wr.addWallet(u.id, 'solana', address, null)!;
  const wallet = wr.listWallets(u.id)[0]!;
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  await scanWallet(wallet, 500, deps({
    solanaSnapshot: async () => ({
      slot: 987654,
      balances: new Map([[mint, { mint, balance: '9007199254740993123', decimals: 5 }]]),
    }),
  }));

  const holding = wr.listHoldingsByWallet(added.id)[0]!;
  assert.equal(holding.tokenId, `solana:${mint}`);
  assert.equal(holding.balance, '9007199254740993123');
  assert.equal(holding.decimals, 5);
  assert.equal(wr.listWallets(u.id)[0]?.lastScannedBlock, 987654);
  assert.equal(wr.listWallets(u.id)[0]?.lastScanError, null);
});

test('Solana 快照失败保留旧持仓与旧 slot，并在钱包行显示错误', async () => {
  const u = wr.createUser(`solfail${++seq}`, 'h')!;
  const added = wr.addWallet(u.id, 'solana', 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd', null)!;
  const mint = 'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  wr.upsertHolding(added.id, mint, '77', 5, 100);
  wr.updateWalletScanState(added.id, 123, 100, null);
  const wallet = wr.listWallets(u.id)[0]!;

  await scanWallet(wallet, 500, deps({
    solanaSnapshot: async () => { throw new Error('XXYY RPC timeout'); },
  }));

  assert.equal(wr.listHoldingsByWallet(added.id)[0]?.balance, '77');
  const after = wr.listWallets(u.id)[0]!;
  assert.equal(after.lastScannedBlock, 123);
  assert.match(after.lastScanError ?? '', /timeout/);
});

test('Solana 新的完整快照会删除已归零的旧持仓', async () => {
  const u = wr.createUser(`solzero${++seq}`, 'h')!;
  const added = wr.addWallet(u.id, 'solana', 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd', null)!;
  wr.upsertHolding(added.id, 'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', '77', 5, 100);
  await scanWallet(wr.listWallets(u.id)[0]!, 500, deps({
    solanaSnapshot: async () => ({ slot: 124, balances: new Map() }),
  }));
  assert.equal(wr.listHoldingsByWallet(added.id).length, 0);
});

test('新加的钱包（从未扫过）会被立刻选中，不用等满一轮', async () => {
  // 循环 12 分钟一轮，若不区分新旧，刚加的钱包最长要等 12 分钟才动，
  // 这期间页面上什么都没有，用户不知道是不是坏了
  const u = wr.createUser(`due${++seq}`, 'h')!;
  wr.addWallet(u.id, 'bsc', `0xdue${seq}`, null);
  const w = wr.listWallets(u.id)[0]!;
  assert.equal(w.lastScanAt, null);
  assert.equal(isScanDue(w, 1000), true, '从未扫过的必须立刻扫');
});

test('刚扫过的钱包不会被重复扫', async () => {
  const u = wr.createUser(`due2${++seq}`, 'h')!;
  const added = wr.addWallet(u.id, 'bsc', `0xdue2${seq}`, null)!;
  wr.updateWalletScanState(added.id, 100, 1000, null);
  const w = wr.listWallets(u.id)[0]!;
  assert.equal(isScanDue(w, 1000 + 60), false, '刚扫过的不该再扫');
  assert.equal(isScanDue(w, 1000 + SCAN_INTERVAL_SECONDS), true, '满一轮才该再扫');
});

test('上次扫描失败的钱包两分钟后重试，不等完整 12 分钟', async () => {
  const u = wr.createUser(`due3${++seq}`, 'h')!;
  const added = wr.addWallet(u.id, 'bsc', `0xdue3${seq}`, null)!;
  wr.updateWalletScanState(added.id, null, 1000, '节点超时');
  const w = wr.listWallets(u.id)[0]!;
  assert.equal(isScanDue(w, 1000 + 60), false);
  assert.equal(isScanDue(w, 1000 + FAILED_SCAN_RETRY_SECONDS), true);
});

test('从未扫描的钱包组优先于大量到期旧钱包', () => {
  const oldUser = wr.createUser(`priority-old${++seq}`, 'h')!;
  const oldId = wr.addWallet(oldUser.id, 'bsc', `0xpriorityold${seq}`, null)!.id;
  wr.updateWalletScanState(oldId, 100, 100, null);
  const old = wr.listWallets(oldUser.id)[0]!;

  const freshUser = wr.createUser(`priority-new${++seq}`, 'h')!;
  wr.addWallet(freshUser.id, 'solana', 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd', null);
  const fresh = wr.listWallets(freshUser.id)[0]!;

  const selected = nextWalletGroup([old, fresh], 1000, new Set());
  assert.equal(selected?.[0]?.id, fresh.id, '新钱包不能排在旧钱包整轮之后');
});

test('已到重试时间的失败钱包优先于普通到期钱包', () => {
  const oldUser = wr.createUser(`priority-normal${++seq}`, 'h')!;
  const oldId = wr.addWallet(oldUser.id, 'bsc', `0xprioritynormal${seq}`, null)!.id;
  wr.updateWalletScanState(oldId, 100, 100, null);
  const old = wr.listWallets(oldUser.id)[0]!;

  const failedUser = wr.createUser(`priority-failed${++seq}`, 'h')!;
  const failedId = wr.addWallet(failedUser.id, 'base', `0xpriorityfailed${seq}`, null)!.id;
  wr.updateWalletScanState(failedId, 100, 800, 'fetch failed');
  const failed = wr.listWallets(failedUser.id)[0]!;

  const selected = nextWalletGroup(
    [old, failed], 800 + FAILED_SCAN_RETRY_SECONDS, new Set(),
  );
  assert.equal(selected?.[0]?.id, failed.id);
});

test('同链同地址只请求一次并把结果写给多个用户', async () => {
  const address = `0xshared${++seq}`;
  const u1 = wr.createUser(`shared-a${seq}`, 'h')!;
  const u2 = wr.createUser(`shared-b${seq}`, 'h')!;
  const id1 = wr.addWallet(u1.id, 'bsc', address, null)!.id;
  const id2 = wr.addWallet(u2.id, 'bsc', address, null)!.id;
  wr.updateWalletScanState(id1, 900, 950, null); // 尚未到期，但可复用另一行的扫描结果
  const w1 = wr.listWallets(u1.id)[0]!;
  const w2 = wr.listWallets(u2.id)[0]!;

  const group = nextWalletGroup([w1, w2], 1000, new Set());
  assert.equal(group?.length, 2, '一行到期时应带上相同地址的其它用户一起复用结果');

  let heads = 0, discoveries = 0, reads = 0;
  let seenFrom = -1;
  await scanWalletGroup(group!, 1000, deps({
    blockNumber: async () => { heads++; return 1100; },
    scanTokens: async (_chain, _wallet, from) => {
      discoveries++;
      seenFrom = from;
      return new Set(['0xsharedtoken']);
    },
    readBalances: async (_chain, _wallet, tokens) => {
      reads++;
      return new Map(tokens.map((token) => [token, { balance: '42', decimals: 6 }]));
    },
  }), () => 1234);

  assert.deepEqual([heads, discoveries, reads], [1, 1, 1]);
  assert.equal(seenFrom, 0, '任一重复钱包从未扫描时，共享扫描必须覆盖完整历史');
  assert.equal(wr.listHoldingsByWallet(id1)[0]?.balance, '42');
  assert.equal(wr.listHoldingsByWallet(id2)[0]?.balance, '42');
  assert.equal(wr.listWallets(u1.id)[0]?.lastScanAt, 1234, '记录实际完成时刻');
  assert.equal(wr.listWallets(u2.id)[0]?.lastScanAt, 1234);
});

test('动态领取时能看见本轮中途新加的钱包', () => {
  const oldUser = wr.createUser(`dynamic-old${++seq}`, 'h')!;
  wr.addWallet(oldUser.id, 'bsc', `0xdynamicold${seq}`, null);
  const old = wr.listWallets(oldUser.id)[0]!;
  const processed = new Set([walletScanKey(old)]);

  const freshUser = wr.createUser(`dynamic-new${++seq}`, 'h')!;
  wr.addWallet(freshUser.id, 'bsc', `0xdynamicnew${seq}`, null);
  const fresh = wr.listWallets(freshUser.id)[0]!;
  const selected = nextWalletGroup([old, fresh], 1000, processed);
  assert.equal(selected?.[0]?.id, fresh.id);
});

test('扫描 sweep 遵守钱包组预算，避免 processed 集合几十分钟不重建', async () => {
  const u = wr.createUser(`bounded${++seq}`, 'h')!;
  wr.addWallet(u.id, 'bsc', `0xbounded-a${seq}`, null);
  wr.addWallet(u.id, 'base', `0xbounded-b${seq}`, null);
  let groups = 0;
  const limitedDeps = deps({
    blockNumber: async () => { groups++; return 1000; },
    scanTokens: async () => new Set(),
    readBalances: async () => new Map(),
    solanaSnapshot: async () => {
      groups++;
      return { slot: 2000, balances: new Map() };
    },
  });
  const processed = await scanAllWallets(999999, limitedDeps, 1);
  assert.equal(processed, 1);
  assert.equal(groups, 1);
});
