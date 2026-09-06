import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByAddress, normalizeWalletLabelDraft, type WalletRow,
} from './WalletList.tsx';

const row = (address: string, chain: string, label: string | null): WalletRow => ({
  id: `${chain}:${address}`, chain, address, label,
  lastScannedBlock: null, lastScanAt: null, lastScanError: null,
});

test('钱包列表按地址归组，并保留跨链行中的备注', () => {
  const groups = groupByAddress([
    row('0xone', 'bsc', null),
    row('0xtwo', 'base', '自己2'),
    row('0xone', 'ethereum', '自己1'),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((x) => x.address === '0xone')?.label, '自己1');
  assert.equal(groups.find((x) => x.address === '0xone')?.chains.length, 2);
});

test('列表备注草稿 trim、空串清空、最多 40 个字符', () => {
  assert.equal(normalizeWalletLabelDraft('  自己1  '), '自己1');
  assert.equal(normalizeWalletLabelDraft('   '), null);
  assert.equal(normalizeWalletLabelDraft('x'.repeat(41)), 'x'.repeat(40));
});
