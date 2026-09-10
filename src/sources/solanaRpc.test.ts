import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSolanaTokenAccounts } from './solanaRpc.ts';

const WALLET = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'So11111111111111111111111111111111111111112';

const account = (mint: string, amount: string, decimals: number, owner = WALLET) => ({
  account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount, decimals } } } } },
});
const response = (classic: unknown[], token2022: unknown[], slot = 123) => JSON.stringify([
  { jsonrpc: '2.0', id: 2, result: { context: { slot: slot + 1 }, value: token2022 } },
  { jsonrpc: '2.0', id: 1, result: { context: { slot }, value: classic } },
]);

test('同时解析经典 Token 与 Token-2022，按 id 而非返回顺序归位', () => {
  const got = parseSolanaTokenAccounts(
    response([account(MINT_A, '10', 5)], [account(MINT_B, '20', 9)]), WALLET,
  );
  assert.equal(got.slot, 123);
  assert.equal(got.balances.get(MINT_A)?.balance, '10');
  assert.equal(got.balances.get(MINT_B)?.decimals, 9);
});

test('同一 mint 的多个 token account 会用 BigInt 精确合并，零余额不入快照', () => {
  const huge = '900719925474099312345';
  const got = parseSolanaTokenAccounts(response(
    [account(MINT_A, huge, 6), account(MINT_A, '5', 6)],
    [account(MINT_B, '0', 9)],
  ), WALLET);
  assert.equal(got.balances.get(MINT_A)?.balance, '900719925474099312350');
  assert.equal(got.balances.has(MINT_B), false);
});

test('任一程序响应缺失或账户格式错误都整次失败，禁止把部分结果当全量', () => {
  assert.throws(() => parseSolanaTokenAccounts(JSON.stringify([
    { id: 1, result: { context: { slot: 1 }, value: [] } },
  ]), WALLET), /id=2/);
  assert.throws(() => parseSolanaTokenAccounts(response([
    account(MINT_A, '1', 6, MINT_B),
  ], []), WALLET), /owner/);
});

test('同一 mint 的 decimals 冲突时失败，不猜测余额单位', () => {
  assert.throws(() => parseSolanaTokenAccounts(response([
    account(MINT_A, '1', 6), account(MINT_A, '1', 9),
  ], []), WALLET), /decimals/);
});
