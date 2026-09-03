import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchQuotes, chunkAddresses, MAX_BATCH } from './dexscreenerBatch.ts';

const pair = (addr: string, price: string, liq: number, vol: number) => ({
  baseToken: { address: addr, symbol: 'X', name: 'X' },
  priceUsd: price, liquidity: { usd: liq }, volume: { h24: vol },
});

test('一次最多 30 个地址', () => {
  assert.equal(MAX_BATCH, 30);
});

test('chunkAddresses 按 30 切分', () => {
  const addrs = Array.from({ length: 71 }, (_, i) => `0x${i}`);
  const chunks = chunkAddresses(addrs);
  assert.deepEqual(chunks.map((c) => c.length), [30, 30, 11]);
  assert.equal(chunks.flat().length, 71, '切分不能丢地址');
});

test('空数组不产生空批次', () => {
  assert.deepEqual(chunkAddresses([]), []);
});

test('按 baseToken.address 归位，大小写不敏感', () => {
  const m = parseBatchQuotes(JSON.stringify([pair('0xAAA', '1.5', 9000, 20000)]), ['0xaaa']);
  assert.equal(m.get('0xaaa')?.priceUsd, '1.5');
  assert.equal(m.get('0xaaa')?.liquidityUsd, 9000);
  assert.equal(m.get('0xaaa')?.volume24hUsd, 20000);
});

test('请求的地址在响应里缺失时不出现在结果中，不当作零', () => {
  // 调用方据此写 filter_reason='报价缺失'。当作 0 会把币静默踢出监控
  const m = parseBatchQuotes('[]', ['0xaaa', '0xbbb']);
  assert.equal(m.size, 0);
  assert.equal(m.get('0xaaa'), undefined);
});

test('同一代币返回多个池时取流动性最高的', () => {
  const m = parseBatchQuotes(JSON.stringify([
    pair('0xa', '1', 100, 1),
    pair('0xa', '2', 900, 2),
    pair('0xa', '3', 500, 3),
  ]), ['0xa']);
  assert.equal(m.get('0xa')?.priceUsd, '2');
  assert.equal(m.get('0xa')?.liquidityUsd, 900);
});

test('价格保持字符串，不转 number', () => {
  // 第 1 条铁律：价格从入口进来就是字符串，中途不许过 Number
  const m = parseBatchQuotes(JSON.stringify([
    pair('0xa', '0.000000000001234', 9000, 2),
  ]), ['0xa']);
  assert.equal(m.get('0xa')?.priceUsd, '0.000000000001234');
  assert.equal(typeof m.get('0xa')?.priceUsd, 'string');
});

test('没有 priceUsd 的池被跳过', () => {
  const m = parseBatchQuotes(JSON.stringify([
    { baseToken: { address: '0xa' }, liquidity: { usd: 9000 }, volume: { h24: 2 } },
  ]), ['0xa']);
  assert.equal(m.get('0xa'), undefined, '没有价格等于没有报价');
});

test('缺 liquidity / volume 字段时按 0 计，不是 null', () => {
  // 字段缺失≠报价缺失：池确实存在且有价格，只是没有流动性数据。
  // 这种情况该被过滤层当作"流动性不足"挡掉，而不是"报价缺失"放行
  const m = parseBatchQuotes(JSON.stringify([
    { baseToken: { address: '0xa' }, priceUsd: '1' },
  ]), ['0xa']);
  assert.equal(m.get('0xa')?.liquidityUsd, 0);
  assert.equal(m.get('0xa')?.volume24hUsd, 0);
});

test('响应里出现没请求过的地址会被忽略', () => {
  const m = parseBatchQuotes(JSON.stringify([
    pair('0xa', '1', 1, 1), pair('0xUNASKED', '9', 9, 9),
  ]), ['0xa']);
  assert.equal(m.size, 1);
});

test('非数组响应抛错', () => {
  assert.throws(() => parseBatchQuotes('{"error":"boom"}', ['0xa']), /未返回数组/);
});

test('非 JSON 响应抛错且带上原文片段', () => {
  assert.throws(() => parseBatchQuotes('<html>502</html>', ['0xa']), /非 JSON/);
});

test('null 响应体不崩', () => {
  assert.throws(() => parseBatchQuotes('null', ['0xa']), /未返回数组/);
});

/* ---------- 项目方绑定的官网与社交（付费的增强信息） ---------- */

const WITH_INFO = JSON.stringify([{
  baseToken: { address: '0x3450598e419abb5609f60e4b2fda127ff0897777', symbol: 'FLETCH' },
  priceUsd: '0.0004695',
  liquidity: { usd: 94968.58 },
  volume: { h24: 568067.35, h1: 13001.61 },
  marketCap: 469501,
  info: {
    imageUrl: 'https://cdn.dexscreener.com/cms/images/lDOXV0eh0mUriPet',
    websites: [{ url: 'https://www.fletch.finance/', label: 'Website' }],
    socials: [
      { url: 'https://x.com/FletchFinance', type: 'twitter' },
      { url: 'https://t.me/FletchFinance', type: 'telegram' },
    ],
  },
}]);

test('解析出官网、推特、电报与头像', () => {
  const q = parseBatchQuotes(WITH_INFO, ['0x3450598e419abb5609f60e4b2fda127ff0897777'])
    .get('0x3450598e419abb5609f60e4b2fda127ff0897777')!;
  assert.equal(q.websiteUrl, 'https://www.fletch.finance/');
  assert.equal(q.twitterUrl, 'https://x.com/FletchFinance');
  assert.equal(q.telegramUrl, 'https://t.me/FletchFinance');
  assert.match(q.imageUrl ?? '', /^https:\/\/cdn\.dexscreener\.com\//);
});

test('没买增强信息的币，这几项是 null 而不是崩', () => {
  const body = JSON.stringify([{
    baseToken: { address: '0xabc', symbol: 'X' }, priceUsd: '1', liquidity: { usd: 1 },
  }]);
  const q = parseBatchQuotes(body, ['0xabc']).get('0xabc')!;
  assert.equal(q.websiteUrl, null);
  assert.equal(q.twitterUrl, null);
  assert.equal(q.telegramUrl, null);
  assert.equal(q.imageUrl, null);
});

test('只认 http/https —— 这些 URL 是项目方自己填的，会原样变成页面上可点的链接', () => {
  // 不校验就等于让第三方往我们页面里塞任意 href
  const body = JSON.stringify([{
    baseToken: { address: '0xevil', symbol: 'E' }, priceUsd: '1', liquidity: { usd: 1 },
    info: {
      imageUrl: 'javascript:alert(1)',
      websites: [{ url: 'javascript:alert(2)' }, { url: 'https://ok.example/' }],
      socials: [{ url: 'data:text/html,<script>', type: 'twitter' }],
    },
  }]);
  const q = parseBatchQuotes(body, ['0xevil']).get('0xevil')!;
  assert.equal(q.imageUrl, null);
  assert.equal(q.websiteUrl, 'https://ok.example/', '跳过不安全的，取下一个能用的');
  assert.equal(q.twitterUrl, null);
});

test('socials 里没有 twitter 时不会误取别的类型', () => {
  const body = JSON.stringify([{
    baseToken: { address: '0xd', symbol: 'D' }, priceUsd: '1', liquidity: { usd: 1 },
    info: { socials: [{ url: 'https://discord.gg/x', type: 'discord' }] },
  }]);
  const q = parseBatchQuotes(body, ['0xd']).get('0xd')!;
  assert.equal(q.twitterUrl, null);
  assert.equal(q.telegramUrl, null);
});

test('info 结构不对时不崩', () => {
  for (const info of ['乱写', 123, { websites: 'nope', socials: {} }, null]) {
    const body = JSON.stringify([{
      baseToken: { address: '0xz', symbol: 'Z' }, priceUsd: '1', liquidity: { usd: 1 }, info,
    }]);
    const q = parseBatchQuotes(body, ['0xz']).get('0xz')!;
    assert.equal(q.websiteUrl, null, JSON.stringify(info));
  }
});
