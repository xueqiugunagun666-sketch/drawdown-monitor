import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEvmWalletAddress, isSolanaWalletAddress, normalizeWalletAddress, walletAddressKind,
} from './walletAddress.ts';

const SOL = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';

test('识别 EVM 与 32 字节 Solana 公钥', () => {
  assert.equal(walletAddressKind('0x00000000000000000000000000000000000000aB'), 'evm');
  assert.equal(walletAddressKind(SOL), 'solana');
  assert.equal(isSolanaWalletAddress(SOL), true);
});

test('只像 base58 但解码后不是 32 字节的地址会被拒绝', () => {
  assert.equal(isSolanaWalletAddress('2'.repeat(32)), false);
  assert.equal(isSolanaWalletAddress('0'.repeat(32)), false);
  assert.equal(walletAddressKind('not-a-wallet'), null);
});

test('EVM 归一为小写，Solana 保留大小写', () => {
  assert.equal(
    normalizeWalletAddress(' 0x00000000000000000000000000000000000000aB '),
    '0x00000000000000000000000000000000000000ab',
  );
  assert.equal(normalizeWalletAddress(` ${SOL} `), SOL);
});
