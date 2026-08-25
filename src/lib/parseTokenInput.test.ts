import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOne, parseMany } from './parseTokenInput.ts';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

test('Solana base58 地址自动识别为 solana', () => {
  const r = parseOne(BONK);
  assert.equal(r.chain, 'solana');
  assert.equal(r.target?.kind, 'token');
  assert.equal(r.target?.address, BONK);
});

test('EVM 地址无法从字面定链，返回候选', () => {
  const r = parseOne(PEPE);
  assert.equal(r.chain, null);
  assert.deepEqual(r.candidates, ['ethereum', 'base', 'bsc', 'robinhood']);
});

test('chain:address 形式', () => {
  const r = parseOne(`base:${PEPE}`);
  assert.equal(r.chain, 'base');
  assert.equal(r.target?.address, PEPE);
});

test('链名别名：eth / bnb / sol', () => {
  assert.equal(parseOne(`eth:${PEPE}`).chain, 'ethereum');
  assert.equal(parseOne(`bnb:${PEPE}`).chain, 'bsc');
  assert.equal(parseOne(`sol:${BONK}`).chain, 'solana');
});

test('DexScreener 链接指向的是池子，须标记为 pool', () => {
  const r = parseOne('https://dexscreener.com/solana/5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9');
  assert.equal(r.chain, 'solana');
  assert.equal(r.target?.kind, 'pool', 'DexScreener 详情页是池子地址，不是代币地址');
});

test('GeckoTerminal 链接区分 pools 与 tokens', () => {
  const p = parseOne('https://www.geckoterminal.com/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  assert.equal(p.chain, 'ethereum');
  assert.equal(p.target?.kind, 'pool');
  const t = parseOne(`https://www.geckoterminal.com/solana/tokens/${BONK}`);
  assert.equal(t.target?.kind, 'token');
});

test('GMGN 链接', () => {
  const r = parseOne(`https://gmgn.ai/sol/token/${BONK}`);
  assert.equal(r.chain, 'solana');
  assert.equal(r.target?.kind, 'token');
});

test('无效输入给出可读原因，而不是静默丢弃', () => {
  assert.match(parseOne('hello world').error ?? '', /地址/);
  assert.match(parseOne('https://example.com/foo').error ?? '', /无法/);
});

test('Solana 地址不含易混字符 0 O I l', () => {
  assert.ok(parseOne('0OIl00000000000000000000000000000000').error);
});

test('批量解析，忽略空行', () => {
  const rs = parseMany(`
    ${BONK}

    base:${PEPE}
    垃圾行
  `);
  assert.equal(rs.length, 3);
  assert.equal(rs[0]!.chain, 'solana');
  assert.equal(rs[1]!.chain, 'base');
  assert.ok(rs[2]!.error);
});
