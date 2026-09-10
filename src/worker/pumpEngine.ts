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
import { scaleMarketCap } from '../sources/quotePrice.ts';
import {
  fetchXxyyPrices, normalizeMint, supportsChain as xxyySupportsChain,
  type XxyyQuote,
} from '../sources/xxyy.ts';
import { compareQuotes, judge, PRICE_TOLERANCE, type HealthVerdict } from './sourceAgreement.ts';
import { recordVerdict } from './sourceWatch.ts';
import * as athRepo from '../db/athRepo.ts';
import {
  BREAKOUT_MARGIN, REARM_RATIO, ADVANCE_RATIO as ATH_ADVANCE_RATIO,
} from './athState.ts';
import {
  ATH_WINDOWS, largestBrokenWindow, windowRank, describeWindow,
} from './athWindows.ts';
import { windowHighs, historyStart } from '../db/athDailyRepo.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import * as pumpHealth from '../db/pumpHealthRepo.ts';
import { pruneQuoteShadow, recordQuoteShadows } from '../db/quoteShadowRepo.ts';
import {
  fetchBatchQuotes, fetchBatchQuotesDetailed, type BatchQuote, type BatchQuotesDetailedResult,
  type QuoteBatchFailure,
} from '../sources/dexscreenerBatch.ts';
import {
  computeMultiples, WINDOW_SECONDS, type PumpTimeframe, type PumpBasis,
} from './pumpWindows.ts';
import {
  LEVELS, seedPumpState, evaluatePump, pickWinner, suppressedByRecent,
  shouldFireOnAdvance, DEDUP_WINDOW_SECONDS, ADVANCE_RATIO,
  type PumpSnapshot, type PendingFire, type RecentAlert,
} from './pumpState.ts';
import { evaluateFilter, DEFAULT_THRESHOLDS, type FilterState } from './holdingsFilter.ts';
import { isWakeUp, wakeUpLevel } from './wakeUp.ts';
import { toHumanAmount } from '../sources/erc20.ts';
import { needsBackfill, backfillWalletToken, realBackfillDeps, type BackfillDeps } from './walletBackfill.ts';
import {
  fetchTokenInfo, SOURCE_ID as GMGN_INFO_SOURCE_ID, type TokenInfo,
} from '../sources/gmgnTokenInfo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { align5m, nowSec } from '../lib/time.ts';
import { randomUUID } from 'node:crypto';
import { decideQuote } from './quoteDecision.ts';
import PQueue from 'p-queue';

const log = makeLogger('pump-engine');

/**
 * 钱包币的判定间隔。
 *
 * 从 120 秒缩到 60 秒 —— 直接砍掉一半的最坏发现延迟。原先一个币在
 * 某轮刚结束后暴涨，最久要等 120 秒才被看见。
 *
 * 2026-09-03 实测的成本：一轮 214 个币按链分组后**只发 9 个请求**
 * （批量接口一次 30 个地址），耗时约 4 秒。也就是 120 秒的周期里
 * 96% 是闲着的，缩到 60 秒也才占 7%。
 *
 * 被流动性挡掉的四千多个粉尘币不受影响：它们的复查是**按时间**判的
 * （token_meta.last_eval_at + 30 分钟），不是按轮次，提频只会让它们
 * 摊得更薄，总请求量不变。
 *
 * **为什么不顺势加 1 分钟窗口**：上游数据撑不住。同一批币每 15 秒采
 * 一次连采 3 分钟，robinhood 有 37%、bsc 有 30% 的币价格纹丝不动，
 * 最活跃的也只是每 36 秒变一次 —— 两条链都是 0/30 具备分钟级分辨率。
 * 硬加的话，窗口标签写着「1分」算的却是 90 秒的涨幅，而且 1 分钟窗口
 * 里只有一两根 candle，kthLowest 的离群值剔除会失效，等于把之前修好的
 * 假报警漏洞重新打开。
 */
export const TICK_INTERVAL_SECONDS = 60;
/**
 * 每轮在全部热币之外最多发现这么多后台币。
 *
 * 900 个约 30 个 DexScreener 批次；热币先独立跑完，后台源即使变慢也不会
 * 把同一轮的关键报警压到几千个冷币之后。按当前约一万币，冷队列约 11 轮
 * 覆盖一次；温币排在冷币前，仍可维持约 3 分钟复查。
 */
export const PUMP_BACKGROUND_TOKEN_BUDGET = 900;

export interface PumpTokenStages {
  hot: string[];
  background: string[];
}

/** 纯函数单测锁住关键不变量：热币不限量、后台才受预算约束。 */
export function selectPumpTokenStages(
  dueTokenIds: readonly string[], monitoredTokenIds: ReadonlySet<string>,
  backgroundBudget = PUMP_BACKGROUND_TOKEN_BUDGET,
): PumpTokenStages {
  const hot: string[] = [];
  const background: string[] = [];
  const bounded = Math.max(0, Math.floor(backgroundBudget));
  for (const tokenId of dueTokenIds) {
    if (monitoredTokenIds.has(tokenId)) hot.push(tokenId);
    else if (background.length < bounded) background.push(tokenId);
  }
  return { hot, background };
}

/**
 * 持仓价值低于这个数就不推送 —— **每人可以自己改**，这里只是没设过时的默认值。
 *
 * 只值几毛钱的币涨十倍也还是几块钱，为它响一次的代价大于收益。
 * 注意这不是过滤层的门槛：币仍然被监控、涨幅照常算，
 * 只是不吵醒你。过滤层管的是"这个币值不值得看"，
 * 这里管的是"这次上涨值不值得打断你"。
 *
 * 之所以是每人一个值而不是全局常量：同一个币，你只有几毛钱、
 * 别人有几千块，该不该吵醒你们的答案不一样。9-03 的数字：同一天
 * 同一套报警，pananiu 72 条里 52 条超过 $50，nori 114 条里只有 28 条。
 */
export const MIN_ALERT_VALUE_USD = 1;
export const WATCHLIST_QUOTE_TTL_SECONDS = 120;

export interface PumpDeps {
  fetchQuotes: (chain: string, addrs: string[]) => Promise<Map<string, BatchQuote>>;
  /** 生产环境使用详细接口，以批次失败与有效覆盖计算真实健康状态。 */
  fetchQuotesDetailed?: (chain: string, addrs: string[]) => Promise<BatchQuotesDetailedResult>;
  backfill?: BackfillDeps;
  /** 取代币元信息（持有人数）。返回 null 表示查不到 */
  fetchTokenInfo?: (chain: string, address: string) => Promise<TokenInfo | null>;
  /**
   * XXYY 候选报价源。候选价只有通过 DexScreener 同轮确认才会被采用。
   * 传 null 表示关闭 —— 单元测试默认关闭，避免真的请求外部接口。
   */
  fetchCandidatePrices?: typeof fetchXxyyPrices | null;
  /** 生产环境用实际评估时间；测试省略时沿用 runPumpTick 传入的确定时刻。 */
  clock?: () => number;
  /** 生产把持有人元数据与历史回填放入有界后台队列；测试默认仍同步等待。 */
  deferSlowTasks?: boolean;
  /** 生产慢轮次只负责 DS 资格/元数据；正式报警由 15 秒 XXYY 独立循环负责。 */
  evaluateAlerts?: boolean;
}

export const realPumpDeps: PumpDeps = {
  fetchQuotes: fetchBatchQuotes,
  fetchQuotesDetailed: fetchBatchQuotesDetailed,
  fetchCandidatePrices: null,
  fetchTokenInfo,
  clock: nowSec,
  deferSlowTasks: true,
  evaluateAlerts: false,
};

function isTechnicalQuoteFailure(f: QuoteBatchFailure): boolean {
  return f.kind !== 'empty_response' && f.kind !== 'partial_response';
}

/** HTTP 200 空数组通常只是无池粉尘；其它失败（含部分缺失）应短退避重试。 */
function isRetryableQuoteFailure(f: QuoteBatchFailure): boolean {
  return f.kind !== 'empty_response';
}

// 上游额度是按请求数算的；压到 60/min，给其它 GMGN 路径留余量。
const metadataQueue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
const backfillQueue = new PQueue({ concurrency: 2 });
const pendingMetadata = new Set<string>();
const metadataRetryAfter = new Map<string, number>();
const pendingBackfills = new Set<string>();
const completedBackfills = new Set<string>();

function deferMetadata(
  tokenId: string, chain: string, address: string, now: number,
  getInfo: NonNullable<PumpDeps['fetchTokenInfo']>,
): void {
  if (pendingMetadata.has(tokenId)) return;
  if ((metadataRetryAfter.get(tokenId) ?? 0) > now) return;
  pendingMetadata.add(tokenId);
  void metadataQueue.add(async () => {
    try {
      const info = await getInfo(chain, address);
      wr.setTokenMeta(tokenId, info?.holderCount ?? null, info?.symbol ?? null, now);
      metadataRetryAfter.delete(tokenId);
      recordVerdict(GMGN_INFO_SOURCE_ID, { ok: true, reason: null }, now, '元数据请求成功');
    } catch (err) {
      metadataRetryAfter.set(tokenId, now + 300);
      recordVerdict(
        GMGN_INFO_SOURCE_ID, { ok: false, reason: safeErrorMessage(err) }, now,
        `${chain} 元数据刷新失败`,
      );
      log.warn(`${tokenId} 后台元数据刷新失败: ${safeErrorMessage(err)}`);
    } finally {
      pendingMetadata.delete(tokenId);
    }
  }).catch((err) => {
    pendingMetadata.delete(tokenId);
    log.warn(`${tokenId} 元数据队列失败: ${safeErrorMessage(err)}`);
  });
}

function deferBackfill(
  tokenId: string, now: number, deps: BackfillDeps, livePrice: Decimal,
): void {
  if (pendingBackfills.has(tokenId)) return;
  pendingBackfills.add(tokenId);
  void backfillQueue.add(async () => {
    try {
      await backfillWalletToken(tokenId, now, deps, livePrice);
    } catch (err) {
      log.warn(`${tokenId} 后台历史回填失败: ${safeErrorMessage(err)}`);
    } finally {
      pendingBackfills.delete(tokenId);
      // 下一轮可以基于回填结果（即使上游明确返回空）继续；绝不在任务未完成时 seed。
      completedBackfills.add(tokenId);
    }
  }).catch((err) => {
    pendingBackfills.delete(tokenId);
    completedBackfills.add(tokenId);
    log.warn(`${tokenId} 回填队列失败: ${safeErrorMessage(err)}`);
  });
}

/** 测试与优雅停机可显式等待后台慢任务；正常报价轮次不等待。 */
export async function waitForPumpSlowTasks(): Promise<void> {
  await Promise.all([metadataQueue.onIdle(), backfillQueue.onIdle()]);
}

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
/**
 * 去重窗口内这个币报过的最后时刻与**最高档位**。
 *
 * 只取窗口内的行来算最高档：拿全表的 MAX(level) 会让一个月前报过 10 倍的币
 * 从此再也报不出 10 倍以下的任何东西。
 */
/**
 * 窗口内已经报过什么。
 *
 * 价格**不能用 SQL 的 MAX()**：price_usd 存的是十进制字符串，MAX 会按
 * 字典序比 —— '0.009' 会被判成大于 '0.01'。取回来用 Decimal 比。
 * 窗口只有 30 分钟、单个币，行数很少，多取几行不值一提。
 */
/**
 * 补报时用哪个窗口来描述这次上涨。规则与 pickWinner 一致：
 * 倍数最高，相同则窗口最短（5 分钟涨 2 倍比 24 小时涨 2 倍更值得说）。
 */
function pickBestWindow(
  windows: Array<{ timeframe: PumpTimeframe; basis: PumpBasis; multiple: Decimal }>,
  now: number,
): PendingFire | null {
  let best: typeof windows[number] | null = null;
  for (const w of windows) {
    if (!best) { best = w; continue; }
    const c = w.multiple.comparedTo(best.multiple);
    if (c > 0 || (c === 0 && WINDOW_SECONDS[w.timeframe] < WINDOW_SECONDS[best.timeframe])) best = w;
  }
  if (!best) return null;
  return {
    tokenId: '', timeframe: best.timeframe, basis: best.basis,
    level: 0, multiple: best.multiple, at: now,
  };
}

function recentAlert(tokenId: string, now: number): RecentAlert | null {
  const rows = getRawDb().prepare(
    `SELECT fired_at, level, price_usd FROM pump_alerts
     WHERE token_id = ? AND fired_at >= ?
       AND (kind IS NULL OR kind IN ('level', 'advance', 'pump-ath'))`,
  ).all(tokenId, now - DEDUP_WINDOW_SECONDS) as
    Array<{ fired_at: number; level: number; price_usd: string | null }>;
  if (rows.length === 0) return null;

  let at = 0, level = 0, maxPrice = new Decimal(0);
  for (const r of rows) {
    if (r.fired_at > at) at = r.fired_at;
    if (r.level > level) level = r.level;
    if (r.price_usd) {
      const p = new Decimal(r.price_usd);
      if (p.gt(maxPrice)) maxPrice = p;
    }
  }
  return { at, level, maxPrice };
}

type WatchlistQuote =
  | { kind: 'wallet' }
  | { kind: 'ready'; price: Decimal; fetchedAt: number }
  | { kind: 'paused'; reason: string };

/**
 * 看板币只能沿用看板流水线的同口径价格；冻结、失联、未来时间或 K 线没有
 * 跟上最后成功报价时，本轮明确暂停，不能静默拿钱包批量价接在看板历史后面。
 */
function watchlistQuote(tokenId: string, evaluatedAt: number): WatchlistQuote {
  const token = getRawDb().prepare(
    `SELECT frozen, last_quote_at, last_source
       FROM tokens WHERE id = ? AND enabled = 1 AND visibility = 'public'`,
  ).get(tokenId) as {
    frozen: number; last_quote_at: number | null; last_source: string | null;
  } | undefined;
  if (!token) return { kind: 'wallet' };
  if (token.frozen !== 0) return { kind: 'paused', reason: '共享看板已冻结' };
  if (token.last_quote_at === null || !token.last_source) {
    return { kind: 'paused', reason: '共享看板尚无成功报价' };
  }
  if (token.last_quote_at > evaluatedAt + TICK_INTERVAL_SECONDS) {
    return { kind: 'paused', reason: '共享看板报价时间在未来，时钟异常' };
  }
  const age = evaluatedAt - token.last_quote_at;
  if (age > WATCHLIST_QUOTE_TTL_SECONDS) {
    return { kind: 'paused', reason: `共享看板报价已陈旧 ${age} 秒` };
  }

  const candle = getRawDb().prepare(
    `SELECT ts, c, source FROM candles
       WHERE token_id = ? AND timeframe = '5m' AND c IS NOT NULL
       ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId) as { ts: number; c: string; source: string | null } | undefined;
  if (!candle || candle.ts !== align5m(token.last_quote_at)) {
    return { kind: 'paused', reason: '共享看板 K 线未跟上最后成功报价' };
  }
  if (candle.source !== token.last_source) {
    return { kind: 'paused', reason: '共享看板报价与 K 线来源不一致' };
  }
  try {
    const price = new Decimal(candle.c);
    if (!price.isFinite() || price.lte(0)) {
      return { kind: 'paused', reason: '共享看板价格不是有限正数' };
    }
    return { kind: 'ready', price, fetchedAt: token.last_quote_at };
  } catch {
    return { kind: 'paused', reason: '共享看板价格格式无效' };
  }
}

function load5mCandles(tokenId: string, sinceTs: number) {
  return getRawDb().prepare(
    `SELECT ts, o, l FROM candles WHERE token_id = ? AND timeframe = '5m' AND ts >= ? ORDER BY ts`,
  ).all(tokenId, sinceTs) as Array<{ ts: number; o: string | null; l: string | null }>;
}

function noteQuoteMissing(tokenId: string): void {
  for (const holder of wr.usersHoldingToken(tokenId)) {
    const row = wr.getHolding(holder.walletId, tokenId);
    if (!row) continue;
    wr.setHoldingMonitored(
      holder.walletId, tokenId, row.monitored === 1,
      '报价缺失，判定暂缓', row.belowSinceTs,
    );
  }
}

export async function runPumpTick(now: number, deps: PumpDeps = realPumpDeps): Promise<void> {
  // 必须取**全部**持仓而不是只取已监控的：新持仓写入时 monitored=0，
  // 只看 monitored=1 会死锁 —— 过滤层永远不执行，币永远不会被提升。
  // 要判断一个币够不够格，本来就得先拿到它的流动性与成交量，也就是先取报价。
  // 成本可接受：批量接口一次 30 个地址，450 个币也只要 15 次请求。
  // 监控中的每轮都判；已被挡掉的每 30 分钟重查一次 ——
  // 一千多个粉尘币每轮都拉报价，光请求就占掉 20 秒
  const monitored = new Set(wr.monitoredTokenIds());
  const stages = selectPumpTokenStages(wr.tokenIdsDueForEval(now), monitored);
  const tokenIds = [...stages.hot, ...stages.background];
  const runId = now;
  pumpHealth.beginPumpRun(runId, now, tokenIds.length);
  let totalCovered = 0;
  let failedBatches = 0;
  let evalErrors = 0;
  let fatalMessage: string | null = null;

  try {
    if (tokenIds.length === 0) return;

  // 按链分组，每条链一次批量报价
  const byChain = new Map<string, string[]>();
  for (const id of tokenIds) {
    const [chain, addr] = id.split(':');
    if (!chain || !addr) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(addr);
  }

  const t0 = Date.now();
  wr.markTokensAttempted(tokenIds, now);
  const quotes = new Map<string, BatchQuote>();
  const xxyyRound: XxyyRound = { quotes: new Map(), failures: new Map() };
  const priority = new Map(tokenIds.map((id, i) => [id, tokenIds.length - i]));
  const evalQueue = new PQueue({ concurrency: 8 });

  interface ChainHealth {
    requested: number;
    covered: number;
    technicalFailures: number;
    missingMonitored: number;
    criticalRequested: number;
    messages: string[];
  }
  const chainHealth = new Map<string, ChainHealth>();

  // 第一段只跑全部热币并完成判定，第二段才跑有上限的后台发现。这样同一条链
  // 的冷币批次、超时或空响应都不能排在关键报警前面。
  for (const stageTokenIds of [stages.hot, stages.background]) {
    const stageByChain = new Map<string, string[]>();
    for (const id of stageTokenIds) {
      const [chain, addr] = id.split(':');
      if (!chain || !addr) continue;
      (stageByChain.get(chain) ?? stageByChain.set(chain, []).get(chain)!).push(addr);
    }

    // 每条链各自等本链的 DS + XXYY；快链拿到结果后立即进入判定队列，
    // 不再等其它慢链。单币的元数据/回填在生产又由更小的后台队列承接。
    const chainTasks = [...stageByChain].map(async ([chain, addrs]) => {
    const candidatePromise = deps.fetchCandidatePrices === null
      ? Promise.resolve<XxyyRound>({ quotes: new Map(), failures: new Map() })
      : fetchXxyyRound(
        new Map([[chain, addrs]]),
        deps.fetchCandidatePrices ?? fetchXxyyPrices,
      );

    let covered = 0;
    let technicalFailures = 0;
    let missingMonitored = 0;
    let healthMessage: string | null = null;
    let result: BatchQuotesDetailedResult;
    try {
      result = deps.fetchQuotesDetailed
        ? await deps.fetchQuotesDetailed(chain, addrs)
        : { quotes: await deps.fetchQuotes(chain, addrs), failures: [] };
      covered = result.quotes.size;
      technicalFailures = result.failures.filter(isTechnicalQuoteFailure).length;
      missingMonitored = result.failures.reduce((count, failure) => count
        + failure.addresses.filter((address) =>
          monitored.has(`${chain}:${normalizeMint(chain, address)}`)).length, 0);
      if (technicalFailures > 0) {
        healthMessage = `${technicalFailures} 个报价批次发生技术失败`;
      } else if (missingMonitored > 0) {
        healthMessage = `${missingMonitored} 个监控中代币缺少有效报价`;
      }
    } catch (err) {
      // 一条链失败不拖垮其它链；缺的地址会走"报价缺失"分支保持原状态
      healthMessage = safeErrorMessage(err);
      technicalFailures = 1;
      log.warn(`${chain} 批量报价失败: ${healthMessage}`);
      result = {
        quotes: new Map(),
        failures: [{ addresses: [...addrs], kind: 'network', reason: healthMessage }],
      };
    }
    const chainQuotes = new Map<string, BatchQuote>();
    for (const [address, quote] of result.quotes) {
      const key = `${chain}:${normalizeMint(chain, address)}`;
      chainQuotes.set(key, quote);
      quotes.set(key, quote);
    }

    const currentHealth = chainHealth.get(chain) ?? {
      requested: 0, covered: 0, technicalFailures: 0, missingMonitored: 0,
      criticalRequested: 0, messages: [],
    };
    currentHealth.requested += addrs.length;
    currentHealth.covered += covered;
    currentHealth.technicalFailures += technicalFailures;
    currentHealth.missingMonitored += missingMonitored;
    currentHealth.criticalRequested += addrs.filter((a) =>
      monitored.has(`${chain}:${normalizeMint(chain, a)}`)).length;
    if (healthMessage) currentHealth.messages.push(healthMessage);
    chainHealth.set(chain, currentHealth);
    totalCovered += covered;
    failedBatches += technicalFailures;

    const chainXxyy = await candidatePromise;
    for (const [key, quote] of chainXxyy.quotes) xxyyRound.quotes.set(key, quote);
    for (const [key, message] of chainXxyy.failures) xxyyRound.failures.set(key, message);

    // 正式采用仍要求本链整体健康；一条慢/坏链不再让其它链放弃已确认候选价。
    let localXxyyHealthy = false;
    if (deps.fetchCandidatePrices !== null && xxyySupportsChain(chain)
        && !chainXxyy.failures.has(chain) && chainQuotes.size > 0) {
      const report = compareQuotes(chainQuotes, chainXxyy.quotes);
      localXxyyHealthy = judge(report, chainQuotes.size).ok;
    }
    const effectiveQuotes = deps.fetchCandidatePrices === null
      ? chainQuotes
      : applyGuardedXxyy(chainQuotes, chainXxyy.quotes, localXxyyHealthy);

    const chainTokenIds = addrs.map((address) => `${chain}:${normalizeMint(chain, address)}`);
    try {
      recordQuoteShadows(chainTokenIds.flatMap((tokenId) => {
        const ds = chainQuotes.get(tokenId) ?? null;
        const xxyy = chainXxyy.quotes.get(tokenId) ?? null;
        // 两边都没有数据的冷币不提供任何审计价值，只会让数据库膨胀。
        if (!ds && !xxyy) return [];
        const observedAt = Math.max(ds?.fetchedAt ?? now, xxyy?.fetchedAt ?? now);
        return [{
          tokenId, observedAt, ds, xxyy,
          decision: decideQuote(ds, xxyy, localXxyyHealthy),
        }];
      }));
    } catch (err) {
      log.warn(`${chain} 影子报价批量落库失败: ${safeErrorMessage(err)}`);
    }

    const retryIds = new Set<string>();
    for (const failure of result.failures) {
      if (!isRetryableQuoteFailure(failure)) continue;
      for (const address of failure.addresses) {
        retryIds.add(`${chain}:${normalizeMint(chain, address)}`);
      }
    }

    const evaluations = chainTokenIds.map((tokenId) => {
      const quote = effectiveQuotes.get(tokenId) ?? null;
      if (!quote) {
        noteQuoteMissing(tokenId);
        if (retryIds.has(tokenId)) wr.markTokenEvaluationFailed(tokenId, deps.clock?.() ?? now);
        else wr.markTokenCheckedWithoutQuote(tokenId, deps.clock?.() ?? now);
        return Promise.resolve();
      }

      const quotedAt = deps.clock?.() ?? now;
      wr.markTokenQuoteSucceeded(tokenId, quotedAt, quote.liquidityUsd);
      return evalQueue.add(async () => {
        const evaluatedAt = deps.clock?.() ?? now;
        try {
          const outcome = await evaluateToken(
            tokenId, quote, evaluatedAt,
            deps.backfill ?? realBackfillDeps, deps.fetchTokenInfo,
            deps.deferSlowTasks ?? false, deps.evaluateAlerts ?? true,
          );
          if (outcome.status === 'ok') {
            wr.markTokenEvaluated(tokenId, evaluatedAt, quote.liquidityUsd);
          } else {
            if (outcome.status === 'failed') evalErrors++;
            wr.markTokenEvaluationFailed(tokenId, evaluatedAt);
            log.debug(`${tokenId} 判定${outcome.status === 'failed' ? '失败' : '延后'}: ${outcome.reason}`);
          }
        } catch (err) {
          evalErrors++;
          wr.markTokenEvaluationFailed(tokenId, evaluatedAt);
          log.warn(`${tokenId} 判定失败: ${safeErrorMessage(err)}`);
        }
      }, { priority: priority.get(tokenId) ?? 0 }).then(() => undefined);
    });
    await Promise.all(evaluations);
    });

    await Promise.all(chainTasks);
  }

  for (const [chain] of byChain) {
    const health = chainHealth.get(chain) ?? {
      requested: 0, covered: 0, technicalFailures: 0, missingMonitored: 0,
      criticalRequested: 0, messages: [],
    };
    const errorKind = health.technicalFailures > 0
      ? 'batch-failure'
      : health.missingMonitored > 0 ? 'missing-monitored-quote'
      : health.covered === 0 && health.criticalRequested > 0 ? 'no-valid-price' : null;
    const healthMessage = [...new Set(health.messages)].join('；') || null;
    pumpHealth.recordQuoteHealth({
      runId, chain, now: deps.clock?.() ?? now, requested: health.requested,
      covered: health.covered, failedBatches: health.technicalFailures, errorKind,
      errorMessage: healthMessage ?? (errorKind === 'no-valid-price'
        ? `${health.criticalRequested} 个监控中代币全部缺少有效报价` : null),
    });
    recordVerdict(
      `dexscreener:${chain}`,
      errorKind
        ? { ok: false, reason: healthMessage ?? '监控中代币无有效报价' }
        : { ok: true, reason: null },
      deps.clock?.() ?? now,
      `请求 ${health.requested}，有效 ${health.covered}，技术失败批次 ${health.technicalFailures}`,
    );
  }
  const parallelMs = Date.now() - t0;
  if (deps.fetchCandidatePrices !== null) assessXxyy(byChain, quotes, xxyyRound, now);

  // 每小时清一次七天前的观察。条件使用轮次时间，重启后也无需额外定时器。
  if (now % 3600 < TICK_INTERVAL_SECONDS) {
    try { pruneQuoteShadow(now); }
    catch (err) { log.warn(`清理旧影子报价失败: ${safeErrorMessage(err)}`); }
  }

  /**
   * 轮次耗时的分段账。
   *
   * 加这个是因为吃过亏：轮次超时的时候连着猜了两次瓶颈都猜错了
   * （先怪批量请求，又怪持仓查询），改完才发现真正的大头是回填重试。
   * 有分段数字就不用猜。超预算才打 INFO，正常时打 DEBUG，不刷屏。
   */
  const totalMs = Date.now() - t0;
  const line = `轮次 ${tokenIds.length} 个币：${byChain.size} 条链并行报价与判定 `
    + `${(parallelMs / 1000).toFixed(1)}s，共 ${(totalMs / 1000).toFixed(1)}s`;
  if (totalMs > TICK_INTERVAL_SECONDS * 1000) log.info(`${line} —— 超出 ${TICK_INTERVAL_SECONDS}s 预算`);
  else log.debug(line);
  } catch (err) {
    fatalMessage = safeErrorMessage(err);
    throw err;
  } finally {
    const completedAt = deps.clock?.() ?? now;
    pumpHealth.completePumpRun({
      runId, now: completedAt, requested: tokenIds.length, covered: totalCovered,
      failedBatches, evalErrors,
      errorKind: fatalMessage ? 'fatal' : failedBatches > 0 ? 'quote-degraded'
        : evalErrors > 0 ? 'eval-errors' : null,
      errorMessage: fatalMessage,
    });
  }
}

type TokenEvalOutcome =
  | { status: 'ok' }
  | { status: 'deferred'; reason: string }
  | { status: 'failed'; reason: string };

async function evaluateToken(
  tokenId: string, quote: BatchQuote | null, now: number,
  backfillDeps: BackfillDeps = realBackfillDeps,
  getInfo: PumpDeps['fetchTokenInfo'] = fetchTokenInfo,
  deferSlowTasks = false,
  evaluateAlerts = true,
): Promise<TokenEvalOutcome> {
  const [chain, addr] = tokenId.split(':');
  const cachedMeta = wr.getTokenMeta(tokenId);
  let holderCount = cachedMeta?.holderCount ?? null;
  // ---- 过滤：每个持有者各自维护滞回状态（below_since_ts 在 holdings 上）----
  const holders = wr.usersHoldingToken(tokenId);
  const rows = holders.map((h) => ({
    h, row: wr.getHolding(h.walletId, tokenId),
  })).filter((x) => x.row !== undefined);

  const quoteIn = {
    liquidityUsd: quote?.liquidityUsd ?? null,
    volume24hUsd: quote?.volume24hUsd ?? null,
    volume1hUsd: quote?.volume1hUsd ?? null,
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
    if (deferSlowTasks) {
      deferMetadata(tokenId, chain, addr, now, getInfo);
    } else {
      try {
        const info = await getInfo(chain, addr);
        // 查不到也写一条，避免每轮都重试同一个查不到的币
        wr.setTokenMeta(tokenId, info?.holderCount ?? null, info?.symbol ?? null, now);
        holderCount = info?.holderCount ?? null;
      } catch {
        // 限流之类的失败不影响本轮判定，下一轮再说
      }
    }
  }

  let stillMonitored = false;
  for (const { h, row } of rows) {
    const prev: FilterState = { monitored: row!.monitored === 1, belowSinceTs: row!.belowSinceTs };
    const r = evaluateFilter(prev, { ...quoteIn, holderCount }, now, DEFAULT_THRESHOLDS);
    wr.setHoldingMonitored(h.walletId, tokenId, r.monitored, r.reason, r.belowSinceTs);
    if (r.monitored) stillMonitored = true;
  }
  if (!stillMonitored || !quote) return { status: 'ok' };
  // 元数据只是附加的空投盘筛选，不能挡住价格主链路。首次缓存尚未回来时
  // 先按流动性/成交量继续；结果到达后下一轮会自动补上持有人数判定。

  // 报价里带着符号，第一次拿到就存下来 —— 否则页面上永远只有合约地址
  if (quote.symbol) wr.setHoldingSymbol(tokenId, quote.symbol);
  // 官网 / 推特 / 电报也是这个响应白送的，存下来给页面上的跳转按钮用
  wr.setTokenLinks(tokenId, now, quote);

  // 正式环境的报警已拆到独立 XXYY 快循环。本轮仍更新 monitored、符号、
  // 链接与过滤水位，但绝不能再写混合源 K 线或生成 DS 报警。
  if (!evaluateAlerts) return { status: 'ok' };

  // ---- 倍数 ----
  const boardQuote = watchlistQuote(tokenId, now);
  const fromWatchlist = boardQuote.kind !== 'wallet';
  if (boardQuote.kind === 'paused') {
    log.warn(`${tokenId} 钱包行情判定暂停：${boardQuote.reason}`);
    return { status: 'deferred', reason: boardQuote.reason };
  }
  /**
   * 这个币的 K 线如果是**共享看板**那条流水线写的，判定就得用它的价，
   * 不能用我们自己的批量报价。
   *
   * 两边的口径不一样：看板做主池选举、跨池中位数并剔除离群池；
   * 批量接口只回一个池、不做任何剔除。2026-09-05 的 Monkey 就栽在这里 ——
   * 看板明确把那个 XAUt 池当离群剔掉了（中位价 2.0e-25），而批量接口
   * 回的**恰恰就是那个池**（5.9e-21）。拿它去比看板写的历史低点，
   * 算出「暴涨 34852 倍」。
   *
   * 不用"幅度超过 N 倍就拦"那种守卫：真实的币一轮内涨 11 倍完全可能，
   * 而那正是这个工具要抓的事，拦掉比误报更糟。问题的本质不是幅度大，
   * 是**两个数不是同一种测量**，所以只在跨流水线时换用对方的价。
   */
  let price: Decimal;
  let quoteFetchedAt = quote.fetchedAt ?? now;
  try {
    price = new Decimal(quote.priceUsd);
  } catch {
    log.warn(`${tokenId} 报价隔离：价格不是合法十进制数`);
    return { status: 'failed', reason: '价格不是合法十进制数' };
  }
  if (!price.isFinite() || price.lte(0)) {
    log.warn(`${tokenId} 报价隔离：价格不是有限正数`);
    return { status: 'failed', reason: '价格不是有限正数' };
  }
  if (boardQuote.kind === 'ready') {
    if (Decimal.max(price.div(boardQuote.price), boardQuote.price.div(price)).gt(2)) {
      log.debug(
        `${tokenId} 在看板上，改用看板价 ${boardQuote.price.toString()}`
        + `（批量报价 ${quote.priceUsd}）`,
      );
    }
    price = boardQuote.price;
    quoteFetchedAt = boardQuote.fetchedAt;
  }
  /**
   * 市值跟着实际用的价走。看板的价来自跨池中位数，而批量报价的市值
   * 来自它自己那个池 —— 不换算的话两个数会互相矛盾（Monkey 的离群池
   * 报市值 $5,054 万，正常池 $142 万，差 36 倍）。
   */
  const marketCapUsd = scaleMarketCap(quote.marketCapUsd, quote.priceUsd, price.toString());
  if (!price.isFinite() || price.lte(0)) return { status: 'failed', reason: '实际判定价无效' };

  // 先把本轮价格并进当前 5m candle，历史就是这样一轮轮攒起来的。
  //
  // 但如果这个币同时在共享看板的监控列表里，轮询器已经在写同一行了 ——
  // 它 30 秒一轮、做主池选举与跨池中位数校验，数据比批量报价好。
  // 两边都写会互相覆盖 h/l 与 liquidity_total（一个是主池、一个是全池口径），
  // 让 source 列反复翻转。让位给它。
  if (!fromWatchlist) {
    const candleSource = quote.priceSource === 'xxyy'
      ? 'wallet-xxyy' : quote.priceSource === 'dexscreener'
        ? 'wallet-dexscreener' : 'wallet-batch';
    const candleWrite = wr.upsertWalletCandle(
      tokenId, quote.priceUsd, quote.liquidityUsd, now, marketCapUsd, candleSource,
    );
    if (candleWrite.status === 'quarantined') {
      log.warn(`${tokenId} 报价隔离：${candleWrite.reason}`);
      return { status: 'failed', reason: candleWrite.reason };
    }

    /**
     * 历史不足时补 24 小时的 5m K 线。必须在算窗口与 seed 之前做完 ——
     * 基于空历史 seed 出来的状态，等回填补上后就全错了。
     *
     * 加冷却是因为 needsBackfill 对**稀疏的币永远为真**：它要求 24 小时内
     * 有 144 根 candle，而上游对没成交的币根本给不出这么多。线上 296 个
     * 监控中的币里有 52 个天天如此，每轮都白打一次串行的 GMGN 请求
     * （限速 80/分钟），占掉判定轮次一半以上的时间。
     *
     * 首次不受冷却影响 —— 新进监控的币立刻回填，FLETCH 那种情况正需要。
     */
    if (needsBackfill(tokenId, now) && wr.shouldTryBackfill(tokenId, now)) {
      wr.markBackfillAttempted(tokenId, now);      // 先记再打：失败的也要计入冷却
      if (deferSlowTasks) {
        deferBackfill(tokenId, now, backfillDeps, price);
        return { status: 'deferred', reason: '历史回填进行中' };
      }
      await backfillWalletToken(tokenId, now, backfillDeps, price);
    } else if (deferSlowTasks && pendingBackfills.has(tokenId)) {
      return { status: 'deferred', reason: '历史回填进行中' };
    } else if (deferSlowTasks && completedBackfills.has(tokenId)) {
      completedBackfills.delete(tokenId);
    }
  }
  const windows = computeMultiples(load5mCandles(tokenId, now - 86400 - 600), price, now);
  if (windows.length === 0) return { status: 'deferred', reason: '尚未建立有效窗口基准' };

  /**
   * 从状态机开始到所有用户的报警行，必须是一个原子决定。
   * 以前先把状态写成 FIRED，再逐个 INSERT pump_alerts；第二个人写入失败时，
   * 第一个人有记录、第二个人没有，而状态已经阻止重试，形成永久漏报。
   * 这里没有网络 I/O，只有本地 SQLite 读写，适合放进一个短事务。
   */
  const persistDecision = getRawDb().transaction((): PersistedAlert | null => {
    const states = loadStates(tokenId);
    const fires: PendingFire[] = [];

    /**
     * 冷启动时该不该补一条"它已经涨了多少"。
     * 一刀切地静默对新加钱包是对的，但沉睡的币醒来时应该补报。
     */
    const earliestSeen = holders.length > 0
      ? Math.min(...holders.map((h) => h.firstSeenAt))
      : null;
    const wokeUp = isWakeUp(earliestSeen, now);

    for (const w of windows) {
      for (const level of LEVELS) {
        const key = `${w.timeframe}|${w.basis}|${level}`;
        const prev = states.get(key);
        if (!prev) {
          saveState({ tokenId, timeframe: w.timeframe, basis: w.basis, level },
            seedPumpState(w.multiple, level));
          if (wokeUp && wakeUpLevel(w.multiple, LEVELS) === level) {
            fires.push({ tokenId, timeframe: w.timeframe, basis: w.basis, level,
              multiple: w.multiple, at: now });
          }
          continue;
        }
        const r = evaluatePump(prev, { multiple: w.multiple, level, now });
        // 无论是否被选中发出，状态一律写回；否则去重窗口一过会全部重放。
        saveState({ tokenId, timeframe: w.timeframe, basis: w.basis, level }, r.next);
        if (r.fire) {
          fires.push({ tokenId, timeframe: w.timeframe, basis: w.basis, level,
            multiple: w.multiple, at: now });
        }
      }
    }

    // ATH 与暴涨分别判定。ATH 不能再提前 return 吞掉本轮已经跨过的暴涨档位，
    // 也不能混进 recentAlert 后充当暴涨追加的价格锚点。
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
        log.debug(`${tokenId} 未升档，但比上次报警价又涨 ${ADVANCE_RATIO} 倍，补报`);
      }
    } else if (crossed) {
      log.debug(`${tokenId} 30 分钟内已报过同档或更高（${crossed.level}x 档），压制`);
    }

    const ath = evaluateAthFor(tokenId, price, now);
    if (!winner && !ath) return null;

    if (!winner && ath) {
      const delivered = fanout(tokenId, holders, price, ath.winner, ath.kind,
        ath.basePrice, now, ath.baseTs, ath.windowKey, marketCapUsd, quoteFetchedAt);
      return { winner: ath.winner, kind: ath.kind, ...delivered };
    }

    const base = windows.find(
      (w) => w.timeframe === winner!.timeframe && w.basis === winner!.basis,
    )?.base ?? null;
    // 同轮两种事实合并成一行：只响一次，但 kind/athWindow/baseTs 足以让前端
    // 同时写清“首次 2x”与“突破 N 天新高”。暴涨的 basePrice 仍保留，方便
    // 显示真实市值起点；ATH 前高时间单独沿用 baseTs。
    const persistedKind = ath ? 'pump-ath' : kind;
    const delivered = fanout(tokenId, holders, price, winner!, persistedKind, base, now,
      ath?.baseTs ?? null, ath?.windowKey ?? null, marketCapUsd, quoteFetchedAt);
    return { winner: winner!, kind: persistedKind, ...delivered };
  });

  const persisted = persistDecision();
  if (persisted && persisted.notified > 0) {
    log.info(
      `${tokenId} 暴涨 ${persisted.winner.multiple.toFixed(2)}x `
      + `(${persisted.winner.timeframe}/${persisted.winner.basis}, `
      + `${persisted.winner.level}x 档)，通知 ${persisted.notified} 人`
      + (persisted.skipped > 0
        ? `（${persisted.skipped} 人仓位低于各自的阈值，已跳过）` : ''),
    );
  }
  return { status: 'ok' };
}

/**
 * ATH 判定。返回非 null 表示这一轮该发 ATH 报警。
 *
 * 没有 wallet_ath 记录（长历史还没回填到）时静默跳过 —— 没有可信的
 * 历史最高就没有资格说"突破新高"。
 */
function evaluateAthFor(tokenId: string, price: Decimal, now: number): {
  winner: PendingFire; kind: 'ath' | 'ath-advance'; basePrice: Decimal; baseTs: number | null;
  windowKey: string; windowLabel: string;
} | null {
  const row = athRepo.getWalletAth(tokenId);
  if (!row) return null;

  /**
   * 各滚动窗口的高点。缓存几分钟 —— 算一次要扫 ath_daily 加最多 30 天的
   * 5 分钟数据，471 个币每轮都算跑不起；而窗口高点变化很慢，
   * 真创了新高时当轮的价格本来就会顶上去。
   */
  let highs: Map<string, Decimal>;
  const cacheAge = row.windowHighsAt === null ? Infinity : now - row.windowHighsAt;
  if (cacheAge < athRepo.WINDOW_CACHE_SECONDS) {
    highs = new Map();
    for (const [k, v] of athRepo.readWindowHighs(row)) {
      try { highs.set(k, new Decimal(v)); } catch { /* 坏值跳过 */ }
    }
  } else {
    highs = windowHighs(tokenId, ATH_WINDOWS, now);
    const asText = new Map<string, string>();
    for (const [k, v] of highs) asText.set(k, v.toString());
    athRepo.saveWindowHighs(tokenId, asText, now);
  }
  if (highs.size === 0) return null;          // 还没有任何历史，说不了"新高"

  const start = historyStart(tokenId);
  const broken = largestBrokenWindow(price, highs, start, now, BREAKOUT_MARGIN);

  /**
   * 报警的判据是**突破了更长的窗口**，不是"又创了个新高"。
   *
   * 上涨途中每一轮都在破 3 天新高，但那是同一件事说七遍。只有当它够到
   * 一个此前没够到过的、更长的窗口时，才是新消息 —— 破 90 天高点和
   * 破 3 天高点，分量差得远。
   */
  const prevRank = row.lastWindow ? windowRank(row.lastWindow) : -1;
  const nowRank = broken ? windowRank(broken.key) : -1;

  /** 回落到最短窗口高点的 REARM_RATIO 以下就重新武装，档次记录清零 */
  const shortest = highs.get(ATH_WINDOWS[0]!.key);
  if (shortest && price.lt(shortest.mul(REARM_RATIO)) && row.lastWindow) {
    athRepo.saveLastWindow(tokenId, '', now);
    athRepo.saveAthAlertState(tokenId, 'ARMED', null, null, now, false);
    return null;
  }

  if (!broken) return null;

  const lastAlert = row.lastAlertPrice ? new Decimal(row.lastAlertPrice) : null;
  const isNewWindow = nowRank > prevRank;
  const advanced = !isNewWindow && lastAlert !== null
    && price.gte(lastAlert.mul(ATH_ADVANCE_RATIO));
  if (!isNewWindow && !advanced) {
    // 仍在同一档窗口内爬升，且涨幅不够 —— 不吵
    if (price.gt(new Decimal(row.athPrice ?? '0'))) {
      athRepo.raiseWalletAth(tokenId, price.toString(), now);
    }
    return null;
  }

  const ref = highs.get(broken.key)!;
  athRepo.saveLastWindow(tokenId, broken.key, now);
  athRepo.saveAthAlertState(tokenId, 'FIRED', price.toString(), ref.toString(), now, true);
  if (price.gt(new Decimal(row.athPrice ?? '0'))) {
    athRepo.raiseWalletAth(tokenId, price.toString(), now);
  }

  return {
    winner: {
      tokenId, timeframe: '24h', basis: 'low', level: 0,
      multiple: ref.gt(0) ? price.div(ref) : new Decimal(1), at: now,
    },
    kind: isNewWindow ? 'ath' : 'ath-advance',
    basePrice: ref,
    baseTs: row.athTs,
    windowKey: broken.key,
    windowLabel: describeWindow(broken),
  };
}

interface PersistedAlert {
  winner: PendingFire;
  kind: wr.AlertKind;
  notified: number;
  skipped: number;
}

/** 把一条报警发给每个持有人，各自带自己的余额与持仓价值 */
export function fanout(
  tokenId: string,
  holders: ReturnType<typeof wr.usersHoldingToken>,
  price: Decimal,
  winner: PendingFire,
  kind: 'level' | 'advance' | 'ath' | 'ath-advance' | 'pump-ath',
  base: Decimal | null,
  now: number,
  baseTs: number | null = null,
  /** ATH 报警突破的是哪一档窗口（'3d'/'90d'/'all'…），前端据此措辞 */
  athWindow: string | null = null,
  /** 与本行 priceUsd 同源的市值 */
  marketCapUsd: number | null = null,
  /** 实际判定价可用的时刻；双源共识取两者较晚，看板价取看板水位。 */
  quoteFetchedAt: number | null = null,
  priceSource: string | null = null,
  priceRegime: string | null = null,
): { notified: number; skipped: number } {
  let notified = 0, skipped = 0;
  const byUser = new Map<string, typeof holders>();
  for (const h of holders) {
    const row = wr.getHolding(h.walletId, tokenId);
    if (!row || row.monitored !== 1) continue;
    const group = byUser.get(h.userId) ?? [];
    group.push(h);
    byUser.set(h.userId, group);
  }

  for (const [userId, owned] of byUser) {
    let totalAmount = new Decimal(0);
    let amountKnown = true;
    for (const h of owned) {
      const amount = toHumanAmount(h.balance, h.decimals);
      if (amount === null) {
        amountKnown = false;
        continue;
      }
      totalAmount = totalAmount.plus(amount);
    }
    const value = amountKnown ? totalAmount.mul(price) : null;

    /**
     * 仓位太小的不推。判定放在扇出这一步而不是过滤层，因为持仓价值
     * 是**每个人各不相同**的 —— 同一个币，你只有几毛钱、别人有几千块，
     * 该不该吵醒你们的答案不一样。这也是为什么阈值不能去动
     * holdings.monitored：那是跨用户共享的一行。
     *
     * 价值算不出来时照常推送：那说明数据有问题，宁可多响一次也不要
     * 因为算不出而静默吞掉。
     */
    const floor = owned[0]!.minAlertValueUsd ?? MIN_ALERT_VALUE_USD;
    if (value && value.lt(new Decimal(String(floor)))) {
      skipped++;
      continue;
    }

    wr.insertPumpAlert({
      id: randomUUID(),
      userId,
      tokenId,
      firedAt: now,
      timeframe: winner.timeframe,
      basis: winner.basis,
      level: winner.level,
      multiple: winner.multiple.toString(),
      // 必须写实际用于判定的价格：看板价或通过确认的 XXYY 候选价。
      priceUsd: price.toString(),
      basePriceUsd: base ? base.toString() : null,
      baseTs,
      athWindow,
      marketCapUsd,
      quoteFetchedAt,
      evaluatedAt: now,
      priceSource,
      priceRegime,
      // 多钱包余额的 raw 整数只有 decimals 完全一致时才可直接相加；展示与
      // 阈值实际依赖的是上面用 Decimal 算出的 valueUsd，所以多钱包留空，
      // 避免把某一个钱包的余额冒充总余额。
      balance: owned.length === 1 ? owned[0]!.balance : null,
      valueUsd: value ? value.toString() : null,
      ackedAt: null,
      kind,
    });
    notified++;
  }

  return { notified, skipped };
}


/* ---------------- XXYY 受保护报价 ---------------- */

interface XxyyRound {
  quotes: Map<string, XxyyQuote>;
  failures: Map<string, string>;
}

/** 少于这个样本时只看全局结果，避免某条小链 1 个缺失就拖垮整轮。 */
const MIN_PER_CHAIN_HEALTH_SAMPLES = 20;

/**
 * 各链同时提交，真正的节流仍由 xxyy.ts 的全局队列负责。
 * 单链失败保留下来交给健康判定；不能像影子阶段那样从分母里消失。
 */
async function fetchXxyyRound(
  byChain: Map<string, string[]>, fetchPrices: typeof fetchXxyyPrices,
): Promise<XxyyRound> {
  const quotes = new Map<string, XxyyQuote>();
  const failures = new Map<string, string>();
  await Promise.all([...byChain].map(async ([chain, addrs]) => {
    if (!xxyySupportsChain(chain)) return;
    try {
      const got = await fetchPrices(chain, addrs);
      for (const [mint, q] of got) {
        quotes.set(`${chain}:${normalizeMint(chain, mint)}`, q);
      }
    } catch (err) {
      const message = safeErrorMessage(err);
      failures.set(chain, message);
      log.warn(`xxyy ${chain} 取价失败，当前轮自动回退 DexScreener：${message}`);
    }
  }));
  return { quotes, failures };
}

/**
 * 整体与逐链都要过关。只看整体会让一条小链完全断供时被其它链的样本稀释；
 * 只看逐链又会在样本很少时太敏感，因此连续 5 轮才真正通知。
 */
function assessXxyy(
  byChain: Map<string, string[]>, dsQuotes: Map<string, BatchQuote>,
  xxyy: XxyyRound, now: number,
): HealthVerdict {
  const mine = new Map<string, { priceUsd: string }>();
  const theirs = new Map<string, { priceUsd: string }>();
  const bad: string[] = [];

  for (const [chain, addrs] of byChain) {
    if (!xxyySupportsChain(chain)) continue;
    const chainMine = new Map<string, { priceUsd: string }>();
    const chainTheirs = new Map<string, { priceUsd: string }>();
    for (const address of addrs) {
      const key = `${chain}:${normalizeMint(chain, address)}`;
      const ds = dsQuotes.get(key);
      if (ds) {
        const p = { priceUsd: ds.priceUsd };
        mine.set(key, p);
        chainMine.set(key, p);
      }
      const candidate = xxyy.quotes.get(key);
      if (candidate) {
        const p = { priceUsd: candidate.priceUsd };
        theirs.set(key, p);
        chainTheirs.set(key, p);
      }
    }

    const failure = xxyy.failures.get(chain);
    if (failure) {
      bad.push(`${chain} 请求失败`);
      continue;
    }
    if (chainMine.size >= MIN_PER_CHAIN_HEALTH_SAMPLES) {
      const chainVerdict = judge(compareQuotes(chainMine, chainTheirs), chainMine.size);
      if (!chainVerdict.ok) bad.push(`${chain} ${chainVerdict.reason}`);
    }
  }

  const report = compareQuotes(mine, theirs);
  if (mine.size === 0 && xxyy.failures.size === 0) {
    // DS 本轮也没有可比报价时，既不能证明 XXYY 正常，也不能证明它坏了。
    // 保留上次健康状态，并且本轮不采用候选价。
    log.warn('xxyy 本轮没有 DexScreener 可比样本，保持原健康状态并回退');
    return { ok: false, reason: '没有可比样本' };
  }
  let verdict: HealthVerdict;
  if (bad.length > 0) verdict = { ok: false, reason: bad.join('；') };
  else verdict = judge(report, mine.size);

  const detail = `重叠 ${report.compared}/${mine.size}，一致 ${report.agreed}`
    + (xxyy.failures.size > 0 ? `，失败链 ${[...xxyy.failures.keys()].join(',')}` : '');
  recordVerdict('xxyy', verdict, now, detail);

  log.info(
    `xxyy 核对：重叠 ${report.compared}/${mine.size}，`
    + `一致率 ${report.rate === null ? '—' : (report.rate * 100).toFixed(1) + '%'}`
    + (report.worst.length > 0
      ? `，最大偏离 ${report.worst[0]!.ratio} 倍（${report.worst[0]!.key}）` : '')
    + (verdict.ok ? '' : '，异常链或不一致币已回退 DexScreener'),
  );
  return verdict;
}

/**
 * XXYY 是候选价，DexScreener 是确认价：两者相差不超过 10% 才进入共识。
 * 共识后取两者较低值，这样任何向上的 2x/ATH 都天然得到双源确认；任一缺失、
 * 无法解析、偏离过大，或者本轮整体健康不合格，均保留 DS 原价。
 */
function applyGuardedXxyy(
  dsQuotes: Map<string, BatchQuote>, xxyyQuotes: Map<string, XxyyQuote>, healthy: boolean,
): Map<string, BatchQuote> {
  const out = new Map(dsQuotes);
  let confirmed = 0, xxyyLower = 0, missing = 0, diverged = 0;
  const tolerance = new Decimal(PRICE_TOLERANCE.toString());

  for (const [key, ds] of dsQuotes) {
    const candidate = xxyyQuotes.get(key);
    if (!candidate) { missing++; continue; }
    let dsPrice: Decimal, candidatePrice: Decimal;
    try {
      dsPrice = new Decimal(ds.priceUsd);
      candidatePrice = new Decimal(candidate.priceUsd);
    } catch {
      diverged++;
      continue;
    }
    if (dsPrice.lte(0) || candidatePrice.lte(0)) { diverged++; continue; }
    const ratio = Decimal.max(dsPrice.div(candidatePrice), candidatePrice.div(dsPrice));
    if (!healthy || ratio.gt(tolerance)) { diverged++; continue; }

    const acceptedPrice = Decimal.min(dsPrice, candidatePrice);
    if (candidatePrice.lt(dsPrice)) xxyyLower++;
    out.set(key, {
      ...ds,
      priceUsd: acceptedPrice.toString(),
      priceSource: candidatePrice.lt(dsPrice) ? 'xxyy' : 'dexscreener',
      // 共识要等两个源都返回才成立，因此采用两者较晚的采样时刻。
      fetchedAt: Math.max(ds.fetchedAt ?? 0, candidate.fetchedAt ?? 0) || undefined,
      // DS 已校正过计价池，按共识价格同比例换算最稳；DS 没市值才用 XXYY 的。
      marketCapUsd: scaleMarketCap(ds.marketCapUsd, ds.priceUsd, acceptedPrice.toString())
        ?? candidate.marketCapUsd,
    });
    confirmed++;
  }

  log.info(
    `xxyy 受保护报价：双源确认 ${confirmed}/${dsQuotes.size}`
    + `，取 XXYY 较低价 ${xxyyLower}`
    + `，缺失 ${missing}，偏离或健康回退 ${diverged}`,
  );
  return out;
}
