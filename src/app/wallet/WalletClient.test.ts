import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsPortfolioRefresh, PORTFOLIO_REFRESH_INTERVAL_MS } from './WalletClient.tsx';
import type { WalletRow } from './WalletList.tsx';
import type { HoldingRow } from './HoldingsTable.tsx';

const wallet = (over: Partial<WalletRow> = {}): WalletRow => ({
  id: 'w1', chain: 'bsc', address: '0xabc', label: null,
  lastScannedBlock: null, lastScanAt: null, lastScanError: null,
  ...over,
});

const holding = (over: Partial<HoldingRow> = {}): HoldingRow => ({
  tokenId: 'bsc:0x1', chain: 'bsc', address: '0x1', symbol: null, wallet: 'w1',
  amount: '1', priceUsd: null, valueUsd: null, monitored: false, filterReason: null,
  lastQuoteAt: null, decimalsKnown: true, best: null,
  ...over,
});

test('从未扫描且没有错误的钱包需要自动刷新', () => {
  assert.equal(needsPortfolioRefresh([wallet()], []), true);
});

test('扫到但尚未行情评估的真实持仓需要自动刷新', () => {
  assert.equal(needsPortfolioRefresh([
    wallet({ lastScanAt: 100, lastScannedBlock: 123 }),
  ], [holding()]), true);
});

test('扫描失败已显式显示错误时不无限轮询', () => {
  assert.equal(needsPortfolioRefresh([
    wallet({ lastScanError: 'RPC 暂时不可用' }),
  ], []), false);
});

test('持仓已进入监控或已有过滤结论时停止刷新', () => {
  const scanned = wallet({ lastScanAt: 100, lastScannedBlock: 123 });
  assert.equal(needsPortfolioRefresh([scanned], [
    holding({ monitored: true }),
    holding({ tokenId: 'bsc:0x2', filterReason: '流动性不足' }),
  ]), false);
});

test('空页面不产生永久轮询，刷新间隔保持十秒', () => {
  assert.equal(needsPortfolioRefresh([], []), false);
  assert.equal(PORTFOLIO_REFRESH_INTERVAL_MS, 10_000);
});
