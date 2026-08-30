/**
 * 异动引擎：把过滤、窗口倍数、分档状态机串起来，产出报警。
 *
 * 每轮的顺序（顺序本身是有讲究的）：
 *   1. 取所有在监控的 token（跨用户去重 —— 两人持有同一个币只算一次）
 *   2. 批量报价
 *   3. 跑过滤，更新 monitored / filter_reason / below_since_ts
 *   4. 读 5m candle，求四窗口两基准的倍数
 *   5. 对 24 个组合跑状态机；**首次见到的组合用 seed 建立，本轮不报警**
 *   6. 择优选一条，判去重窗口
 *   7. 按持有者扇出，每人一行 pump_alerts，带各自的余额与持仓价值
 *
 * 第 5 步的 seed 是关键：一个币进入监控时可能已经在 6 倍，
 * 不 seed 就会把它进来之前的涨幅补报一遍（commit 6699db0 那个坑的反向版本）。
 */
import { Decimal } from '../lib/decimal.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import { fetchBatchQuotes, type BatchQuote } from '../sources/dexscreenerBatch.ts';
import { computeMultiples } from './pumpWindows.ts';
import {
  LEVELS, seedPumpState, evaluatePump, pickWinner, suppressedByRecent,
  type PumpSnapshot, type PendingFire,
} from './pumpState.ts';
import { evaluateFilter, DEFAULT_THRESHOLDS, type FilterState } from './holdingsFilter.ts';
import { toHumanAmount } from '../sources/erc20.ts';
import { needsBackfill, backfillWalletToken, realBackfillDeps, type BackfillDeps } from './walletBackfill.ts';
import { fetchTokenInfo, type TokenInfo } from '../sources/gmgnTokenInfo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { randomUUID } from 'node:crypto';

const log = makeLogger('pump-engine');

/** 钱包币的判定间隔。比看板的 30 秒宽松，见 spec §8 的容量测算 */
export const TICK_INTERVAL_SECONDS = 120;

export interface PumpDeps {
  fetchQuotes: (chain: string, addrs: string[]) => Promise<Map<string, BatchQuote>>;
  backfill?: BackfillDeps;
  /** 取代币元信息（持有人数）。返回 null 表示查不到 */
  fetchTokenInfo?: (chain: string, address: string) => Promise<TokenInfo | null>;
}

export const realPumpDeps: PumpDeps = { fetchQuotes: fetchBatchQuotes, fetchTokenInfo };

/* ---------- pump_states 的读写。放在这里而不是 walletRepo，
              因为它只被引擎用，且是引擎语义的一部分 ---------- */

interface StateKey { tokenId: string; timeframe: string; basis: string; level: number }

function loadStates(tokenId: string): Map<string, PumpSnapshot> {
  const rows = getRawDb().prepare(
    `SELECT timeframe, basis, level, state, last_fired_at FROM pump_states WHERE token_id = ?`,
  ).all(tokenId) as Array<{ timeframe: string; basis: string; level: number; state: string; last_fired_at: number | null }>;
  const m = new Map<string, PumpSnapshot>();
  for (const r of rows) {
    m.set(`${r.timeframe}|${r.basis}|${r.level}`, {
      state: r.state === 'FIRED' ? 'FIRED' : 'ARMED',
      lastFiredAt: r.last_fired_at,
    });
  }
  return m;
}

function saveState(k: StateKey, s: PumpSnapshot): void {
  getRawDb().prepare(
    `INSERT INTO pump_states (token_id, timeframe, basis, level, state, last_fired_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id, timeframe, basis, level)
     DO UPDATE SET state = excluded.state, last_fired_at = excluded.last_fired_at`,
  ).run(k.tokenId, k.timeframe, k.basis, k.level, s.state, s.lastFiredAt);
}

/** 该币最近一次发出报警的时间，用于 30 分钟去重 */
function lastAlertAt(tokenId: string): number | null {
  const r = getRawDb().prepare(
    `SELECT MAX(fired_at) AS t FROM pump_alerts WHERE token_id = ?`,
  ).get(tokenId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/** 该币是否已在共享看板的监控列表里（那边的 candle 写入优先） */
function isWatchlistToken(tokenId: string): boolean {
  const r = getRawDb().prepare(
    `SELECT 1 AS x FROM tokens WHERE id = ? AND enabled = 1 AND visibility = 'public'`,
  ).get(tokenId) as { x: number } | undefined;
  return r !== undefined;
}

function load5mCandles(tokenId: string, sinceTs: number) {
  return getRawDb().prepare(
    `SELECT ts, o, l FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ? ORDER BY ts`,
  ).all(tokenId, sinceTs) as Array<{ ts: number; o: string | null; l: string | null }>;
}

export async function runPumpTick(now: number, deps: PumpDeps = realPumpDeps): Promise<void> {
  // 必须取**全部**持仓而不是只取已监控的：新持仓写入时 monitored=0，
  // 只看 monitored=1 会死锁 —— 过滤层永远不执行，币永远不会被提升。
  // 要判断一个币够不够格，本来就得先拿到它的流动性与成交量，也就是先取报价。
  // 成本可接受：批量接口一次 30 个地址，450 个币也只要 15 次请求。
  const tokenIds = wr.allHoldingTokenIds();
  if (tokenIds.length === 0) return;

  // 按链分组，每条链一次批量报价
  const byChain = new Map<string, string[]>();
  for (const id of tokenIds) {
    const [chain, addr] = id.split(':');
    if (!chain || !addr) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(addr);
  }

  const quotes = new Map<string, BatchQuote>();
  for (const [chain, addrs] of byChain) {
    try {
      for (const [a, q] of await deps.fetchQuotes(chain, addrs)) quotes.set(`${chain}:${a}`, q);
    } catch (err) {
      // 一条链失败不拖垮其它链；缺的地址会走"报价缺失"分支保持原状态
      log.warn(`${chain} 批量报价失败: ${safeErrorMessage(err)}`);
    }
  }

  for (const tokenId of tokenIds) {
    try {
      await evaluateToken(tokenId, quotes.get(tokenId) ?? null, now,
        deps.backfill ?? realBackfillDeps, deps.fetchTokenInfo);
    } catch (err) {
      log.warn(`${tokenId} 判定失败: ${safeErrorMessage(err)}`);
    }
  }
}

async function evaluateToken(
  tokenId: string, quote: BatchQuote | null, now: number,
  backfillDeps: BackfillDeps = realBackfillDeps,
  getInfo: PumpDeps['fetchTokenInfo'] = fetchTokenInfo,
): Promise<void> {
  const [chain, addr] = tokenId.split(':');
  let holderCount = wr.getTokenMeta(tokenId)?.holderCount ?? null;
  // ---- 过滤：每个持有者各自维护滞回状态（below_since_ts 在 holdings 上）----
  const holders = wr.usersHoldingToken(tokenId);
  const rows = holders.map((h) => ({
    h, row: wr.listHoldingsByWallet(h.walletId).find((x) => x.tokenId === tokenId),
  })).filter((x) => x.row !== undefined);

  const quoteIn = {
    liquidityUsd: quote?.liquidityUsd ?? null,
    volume24hUsd: quote?.volume24hUsd ?? null,
  };

  /**
   * 持有人数是**最后一道闸**，只对已经通过流动性/成交量的币查。
   *
   * 一开始写成对全部持仓无差别查询，线上 1206 个去重代币里 923 个待查，
   * 而元信息是串行 await 拉的，把判定轮次从 120 秒拖到了 2 分 40 秒。
   * 其中绝大多数早被流动性门槛挡掉，根本用不着知道持有人数 ——
   * 先跑前面的筛选，只有会进监控的才值得花一次 GMGN 请求。
   */
  const wouldPass = rows.some(({ h, row }) => evaluateFilter(
    { monitored: row!.monitored === 1, belowSinceTs: row!.belowSinceTs },
    quoteIn, now, DEFAULT_THRESHOLDS,
  ).monitored);

  if (wouldPass && chain && addr && getInfo && wr.isTokenMetaStale(tokenId, now)) {
    try {
      const info = await getInfo(chain, addr);
      // 查不到也写一条，避免每轮都重试同一个查不到的币
      wr.setTokenMeta(tokenId, info?.holderCount ?? null, info?.symbol ?? null, now);
      holderCount = info?.holderCount ?? null;
    } catch {
      // 限流之类的失败不影响本轮判定，下一轮再说
    }
  }

  let stillMonitored = false;
  for (const { h, row } of rows) {
    const prev: FilterState = { monitored: row!.monitored === 1, belowSinceTs: row!.belowSinceTs };
    const r = evaluateFilter(prev, { ...quoteIn, holderCount }, now, DEFAULT_THRESHOLDS);
    wr.setHoldingMonitored(h.walletId, tokenId, r.monitored, r.reason, r.belowSinceTs);
    if (r.monitored) stillMonitored = true;
  }
  if (!stillMonitored || !quote) return;

  // 报价里带着符号，第一次拿到就存下来 —— 否则页面上永远只有合约地址
  if (quote.symbol) wr.setHoldingSymbol(tokenId, quote.symbol);

  // ---- 倍数 ----
  const price = new Decimal(quote.priceUsd);
  if (!price.gt(0)) return;

  // 先把本轮价格并进当前 5m candle，历史就是这样一轮轮攒起来的。
  //
  // 但如果这个币同时在共享看板的监控列表里，轮询器已经在写同一行了 ——
  // 它 30 秒一轮、做主池选举与跨池中位数校验，数据比批量报价好。
  // 两边都写会互相覆盖 h/l 与 liquidity_total（一个是主池、一个是全池口径），
  // 让 source 列反复翻转。让位给它。
  if (!isWatchlistToken(tokenId)) {
    wr.upsertWalletCandle(tokenId, quote.priceUsd, quote.liquidityUsd, now);

    // 历史不足时补 24 小时的 5m K 线。必须在算窗口与 seed 之前做完 ——
    // 基于空历史 seed 出来的状态，等回填补上后就全错了。
    // 一个币一次 GMGN 请求（288 根 < limit 1000），失败也不影响判定
    if (needsBackfill(tokenId, now)) {
      await backfillWalletToken(tokenId, now, backfillDeps, price);
    }
  }
  const windows = computeMultiples(load5mCandles(tokenId, now - 86400 - 600), price, now);
  if (windows.length === 0) return;

  // ---- 状态机 ----
  const states = loadStates(tokenId);
  const fires: PendingFire[] = [];

  for (const w of windows) {
    for (const level of LEVELS) {
      const key = `${w.timeframe}|${w.basis}|${level}`;
      const prev = states.get(key);
      if (!prev) {
        // 首次见到这个组合：seed 而不是判定。已达标的直接置 FIRED，
        // 不为"它进入监控之前就涨过"这件事补报
        saveState({ tokenId, timeframe: w.timeframe, basis: w.basis, level },
          seedPumpState(w.multiple, level));
        continue;
      }
      const r = evaluatePump(prev, { multiple: w.multiple, level, now });
      // 无论是否被选中发出，状态一律写回 ——
      // 不写的话，去重窗口一过就会全部重放
      saveState({ tokenId, timeframe: w.timeframe, basis: w.basis, level }, r.next);
      if (r.fire) {
        fires.push({ tokenId, timeframe: w.timeframe, basis: w.basis, level, multiple: w.multiple, at: now });
      }
    }
  }

  const winner = pickWinner(fires);
  if (!winner) return;
  if (suppressedByRecent(lastAlertAt(tokenId), now)) {
    log.debug(`${tokenId} 30 分钟内已报过，压制`);
    return;
  }

  // ---- 扇出：每个持有者一行，带各自的余额与持仓价值 ----
  const base = windows.find((w) => w.timeframe === winner.timeframe && w.basis === winner.basis)?.base ?? null;
  for (const h of holders) {
    const row = wr.listHoldingsByWallet(h.walletId).find((x) => x.tokenId === tokenId);
    if (!row || row.monitored !== 1) continue;
    const amount = toHumanAmount(h.balance, h.decimals);
    wr.insertPumpAlert({
      id: randomUUID(),
      userId: h.userId,
      tokenId,
      firedAt: now,
      timeframe: winner.timeframe,
      basis: winner.basis,
      level: winner.level,
      multiple: winner.multiple.toString(),
      priceUsd: quote.priceUsd,
      basePriceUsd: base ? base.toString() : null,
      balance: h.balance,
      valueUsd: amount ? amount.mul(price).toString() : null,
      ackedAt: null,
    });
  }
  log.info(`${tokenId} 暴涨 ${winner.multiple.toFixed(2)}x (${winner.timeframe}/${winner.basis}, ${winner.level}x 档)，通知 ${holders.length} 人`);
}
