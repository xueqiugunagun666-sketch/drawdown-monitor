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
import * as athRepo from '../db/athRepo.ts';
import {
  evaluateAth, seedAthState, type AthSnapshot,
} from './athState.ts';
import { getRawDb } from '../db/index.ts';
import * as wr from '../db/walletRepo.ts';
import { fetchBatchQuotes, type BatchQuote } from '../sources/dexscreenerBatch.ts';
import {
  computeMultiples, WINDOW_SECONDS, type PumpTimeframe, type PumpBasis,
} from './pumpWindows.ts';
import {
  LEVELS, seedPumpState, evaluatePump, pickWinner, suppressedByRecent,
  shouldFireOnAdvance, DEDUP_WINDOW_SECONDS, ADVANCE_RATIO,
  type PumpSnapshot, type PendingFire, type RecentAlert,
} from './pumpState.ts';
import { evaluateFilter, DEFAULT_THRESHOLDS, type FilterState } from './holdingsFilter.ts';
import { toHumanAmount } from '../sources/erc20.ts';
import { needsBackfill, backfillWalletToken, realBackfillDeps, type BackfillDeps } from './walletBackfill.ts';
import { fetchTokenInfo, type TokenInfo } from '../sources/gmgnTokenInfo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { randomUUID } from 'node:crypto';

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
     WHERE token_id = ? AND fired_at >= ?`,
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

/** 该币是否已在共享看板的监控列表里（那边的 candle 写入优先） */
function isWatchlistToken(tokenId: string): boolean {
  const r = getRawDb().prepare(
    `SELECT 1 AS x FROM tokens WHERE id = ? AND enabled = 1 AND visibility = 'public'`,
  ).get(tokenId) as { x: number } | undefined;
  return r !== undefined;
}

/** 这个币最新一根 5m candle 的收盘价。用来校验实时报价是不是同一个量级 */
function latestCandleClose(tokenId: string): Decimal | null {
  const r = getRawDb().prepare(
    `SELECT c FROM candles WHERE token_id = ? AND timeframe = '5m' AND c IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  ).get(tokenId) as { c: string } | undefined;
  if (!r) return null;
  try {
    const d = new Decimal(r.c);
    return d.gt(0) ? d : null;
  } catch {
    return null;
  }
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
  // 监控中的每轮都判；已被挡掉的每 30 分钟重查一次 ——
  // 一千多个粉尘币每轮都拉报价，光请求就占掉 20 秒
  const tokenIds = wr.tokenIdsDueForEval(now);
  if (tokenIds.length === 0) return;

  // 按链分组，每条链一次批量报价
  const byChain = new Map<string, string[]>();
  for (const id of tokenIds) {
    const [chain, addr] = id.split(':');
    if (!chain || !addr) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(addr);
  }

  const t0 = Date.now();
  const quotes = new Map<string, BatchQuote>();
  for (const [chain, addrs] of byChain) {
    try {
      for (const [a, q] of await deps.fetchQuotes(chain, addrs)) quotes.set(`${chain}:${a}`, q);
    } catch (err) {
      // 一条链失败不拖垮其它链；缺的地址会走"报价缺失"分支保持原状态
      log.warn(`${chain} 批量报价失败: ${safeErrorMessage(err)}`);
    }
  }
  const quoteMs = Date.now() - t0;

  for (const tokenId of tokenIds) {
    try {
      const q = quotes.get(tokenId) ?? null;
      await evaluateToken(tokenId, q, now,
        deps.backfill ?? realBackfillDeps, deps.fetchTokenInfo);
      // 流动性一起记下 —— 下一轮靠它决定这个币走快车道还是慢车道
      wr.markTokenEvaluated(tokenId, now, q?.liquidityUsd);
    } catch (err) {
      log.warn(`${tokenId} 判定失败: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * 轮次耗时的分段账。
   *
   * 加这个是因为吃过亏：轮次超时的时候连着猜了两次瓶颈都猜错了
   * （先怪批量请求，又怪持仓查询），改完才发现真正的大头是回填重试。
   * 有分段数字就不用猜。超预算才打 INFO，正常时打 DEBUG，不刷屏。
   */
  const totalMs = Date.now() - t0;
  const line = `轮次 ${tokenIds.length} 个币：报价 ${(quoteMs / 1000).toFixed(1)}s`
    + `（${byChain.size} 条链），判定 ${((totalMs - quoteMs) / 1000).toFixed(1)}s，`
    + `共 ${(totalMs / 1000).toFixed(1)}s`;
  if (totalMs > TICK_INTERVAL_SECONDS * 1000) log.info(`${line} —— 超出 ${TICK_INTERVAL_SECONDS}s 预算`);
  else log.debug(line);
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
  // 官网 / 推特 / 电报也是这个响应白送的，存下来给页面上的跳转按钮用
  wr.setTokenLinks(tokenId, now, quote);

  // ---- 倍数 ----
  const fromWatchlist = isWatchlistToken(tokenId);
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
  let price = new Decimal(quote.priceUsd);
  if (fromWatchlist) {
    const boardPrice = latestCandleClose(tokenId);
    if (boardPrice) {
      if (Decimal.max(price.div(boardPrice), boardPrice.div(price)).gt(2)) {
        log.debug(
          `${tokenId} 在看板上，改用看板价 ${boardPrice.toString()}`
          + `（批量报价 ${quote.priceUsd}）`,
        );
      }
      price = boardPrice;
    }
  }
  if (!price.gt(0)) return;

  // 先把本轮价格并进当前 5m candle，历史就是这样一轮轮攒起来的。
  //
  // 但如果这个币同时在共享看板的监控列表里，轮询器已经在写同一行了 ——
  // 它 30 秒一轮、做主池选举与跨池中位数校验，数据比批量报价好。
  // 两边都写会互相覆盖 h/l 与 liquidity_total（一个是主池、一个是全池口径），
  // 让 source 列反复翻转。让位给它。
  if (!fromWatchlist) {
    wr.upsertWalletCandle(tokenId, quote.priceUsd, quote.liquidityUsd, now);

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

  /**
   * ATH 判定走**独立的状态机**，与暴涨那套并行。
   *
   * 两者说的不是一回事：暴涨是"从最近低点涨了 N 倍"，ATH 是"进入价格
   * 发现区、头上没有套牢盘"。一个币可以涨 5 倍还远在高点之下，也可以
   * 只涨 15% 就破新高。
   *
   * 但同一轮里两个都触发时**只发 ATH 那条** —— 破新高本来就蕴含着在涨，
   * 为同一件事响两次是纯粹的噪音。
   */
  const ath = evaluateAthFor(tokenId, price, now);
  if (ath) {
    await fanout(tokenId, holders, quote, price, ath.winner, ath.kind, ath.basePrice, now, ath.baseTs);
    return;
  }

  const recent = recentAlert(tokenId, now);
  const crossed = pickWinner(fires);

  /**
   * 两条触发路径：
   *   1. 穿过一个新档位（且没被同档压制）
   *   2. 没升档，但价格比"已经告诉过你的最高价"又涨了 ADVANCE_RATIO 倍
   *
   * 第 2 条**必须独立判断**，不能只写成"放松第 1 条的压制"：所有档都已
   * FIRED 时根本产生不出 pendingFire，连 pickWinner 都是空的。哈夫币那波
   * 能靠别的窗口各自穿档蹭出机会纯属侥幸（各窗口基准不同，碰巧错开了）。
   */
  let winner: PendingFire | null = null;
  let kind: 'level' | 'advance' = 'level';

  if (crossed && !suppressedByRecent(recent, now, crossed.level)) {
    winner = crossed;
  } else if (shouldFireOnAdvance(recent, now, price)) {
    /**
     * 补报用倍数最高的那个窗口来描述，档位**沿用窗口内已报过的最高档**
     * —— 不能记成更高的档，否则随后真正穿那一档时会被压制掉，等于把
     * 那一档吃掉了（PICKLES 就是这么丢的，不能再犯）。
     */
    const best = pickBestWindow(windows, now);
    if (best) {
      winner = { ...best, level: recent!.level };
      kind = 'advance';
      log.debug(`${tokenId} 未升档，但比上次报警价又涨 ${ADVANCE_RATIO} 倍，补报`);
    }
  } else if (crossed) {
    log.debug(`${tokenId} 30 分钟内已报过同档或更高（${crossed.level}x 档），压制`);
  }
  if (!winner) return;

  // ---- 扇出：每个持有者一行，带各自的余额与持仓价值 ----
  const base = windows.find((w) => w.timeframe === winner.timeframe && w.basis === winner.basis)?.base ?? null;
  await fanout(tokenId, holders, quote, price, winner, kind, base, now);
}

/**
 * ATH 判定。返回非 null 表示这一轮该发 ATH 报警。
 *
 * 没有 wallet_ath 记录（长历史还没回填到）时静默跳过 —— 没有可信的
 * 历史最高就没有资格说"突破新高"。
 */
function evaluateAthFor(tokenId: string, price: Decimal, now: number): {
  winner: PendingFire; kind: 'ath' | 'ath-advance'; basePrice: Decimal; baseTs: number | null;
} | null {
  const row = athRepo.getWalletAth(tokenId);
  if (!row) return null;

  const stored = row.athPrice ? new Decimal(row.athPrice) : null;
  const prev: AthSnapshot = row.lastAlertAt === null && row.state === 'ARMED' && !row.refAth
    ? seedAthState(price, stored)      // 首次判定：已在高位的不补报历史
    : {
      state: row.state === 'FIRED' ? 'FIRED' : 'ARMED',
      lastAlertPrice: row.lastAlertPrice ? new Decimal(row.lastAlertPrice) : null,
      refAth: row.refAth ? new Decimal(row.refAth) : null,
    };

  /**
   * 前高的时刻要在更新之前取。raiseWalletAth 会把 ath_ts 改成新高的
   * 时刻，事后再查就查不到"旧高点是什么时候立的"了 —— 而
   * 「前高立于 23 天前」正是 ATH 报警最关键的一句。
   */
  const prevAthTs = row.athTs;

  const r = evaluateAth(prev, { price, ath: stored });

  if (r.newAth) athRepo.raiseWalletAth(tokenId, r.newAth.toString(), now);
  athRepo.saveAthAlertState(
    tokenId, r.next.state,
    r.next.lastAlertPrice ? r.next.lastAlertPrice.toString() : null,
    r.next.refAth ? r.next.refAth.toString() : null,
    now, r.fire !== null,
  );
  if (!r.fire || !stored) return null;

  /**
   * 倍数报的是**相对突破参照线**的涨幅，不是相对事实最高价 ——
   * 后者突破后就等于现价，倍数永远是 1.00，等于什么也没说。
   */
  const ref = prev.refAth ?? stored;
  return {
    winner: {
      tokenId, timeframe: '24h', basis: 'low', level: 0,
      multiple: ref.gt(0) ? price.div(ref) : new Decimal(1), at: now,
    },
    kind: r.fire === 'breakout' ? 'ath' : 'ath-advance',
    basePrice: ref,
    baseTs: prevAthTs,
  };
}

/** 把一条报警发给每个持有人，各自带自己的余额与持仓价值 */
async function fanout(
  tokenId: string,
  holders: ReturnType<typeof wr.usersHoldingToken>,
  quote: BatchQuote,
  price: Decimal,
  winner: PendingFire,
  kind: 'level' | 'advance' | 'ath' | 'ath-advance',
  base: Decimal | null,
  now: number,
  baseTs: number | null = null,
): Promise<void> {
  let notified = 0, skipped = 0;
  for (const h of holders) {
    const row = wr.getHolding(h.walletId, tokenId);
    if (!row || row.monitored !== 1) continue;
    const amount = toHumanAmount(h.balance, h.decimals);
    const value = amount ? amount.mul(price) : null;

    /**
     * 仓位太小的不推。判定放在扇出这一步而不是过滤层，因为持仓价值
     * 是**每个人各不相同**的 —— 同一个币，你只有几毛钱、别人有几千块，
     * 该不该吵醒你们的答案不一样。这也是为什么阈值不能去动
     * holdings.monitored：那是跨用户共享的一行。
     *
     * 价值算不出来时照常推送：那说明数据有问题，宁可多响一次也不要
     * 因为算不出而静默吞掉。
     */
    const floor = h.minAlertValueUsd ?? MIN_ALERT_VALUE_USD;
    if (value && value.lt(floor)) {
      skipped++;
      continue;
    }

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
      baseTs,
      balance: h.balance,
      valueUsd: value ? value.toString() : null,
      ackedAt: null,
      kind,
    });
    notified++;
  }

  // 一个人都没通知就别记这条日志了，否则日志里全是"通知 0 人"
  if (notified > 0) {
    log.info(
      `${tokenId} 暴涨 ${winner.multiple.toFixed(2)}x ` +
      `(${winner.timeframe}/${winner.basis}, ${winner.level}x 档)，通知 ${notified} 人` +
      (skipped > 0 ? `（${skipped} 人仓位低于各自的阈值，已跳过）` : ''),
    );
  }
}
