/**
 * 发测试报警 —— 走**真实的**投递路径与消息模板，
 * 用清单里代币的真实价格、流动性、成交数据，只有回撤数字是编的。
 *
 *   npm run test:alerts -- [条数]
 *
 * 目的是让你看到真报警长什么样，并确认手机能连续收到。
 */
import { Decimal, priceFromText } from '../src/lib/decimal.ts';
import { sleep } from '../src/lib/http.ts';
import { nowSec } from '../src/lib/time.ts';
import { buildMessage } from '../src/worker/notifier.ts';
import { httpGet } from '../src/lib/http.ts';
import { getSecrets } from '../src/lib/config.ts';
import { safeErrorMessage } from '../src/lib/mask.ts';
import * as repo from '../src/db/repo.ts';
import type { FiredAlert } from '../src/worker/engine.ts';
import type { TokenQuote, PoolRef } from '../src/sources/types.ts';

const args = process.argv.slice(2);
/** --dry 只在本地渲染消息，不发送 */
const dryRun = args.includes('--dry');
const count = Math.min(Math.max(Number(args.find((a) => !a.startsWith('--')) ?? 10), 1), 20);
const { telegramBotToken, telegramChatId } = getSecrets();
if (!dryRun && (!telegramBotToken || !telegramChatId)) {
  console.error('Telegram 未配置，先跑 npm run check:telegram');
  process.exit(1);
}

const tokens = repo.listAllTokens().filter((t) => t.enabled === 1);
if (tokens.length === 0) {
  console.error('清单为空，没有可用来构造测试消息的代币');
  process.exit(1);
}

const LEVELS = [80, 85, 90, 95];

function fakeAlert(index: number): FiredAlert | null {
  const token = tokens[index % tokens.length]!;
  const last = repo.getCandles(token.id, '5m', 0).at(-1);
  const price = priceFromText(last?.c ?? null);
  if (!price) return null;

  const pools = repo.listPools(token.id).filter((p) => p.isOutlier === 0);
  const primary = pools.find((p) => p.isPrimary === 1) ?? pools[0];
  if (!primary) return null;
  const liqTotal = pools.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);

  const level = LEVELS[index % LEVELS.length]!;
  // 反推一个能产生该回撤的 ATH，让消息里的数字自洽
  const drawdown = new Decimal(level).plus(index % 3);
  const ath = price.div(new Decimal(1).minus(drawdown.div(100)));

  const toRef = (p: typeof primary): PoolRef => ({
    chain: token.chain as PoolRef['chain'],
    address: p.address, dex: p.dex, quoteSymbol: p.quoteSymbol,
    quoteAddress: p.quoteAddress, liquidityUsd: p.liquidityUsd ?? 0,
    createdAt: p.createdAt, priceUsd: p.priceUsd ?? price.toString(),
    isOutlier: false,
  });

  const quote: TokenQuote = {
    chain: token.chain as TokenQuote['chain'], address: token.address,
    symbol: token.symbol, name: token.name,
    priceUsd: price, priceNative: null,
    liquidityPrimary: primary.liquidityUsd ?? 0, liquidityTotal: liqTotal,
    fdvUsd: null, marketCapUsd: null,   // dry-run 不编造市值，真实报警用数据源返回值
    volume: { m5: 0, h1: 0, h24: (last?.volumeUsd ?? 0) * 288 },
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 40 + index * 7, sells: 30 + index * 5 },
      h24: { buys: 0, sells: 0 },
    },
    primaryPool: toRef(primary), allPools: pools.map(toRef),
    medianPriceUsd: price, crossValidated: pools.length >= 3,
    fetchedAt: nowSec(), source: 'test',
  };

  return {
    id: `test-${index}`, token, level,
    drawdownUsd: drawdown, drawdownNative: null,
    priceUsd: price, athUsd: ath,
    athTs: nowSec() - (index + 1) * 3600,
    quote, athLiquidity: liqTotal * 1.6, athMarketCap: null,
    athMode: 'rolling_90d', quoteMode: 'usd',
  };
}

async function send(text: string): Promise<void> {
  const url =
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage` +
    `?chat_id=${encodeURIComponent(telegramChatId!)}&disable_web_page_preview=true` +
    `&text=${encodeURIComponent(text)}`;
  const res = await httpGet(url, 20_000);
  const parsed = JSON.parse(res.body) as { ok?: boolean; description?: string };
  if (!parsed.ok) throw new Error(parsed.description ?? `HTTP ${res.status}`);
}

console.log(dryRun ? `本地渲染 ${count} 条，不发送：\n` : `准备发送 ${count} 条测试报警到你的群…\n`);
let ok = 0;
for (let i = 0; i < count; i++) {
  const a = fakeAlert(i);
  if (!a) { console.log(`  [${i + 1}/${count}] 跳过：该代币还没有价格数据`); continue; }
  const text = `【测试 ${i + 1}/${count}】这不是真实报警\n\n${buildMessage(a)}`;
  if (dryRun) {
    console.log('─'.repeat(46));
    console.log(text);
    console.log();
    continue;
  }
  try {
    await send(text);
    ok++;
    console.log(`  [${i + 1}/${count}] 已发送 · ${a.token.symbol ?? a.token.id} · ${a.level}% 档`);
  } catch (err) {
    console.error(`  [${i + 1}/${count}] 失败: ${safeErrorMessage(err)}`);
  }
  // Telegram 对同一个群约 20 条/分钟，隔开一点避免被限流
  if (i < count - 1) await sleep(1500);
}
if (!dryRun) {
  console.log(`\n完成：${ok}/${count} 条送达。`);
  console.log('这些都是测试消息，可以直接在群里删掉。');
}
