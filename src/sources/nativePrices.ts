/**
 * 原生币 USD 报价（§2.3）—— priceNative = priceUsd / nativeCoinUsdPrice。
 *
 * 实时：CoinGecko simple/price，60s 刷新，写入 native_prices 表。
 * 历史回填（Phase 2）：market_chart 90 天小时级，插值到 5m。
 */
import { httpGet } from '../lib/http.ts';
import { parsePrice, priceToText, type Decimal } from '../lib/decimal.ts';
import { SourceError } from '../lib/errors.ts';
import { getSecrets } from '../lib/config.ts';
import { getRawDb } from '../db/index.ts';
import { align5m } from '../lib/time.ts';

export const NATIVE_SYMBOLS = ['ETH', 'BNB', 'SOL'] as const;
export type NativeSymbol = (typeof NATIVE_SYMBOLS)[number];

const COINGECKO_IDS: Record<NativeSymbol, string> = {
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
};

export async function fetchNativePrices(): Promise<Record<NativeSymbol, Decimal>> {
  const { coingeckoApiKey } = getSecrets();
  const ids = NATIVE_SYMBOLS.map((s) => COINGECKO_IDS[s]).join(',');
  const base = coingeckoApiKey
    ? 'https://pro-api.coingecko.com/api/v3/simple/price'
    : 'https://api.coingecko.com/api/v3/simple/price';
  const keyParam = coingeckoApiKey ? `&x_cg_pro_api_key=${coingeckoApiKey}` : '';
  const url = `${base}?ids=${ids}&vs_currencies=usd${keyParam}`;

  const res = await httpGet(url);
  if (res.status === 429) {
    throw new SourceError({ sourceId: 'coingecko', kind: 'rate_limited', message: 'CoinGecko 429 限流' });
  }
  if (res.status !== 200) {
    throw new SourceError({ sourceId: 'coingecko', kind: 'http_error', message: `CoinGecko HTTP ${res.status}` });
  }

  let parsed: Record<string, { usd?: number | string }>;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new SourceError({ sourceId: 'coingecko', kind: 'malformed', message: 'CoinGecko 响应不是合法 JSON' });
  }

  const out = {} as Record<NativeSymbol, Decimal>;
  const missing: string[] = [];
  for (const sym of NATIVE_SYMBOLS) {
    const raw = parsed[COINGECKO_IDS[sym]]?.usd;
    const d = parsePrice(raw === undefined ? null : String(raw));
    if (!d || d.lte(0)) missing.push(sym);
    else out[sym] = d;
  }
  if (missing.length > 0) {
    throw new SourceError({ sourceId: 'coingecko', kind: 'partial_response',
      message: `CoinGecko 缺少报价: ${missing.join(',')}`, missing });
  }
  return out;
}

/** 写入 native_prices（5m 对齐，同一格覆盖写） */
export function saveNativePrices(prices: Record<NativeSymbol, Decimal>, ts = Date.now() / 1000): void {
  const db = getRawDb();
  const slot = align5m(Math.floor(ts));
  const stmt = db.prepare(
    `INSERT INTO native_prices (symbol, ts, price_usd, source) VALUES (?,?,?,?)
     ON CONFLICT(symbol, ts) DO UPDATE SET price_usd=excluded.price_usd, source=excluded.source`,
  );
  const tx = db.transaction(() => {
    for (const sym of NATIVE_SYMBOLS) {
      const p = prices[sym];
      if (p) stmt.run(sym, slot, priceToText(p), 'coingecko');
    }
  });
  tx();
}

/** 读最近一条原生币报价；没有则返回 null（调用方据此把 priceNative 置 null） */
export function getLatestNativePrice(symbol: NativeSymbol): Decimal | null {
  const db = getRawDb();
  const row = db.prepare(
    'SELECT price_usd FROM native_prices WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
  ).get(symbol) as { price_usd: string } | undefined;
  return row ? parsePrice(row.price_usd) : null;
}
