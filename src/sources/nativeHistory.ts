/**
 * 原生币 USD 报价的历史序列（§2.3）。
 *
 * CoinGecko market_chart?days=90 返回**小时级**、毫秒时间戳、约 2161 点。
 * 插值到 5m 后写入 native_prices，供回填出的 USD candle 推导 native 计价。
 *
 * 关键：native 计价的回填**不需要额外的 GeckoTerminal 请求** ——
 * priceNative = priceUsd / nativeUsd(ts)，USD candle 已经有了。
 */
import { cgGet, apiBase } from './coingecko.ts';
import { Decimal, parsePrice, priceToText } from '../lib/decimal.ts';
import { SourceError } from '../lib/errors.ts';
import { getRawDb } from '../db/index.ts';
import { align5m, FIVE_MIN } from '../lib/time.ts';
import { makeLogger } from '../lib/log.ts';
import { NATIVE_SYMBOLS, type NativeSymbol } from './nativePrices.ts';

const log = makeLogger('nativeHistory');

const COINGECKO_IDS: Record<NativeSymbol, string> = {
  ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana',
};

/** 取历史价格点，返回 [tsSeconds, price] 升序。粒度由 days 决定，见 backfillNativePrices */
async function fetchHistory(symbol: NativeSymbol, days: number): Promise<Array<[number, Decimal]>> {
  const body = await cgGet(
    `${apiBase()}/coins/${COINGECKO_IDS[symbol]}/market_chart?vs_currency=usd&days=${days}`,
    `${symbol}/${days}d`,
  );
  const parsed = JSON.parse(body) as { prices?: Array<[number, number]> };
  if (!Array.isArray(parsed.prices) || parsed.prices.length === 0) {
    throw new SourceError({ sourceId: 'coingecko', kind: 'empty_response', message: `CoinGecko 未返回 ${symbol} 历史价格` });
  }
  const out: Array<[number, Decimal]> = [];
  for (const [ms, price] of parsed.prices) {
    const d = parsePrice(String(price));
    if (d && d.gt(0)) out.push([Math.floor(ms / 1000), d]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** 小时级线性插值到 5m 格 */
export function interpolateTo5m(hourly: Array<[number, Decimal]>): Array<[number, Decimal]> {
  if (hourly.length === 0) return [];
  const out: Array<[number, Decimal]> = [];
  for (let i = 0; i < hourly.length - 1; i++) {
    const [t0, p0] = hourly[i]!;
    const [t1, p1] = hourly[i + 1]!;
    const span = t1 - t0;
    if (span <= 0) continue;
    for (let t = align5m(t0); t < t1; t += FIVE_MIN) {
      if (t < t0) continue;
      const ratio = new Decimal(t - t0).div(span);
      out.push([t, p0.plus(p1.minus(p0).mul(ratio))]);
    }
  }
  const last = hourly.at(-1)!;
  out.push([align5m(last[0]), last[1]]);
  return out;
}

/**
 * 拉取并写入原生币历史。
 *
 * CoinGecko 的粒度随 days 变化（实测）：
 *   days=90  -> **小时级** 2161 点
 *   days=180 -> **日级**    181 点
 *
 * 因此分两段写，精度不同必须可分辨：
 *   90 天内      source='coingecko_hourly'  —— 服务 rolling_90d / since_added
 *   90–180 天    source='coingecko_daily'   —— 只服务 all_time，精度较低
 *
 * 写入顺序为先日级后小时级，重叠区间由小时级覆盖。
 * 实时值（source='coingecko'）永不被历史覆盖 —— 它最准。
 */
export async function backfillNativePrices(): Promise<Record<NativeSymbol, number>> {
  const db = getRawDb();
  const stmt = db.prepare(
    `INSERT INTO native_prices (symbol, ts, price_usd, source) VALUES (?,?,?,?)
     ON CONFLICT(symbol, ts) DO UPDATE SET
       price_usd = excluded.price_usd, source = excluded.source
     WHERE native_prices.source LIKE 'coingecko_%'`,
  );
  const counts = {} as Record<NativeSymbol, number>;

  for (const sym of NATIVE_SYMBOLS) {
    let total = 0;
    // 先日级（覆盖 90–180 天），再小时级（覆盖 0–90 天并盖掉重叠部分）
    for (const [days, tag] of [[180, 'coingecko_daily'], [90, 'coingecko_hourly']] as const) {
      try {
        const points = await fetchHistory(sym, days);
        const fivem = interpolateTo5m(points);
        const tx = db.transaction(() => {
          for (const [ts, price] of fivem) stmt.run(sym, ts, priceToText(price), tag);
        });
        tx();
        total += fivem.length;
        log.info(`${sym} ${days} 天历史: ${points.length} 个原始点 -> ${fivem.length} 个 5m 格 (${tag})`);
      } catch (err) {
        // 单个 symbol/区间失败不应拖垮其余的 —— 但必须留痕，
        // 缺失会让该链代币的 native ATH 窗口偏短
        log.exception(`${sym} ${days} 天历史回填失败，该区间 native 计价将缺失`, err);
      }
    }
    counts[sym] = total;
  }
  return counts;
}

/** 某 symbol 的历史覆盖情况，用于暴露 native 与 USD 的窗口差异 */
export function nativeCoverage(symbol: NativeSymbol): { oldestTs: number | null; hourlyOldestTs: number | null } {
  const db = getRawDb();
  const all = db.prepare('SELECT MIN(ts) t FROM native_prices WHERE symbol = ?').get(symbol) as { t: number | null };
  const hourly = db.prepare(
    "SELECT MIN(ts) t FROM native_prices WHERE symbol = ? AND source IN ('coingecko_hourly','coingecko')",
  ).get(symbol) as { t: number | null };
  return { oldestTs: all?.t ?? null, hourlyOldestTs: hourly?.t ?? null };
}

/** 建立 ts -> 原生币价 的查表，供回填 candle 推导 native 计价 */
export function loadNativeSeries(symbol: NativeSymbol): Map<number, Decimal> {
  const db = getRawDb();
  const rows = db.prepare('SELECT ts, price_usd FROM native_prices WHERE symbol = ? ORDER BY ts').all(symbol) as
    Array<{ ts: number; price_usd: string }>;
  const map = new Map<number, Decimal>();
  for (const r of rows) {
    const d = parsePrice(r.price_usd);
    if (d) map.set(r.ts, d);
  }
  return map;
}
