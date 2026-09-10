/**
 * 钱包报警的 XXYY 快链路。
 *
 * 这里只处理已经通过资格筛选（holdings.monitored=1）的币。DexScreener 的
 * 流动性、成交量和链接更新继续由慢轮次负责，但绝不再挡住本模块的当前价。
 */
import PQueue from 'p-queue';
import { Decimal } from '../lib/decimal.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import {
  bootstrapXxyyCandlesFromShadow, loadXxyy5mCandles, pruneXxyyCandles,
  upsertXxyyCandle, xxyyHistoryStart, xxyyWindowHighsBefore, XXYY_PRICE_REGIME,
  type XxyyHighPoint,
} from '../db/xxyyCandleRepo.ts';
import { beginXxyyAlertRun, completeXxyyAlertRun } from '../db/pumpHealthRepo.ts';
import {
  fetchXxyyPricesDetailed, normalizeMint, supportsChain,
  type XxyyPricesDetailedResult, type XxyyQuote,
} from '../sources/xxyy.ts';
import { computeMultiples, WINDOW_SECONDS, type PumpBasis, type PumpTimeframe } from './pumpWindows.ts';
import {
  ADVANCE_RATIO, DEDUP_WINDOW_SECONDS, LEVELS, evaluatePump, pickWinner,
  seedPumpState, shouldFireOnAdvance, suppressedByRecent,
  type PendingFire, type PumpSnapshot, type RecentAlert,
} from './pumpState.ts';
import {
  ATH_WINDOWS, describeWindow, largestBrokenWindow, windowRank,
} from './athWindows.ts';
import { BREAKOUT_MARGIN, REARM_RATIO, ADVANCE_RATIO as ATH_ADVANCE_RATIO } from './athState.ts';
import { fanout } from './pumpEngine.ts';
import { recordVerdict } from './sourceWatch.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';

const log = makeLogger('xxyy-alert-engine');

/** XXYY 一批最多 500 个地址，当前全量热币通常 2 秒内完成；15 秒留足余量。 */
export const XXYY_ALERT_INTERVAL_SECONDS = 15;
const ATH_WINDOW_CACHE_SECONDS = 300;

export interface XxyyAlertDeps {
  fetchPricesDetailed: typeof fetchXxyyPricesDetailed;
  clock?: () => number;
}

export const realXxyyAlertDeps: XxyyAlertDeps = {
  fetchPricesDetailed: fetchXxyyPricesDetailed,
};

export interface XxyyAlertTickResult {
  requested: number;
  covered: number;
  evaluated: number;
  pendingConfirmation: number;
  failures: number;
  evalErrors: number;
}

interface StateKey { tokenId: string; timeframe: string; basis: string; level: number }

function loadStates(tokenId: string): Map<string, PumpSnapshot> {
  const rows = getRawDb().prepare(
    `SELECT timeframe, basis, level, state, last_fired_at
       FROM wallet_xxyy_pump_states WHERE token_id = ?`,
  ).all(tokenId) as Array<{
    timeframe: string; basis: string; level: number; state: string; last_fired_at: number | null;
  }>;
  const out = new Map<string, PumpSnapshot>();
  for (const row of rows) {
    out.set(`${row.timeframe}|${row.basis}|${row.level}`, {
      state: row.state === 'FIRED' ? 'FIRED' : 'ARMED',
      lastFiredAt: row.last_fired_at,
    });
  }
  return out;
}

function saveState(key: StateKey, state: PumpSnapshot): void {
  getRawDb().prepare(
    `INSERT INTO wallet_xxyy_pump_states
       (token_id, timeframe, basis, level, state, last_fired_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id, timeframe, basis, level) DO UPDATE SET
       state = excluded.state, last_fired_at = excluded.last_fired_at`,
  ).run(key.tokenId, key.timeframe, key.basis, key.level, state.state, state.lastFiredAt);
}

function recentAlert(tokenId: string, now: number): RecentAlert | null {
  const rows = getRawDb().prepare(
    `SELECT fired_at, level, price_usd FROM pump_alerts
      WHERE token_id = ? AND fired_at >= ? AND price_regime = ?
        AND kind IN ('level', 'advance', 'pump-ath')`,
  ).all(tokenId, now - DEDUP_WINDOW_SECONDS, XXYY_PRICE_REGIME) as Array<{
    fired_at: number; level: number; price_usd: string | null;
  }>;
  if (rows.length === 0) return null;
  let at = 0;
  let level = 0;
  let maxPrice = new Decimal(0);
  for (const row of rows) {
    at = Math.max(at, row.fired_at);
    level = Math.max(level, row.level);
    if (!row.price_usd) continue;
    try {
      const value = new Decimal(row.price_usd);
      if (value.gt(maxPrice)) maxPrice = value;
    } catch { /* 历史坏行不参与价格锚点 */ }
  }
  return { at, level, maxPrice };
}

function pickBestWindow(
  windows: Array<{ timeframe: PumpTimeframe; basis: PumpBasis; multiple: Decimal }>, now: number,
): PendingFire | null {
  let best: typeof windows[number] | null = null;
  for (const window of windows) {
    if (!best) { best = window; continue; }
    const compared = window.multiple.comparedTo(best.multiple);
    if (compared > 0 || (compared === 0
        && WINDOW_SECONDS[window.timeframe] < WINDOW_SECONDS[best.timeframe])) best = window;
  }
  return best ? {
    tokenId: '', timeframe: best.timeframe, basis: best.basis,
    level: 0, multiple: best.multiple, at: now,
  } : null;
}

interface XxyyAthRow {
  ath_price: string | null;
  ath_ts: number | null;
  history_start_ts: number | null;
  last_alert_price: string | null;
  last_window: string | null;
  window_highs: string | null;
  window_highs_at: number | null;
}

function parseHighs(raw: string | null): Map<string, XxyyHighPoint> {
  const out = new Map<string, XxyyHighPoint>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      const point = typeof value === 'string'
        ? { price: value, ts: null }
        : value && typeof value === 'object'
          ? value as { price?: unknown; ts?: unknown } : null;
      if (!point || typeof point.price !== 'string') continue;
      const price = new Decimal(point.price);
      const ts = typeof point.ts === 'number' && Number.isInteger(point.ts) ? point.ts : null;
      if (price.isFinite() && price.gt(0)) out.set(key, { price, ts });
    }
  } catch { /* 坏缓存下一轮重建 */ }
  return out;
}

function highest(values: Iterable<XxyyHighPoint>, fallback: XxyyHighPoint): XxyyHighPoint {
  let best = fallback;
  for (const value of values) if (value.price.gt(best.price)) best = value;
  return best;
}

function serializeHighs(highs: Map<string, XxyyHighPoint>): string {
  return JSON.stringify(Object.fromEntries(
    [...highs].map(([key, point]) => [key, { price: point.price.toString(), ts: point.ts }]),
  ));
}

interface AthFire {
  winner: PendingFire;
  kind: 'ath' | 'ath-advance';
  basePrice: Decimal;
  baseTs: number | null;
  windowKey: string;
}

/** 调用时 current 尚未写入历史，因此 highsBefore 不会把突破价吞进参照线。 */
function evaluateAth(
  tokenId: string, price: Decimal, now: number, highsBefore: Map<string, XxyyHighPoint>,
): AthFire | null {
  const db = getRawDb();
  const row = db.prepare(
    `SELECT ath_price, ath_ts, history_start_ts, last_alert_price, last_window,
            window_highs, window_highs_at
       FROM wallet_xxyy_ath WHERE token_id = ?`,
  ).get(tokenId) as XxyyAthRow | undefined;
  const start = xxyyHistoryStart(tokenId);

  // 切源首轮只建立 XXYY 自己的基准，不把影子期已经发生的涨幅补报给所有人。
  if (!row) {
    const initial = highest(highsBefore.values(), { price, ts: now });
    db.prepare(
      `INSERT INTO wallet_xxyy_ath
         (token_id, ath_price, ath_ts, history_start_ts, state,
          window_highs, window_highs_at, updated_at)
       VALUES (?, ?, ?, ?, 'ARMED', ?, ?, ?)`,
    ).run(
      tokenId, initial.price.toString(), initial.ts ?? now, start,
      serializeHighs(highsBefore),
      now, now,
    );
    return null;
  }

  let highs = row.window_highs_at !== null && now - row.window_highs_at < ATH_WINDOW_CACHE_SECONDS
    ? parseHighs(row.window_highs)
    : highsBefore;
  if (highs.size === 0) highs = highsBefore;
  if (row.window_highs_at === null || now - row.window_highs_at >= ATH_WINDOW_CACHE_SECONDS) {
    db.prepare(
      `UPDATE wallet_xxyy_ath SET window_highs = ?, window_highs_at = ?,
          history_start_ts = COALESCE(history_start_ts, ?), updated_at = ?
        WHERE token_id = ?`,
    ).run(
      serializeHighs(highs),
      now, start, now, tokenId,
    );
  }
  if (highs.size === 0) return null;

  const coveredFrom = row.history_start_ts ?? start;
  const highPrices = new Map([...highs].map(([key, point]) => [key, point.price]));
  const broken = largestBrokenWindow(price, highPrices, coveredFrom, now, BREAKOUT_MARGIN);
  const shortest = highs.get(ATH_WINDOWS[0]!.key);
  if (shortest && row.last_window
    && price.lt(shortest.price.mul(new Decimal(String(REARM_RATIO))))) {
    db.prepare(
      `UPDATE wallet_xxyy_ath SET state = 'ARMED', last_window = NULL,
          last_alert_price = NULL, ref_ath = NULL, updated_at = ? WHERE token_id = ?`,
    ).run(now, tokenId);
    return null;
  }
  if (!broken) {
    const old = row.ath_price ? new Decimal(row.ath_price) : new Decimal(0);
    if (price.gt(old)) {
      db.prepare(
        `UPDATE wallet_xxyy_ath SET ath_price = ?, ath_ts = ?, updated_at = ? WHERE token_id = ?`,
      ).run(price.toString(), now, now, tokenId);
    }
    return null;
  }

  const previousRank = row.last_window ? windowRank(row.last_window) : -1;
  const currentRank = windowRank(broken.key);
  const lastAlert = row.last_alert_price ? new Decimal(row.last_alert_price) : null;
  const isNewWindow = currentRank > previousRank;
  const advanced = !isNewWindow && lastAlert !== null
    && price.gte(lastAlert.mul(new Decimal(String(ATH_ADVANCE_RATIO))));
  if (!isNewWindow && !advanced) return null;

  const ref = highs.get(broken.key)!;
  db.prepare(
    `UPDATE wallet_xxyy_ath SET ath_price = ?, ath_ts = ?, state = 'FIRED',
        last_alert_price = ?, last_alert_at = ?, ref_ath = ?, last_window = ?, updated_at = ?
      WHERE token_id = ?`,
  ).run(
    price.toString(), now, price.toString(), now, ref.price.toString(), broken.key, now, tokenId,
  );
  log.debug(`${tokenId} XXYY ${describeWindow(broken)}`);
  return {
    winner: {
      tokenId, timeframe: '24h', basis: 'low', level: 0,
      multiple: price.div(ref.price), at: now,
    },
    kind: isNewWindow ? 'ath' : 'ath-advance',
    basePrice: ref.price,
    baseTs: ref.ts,
    windowKey: broken.key,
  };
}

async function evaluateQuote(tokenId: string, quote: XxyyQuote, now: number): Promise<boolean> {
  let price: Decimal;
  try { price = new Decimal(quote.priceUsd); }
  catch { return false; }
  if (!price.isFinite() || price.lte(0)) return false;

  const holders = wr.usersHoldingToken(tokenId);
  if (!holders.some((holder) => wr.getHolding(holder.walletId, tokenId)?.monitored === 1)) return false;

  // ATH 必须先拿旧高点，再把 current 写进去；顺序反过来会让新高永远追不上自己。
  const highsBefore = xxyyWindowHighsBefore(tokenId, ATH_WINDOWS, now);
  const written = upsertXxyyCandle(
    tokenId, quote.priceUsd, quote.marketCapUsd, quote.fetchedAt ?? now,
  );
  if (written.status === 'pending-confirmation') {
    log.warn(`${tokenId} ${written.reason}`);
    return false;
  }
  if (written.status === 'rejected') {
    log.warn(`${tokenId} ${written.reason}`);
    return false;
  }

  const windows = computeMultiples(loadXxyy5mCandles(tokenId, now - 86400 - 600), price, now);
  const persist = getRawDb().transaction(() => {
    const states = loadStates(tokenId);
    const fires: PendingFire[] = [];
    for (const window of windows) {
      for (const level of LEVELS) {
        const id = `${window.timeframe}|${window.basis}|${level}`;
        const previous = states.get(id);
        if (!previous) {
          saveState(
            { tokenId, timeframe: window.timeframe, basis: window.basis, level },
            seedPumpState(window.multiple, level),
          );
          continue;
        }
        const result = evaluatePump(previous, { multiple: window.multiple, level, now });
        saveState(
          { tokenId, timeframe: window.timeframe, basis: window.basis, level }, result.next,
        );
        if (result.fire) fires.push({
          tokenId, timeframe: window.timeframe, basis: window.basis,
          level, multiple: window.multiple, at: now,
        });
      }
    }

    const recent = recentAlert(tokenId, now);
    const crossed = pickWinner(fires);
    let winner: PendingFire | null = null;
    let kind: 'level' | 'advance' = 'level';
    if (crossed && !suppressedByRecent(recent, now, crossed.level)) {
      winner = crossed;
    } else if (shouldFireOnAdvance(recent, now, price)) {
      const best = pickBestWindow(windows, now);
      if (best) {
        winner = { ...best, level: recent!.level };
        kind = 'advance';
      }
    }

    const ath = evaluateAth(tokenId, price, now, highsBefore);
    if (!winner && !ath) return null;
    if (!winner && ath) {
      return fanout(
        tokenId, holders, price, ath.winner, ath.kind, ath.basePrice, now,
        ath.baseTs, ath.windowKey, quote.marketCapUsd, quote.fetchedAt ?? now,
        'xxyy', XXYY_PRICE_REGIME,
      );
    }

    const base = windows.find((window) =>
      window.timeframe === winner!.timeframe && window.basis === winner!.basis)?.base ?? null;
    return fanout(
      tokenId, holders, price, winner!, ath ? 'pump-ath' : kind, base, now,
      ath?.baseTs ?? null, ath?.windowKey ?? null, quote.marketCapUsd,
      quote.fetchedAt ?? now, 'xxyy', XXYY_PRICE_REGIME,
    );
  });

  const delivered = persist();
  if (delivered?.notified) {
    log.info(`${tokenId} XXYY 报警已落库，通知 ${delivered.notified} 人`);
  }
  return true;
}

function isTechnicalFailure(kind: string): boolean {
  return kind !== 'empty_response' && kind !== 'partial_response';
}

interface CoverageBaseline {
  baseline_requested: number;
  baseline_covered: number;
}

/** 返回本轮从响应中消失、但此前成功报过价的 token 数。 */
function recordTokenCoverage(
  chain: string, addresses: string[], quotes: Map<string, XxyyQuote>, now: number,
): number {
  const db = getRawDb();
  return db.transaction(() => {
    let lost = 0;
    const read = db.prepare(
      `SELECT last_ok_at FROM wallet_xxyy_token_health WHERE token_id = ?`,
    );
    const ok = db.prepare(
      `INSERT INTO wallet_xxyy_token_health (token_id, last_ok_at, last_missing_at)
       VALUES (?, ?, NULL)
       ON CONFLICT(token_id) DO UPDATE SET last_ok_at=excluded.last_ok_at, last_missing_at=NULL`,
    );
    const missing = db.prepare(
      `UPDATE wallet_xxyy_token_health SET last_missing_at = ? WHERE token_id = ?`,
    );
    for (const address of addresses) {
      const mint = normalizeMint(chain, address);
      const tokenId = `${chain}:${mint}`;
      if (quotes.has(mint)) ok.run(tokenId, now);
      else if (read.get(tokenId)) {
        lost++;
        missing.run(now, tokenId);
      }
    }
    return lost;
  })();
}

/**
 * HTTP 200 不是健康证明：覆盖率跌到历史健康水位的一半以下，也算静默故障。
 * 只在本轮没有技术失败时抬高水位，失败数据永远不能训练成“新正常”。
 */
function coverageDropped(
  chain: string, requested: number, covered: number, now: number, technicalFailures: number,
): boolean {
  const db = getRawDb();
  const baseline = db.prepare(
    `SELECT baseline_requested, baseline_covered
       FROM wallet_xxyy_source_baselines WHERE chain = ?`,
  ).get(chain) as CoverageBaseline | undefined;
  const dropped = !!baseline && baseline.baseline_covered >= 5 && requested > 0
    && covered * baseline.baseline_requested * 2
      < baseline.baseline_covered * requested;

  const shouldRaise = technicalFailures === 0 && covered > 0 && (
    !baseline || covered * baseline.baseline_requested
      > baseline.baseline_covered * requested
  );
  const nextRequested = shouldRaise ? requested : (baseline?.baseline_requested ?? requested);
  const nextCovered = shouldRaise ? covered : (baseline?.baseline_covered ?? covered);
  db.prepare(
    `INSERT INTO wallet_xxyy_source_baselines
       (chain, baseline_requested, baseline_covered, last_requested, last_covered, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain) DO UPDATE SET
       baseline_requested = excluded.baseline_requested,
       baseline_covered = excluded.baseline_covered,
       last_requested = excluded.last_requested,
       last_covered = excluded.last_covered,
       updated_at = excluded.updated_at`,
  ).run(chain, nextRequested, nextCovered, requested, covered, now);
  return dropped;
}

/**
 * 一轮只向 XXYY 请求当前已经监控的去重 token；各链并发提交，成功链无需
 * 等失败链。XXYY 缺失时不拿 DS 价补位，避免主源落后问题原样回来。
 */
export async function runXxyyAlertTick(
  now: number, deps: XxyyAlertDeps = realXxyyAlertDeps,
): Promise<XxyyAlertTickResult> {
  const tokenIds = wr.monitoredTokenIds();
  const runId = now;
  beginXxyyAlertRun(runId, now, tokenIds.length);
  const byChain = new Map<string, string[]>();
  for (const tokenId of tokenIds) {
    const split = tokenId.indexOf(':');
    if (split < 1) continue;
    const chain = tokenId.slice(0, split);
    const address = tokenId.slice(split + 1);
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(address);
  }

  const result: XxyyAlertTickResult = {
    requested: tokenIds.length, covered: 0, evaluated: 0,
    pendingConfirmation: 0, failures: 0, evalErrors: 0,
  };
  const queue = new PQueue({ concurrency: 8 });
  let fatal: unknown = null;
  try {
    await Promise.all([...byChain].map(async ([chain, addresses]) => {
    if (!supportsChain(chain)) {
      result.failures++;
      recordVerdict(
        `xxyy-alerts:${chain}`, { ok: false, reason: 'XXYY 不支持该链' }, now,
        `请求 ${addresses.length}，有效 0`,
      );
      return;
    }

    let response: XxyyPricesDetailedResult;
    try {
      response = await deps.fetchPricesDetailed(chain, addresses);
    } catch (error) {
      const reason = safeErrorMessage(error);
      response = {
        quotes: new Map(), failures: [{ addresses, kind: 'network', reason }],
      };
    }
    result.covered += response.quotes.size;
    const lostPreviouslyCovered = recordTokenCoverage(
      chain, addresses, response.quotes, deps.clock?.() ?? now,
    );
    const technical = response.failures.filter((failure) => isTechnicalFailure(failure.kind));
    const dropped = coverageDropped(
      chain, addresses.length, response.quotes.size, deps.clock?.() ?? now, technical.length,
    );
    const sourceFailed = technical.length > 0
      || (addresses.length > 0 && response.quotes.size === 0) || dropped
      || lostPreviouslyCovered > 0;
    if (sourceFailed) result.failures += Math.max(1, technical.length);
    recordVerdict(
      `xxyy-alerts:${chain}`,
      sourceFailed
        ? { ok: false, reason: technical[0]?.reason
          ?? (response.quotes.size === 0
            ? 'HTTP 200 但整链无有效报价'
            : lostPreviouslyCovered > 0
              ? `${lostPreviouslyCovered} 个此前有价的币从响应中消失`
              : 'HTTP 200 但有效报价覆盖率突然掉崖') }
        : { ok: true, reason: null },
      deps.clock?.() ?? now,
      `请求 ${addresses.length}，有效 ${response.quotes.size}，技术失败批次 ${technical.length}，旧覆盖缺失 ${lostPreviouslyCovered}`,
    );

    const tasks: Array<Promise<void>> = [];
    for (const [mint, quote] of response.quotes) {
      const tokenId = `${chain}:${normalizeMint(chain, mint)}`;
      tasks.push(queue.add(async () => {
        try {
          const evaluated = await evaluateQuote(tokenId, quote, deps.clock?.() ?? now);
          if (evaluated) result.evaluated++;
          else {
            const pending = getRawDb().prepare(
              `SELECT 1 AS yes FROM wallet_xxyy_pending_quotes WHERE token_id = ?`,
            ).get(tokenId);
            if (pending) result.pendingConfirmation++;
          }
        } catch (error) {
          result.evalErrors++;
          log.warn(`${tokenId} XXYY 判定失败，本轮其他币继续: ${safeErrorMessage(error)}`);
        }
      }).then(() => undefined));
    }
    await Promise.all(tasks);
    }));

    if (now % 3600 < XXYY_ALERT_INTERVAL_SECONDS) {
      try { pruneXxyyCandles(now); }
      catch (error) { log.warn(`清理 XXYY 细粒度历史失败: ${safeErrorMessage(error)}`); }
    }
    log.debug(
      `XXYY 快轮次：请求 ${result.requested}，有效 ${result.covered}，`
      + `判定 ${result.evaluated}，待确认 ${result.pendingConfirmation}，`
      + `源失败 ${result.failures}，判定失败 ${result.evalErrors}`,
    );
    return result;
  } catch (error) {
    fatal = error;
    throw error;
  } finally {
    const completedAt = deps.clock?.() ?? now;
    completeXxyyAlertRun({
      runId, now: completedAt, requested: result.requested, covered: result.covered,
      failedBatches: result.failures, evalErrors: result.evalErrors,
      errorKind: fatal ? 'tick-failure'
        : result.failures > 0 ? 'source-failure'
          : result.evalErrors > 0 ? 'eval-failure' : null,
      errorMessage: fatal ? safeErrorMessage(fatal) : null,
    });
  }
}

/** worker 启动时调用一次，把已经影子观察过的 XXYY 价接成同源起步历史。 */
export function bootstrapXxyyAlertHistory(): { attempted: number; accepted: number } {
  return bootstrapXxyyCandlesFromShadow();
}
