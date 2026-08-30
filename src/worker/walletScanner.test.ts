process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import * as wr from '../db/walletRepo.ts';
import { scanWallet, type ScanDeps } from './walletScanner.ts';

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

test('不支持的链跳过且不报错', async () => {
  const u = wr.createUser(`sol${++seq}`, 'h')!;
  wr.addWallet(u.id, 'solana', 'SoLaNaAddr', null);
  const w = wr.listWallets(u.id)[0]!;
  await scanWallet(w, 500, deps());
  const after = wr.listWallets(u.id)[0]!;
  assert.match(after.lastScanError ?? '', /不支持|solana/i);
});
