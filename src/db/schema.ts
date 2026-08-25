/**
 * Drizzle schema —— 对应规格 §6（v0.3）。
 *
 * 价格列一律 TEXT（十进制字符串），见 src/lib/decimal.ts 顶部说明。
 * volume / liquidity 这类不参与阈值判定的量用 REAL。
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),                       // "{chain}:{address}"
  chain: text('chain').notNull(),
  address: text('address').notNull(),
  symbol: text('symbol'),
  name: text('name'),
  decimals: integer('decimals'),
  addedAt: integer('added_at').notNull(),
  note: text('note'),                                // 为什么关注它（§9.4 必填）
  tags: text('tags'),                                // JSON array
  frozen: integer('frozen').default(0).notNull(),
  enabled: integer('enabled').default(1).notNull(),
  lastSource: text('last_source'),
  lastQuoteAt: integer('last_quote_at'),
  failCount: integer('fail_count').default(0).notNull(),
});

export const pools = sqliteTable('pools', {
  id: text('id').primaryKey(),                       // "{chain}:{poolAddress}"
  tokenId: text('token_id').notNull().references(() => tokens.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),
  dex: text('dex'),
  quoteSymbol: text('quote_symbol'),
  quoteAddress: text('quote_address'),
  isPrimary: integer('is_primary').default(0).notNull(),
  liquidityUsd: real('liquidity_usd'),
  priceUsd: text('price_usd'),
  isOutlier: integer('is_outlier').default(0).notNull(),   // §2.4 离群池
  createdAt: integer('created_at'),
  lastSeenAt: integer('last_seen_at'),
});

export const candles = sqliteTable('candles', {
  tokenId: text('token_id').notNull(),
  timeframe: text('timeframe').notNull(),            // '5m' | '1h' | '1d'
  ts: integer('ts').notNull(),
  o: text('o'), h: text('h'), l: text('l'), c: text('c'),
  oNative: text('o_native'), hNative: text('h_native'),
  lNative: text('l_native'), cNative: text('c_native'),
  volumeUsd: real('volume_usd'),
  liquidityPrimary: real('liquidity_primary'),
  liquidityTotal: real('liquidity_total'),
  txnCount: integer('txn_count'),                    // 回填段为 NULL（GT OHLCV 不提供）
  source: text('source'),
}, (t) => [primaryKey({ columns: [t.tokenId, t.timeframe, t.ts] })]);

export const athState = sqliteTable('ath_state', {
  tokenId: text('token_id').notNull(),
  mode: text('mode').notNull(),                      // 'rolling_90d' | 'all_time' | 'since_added'
  quoteMode: text('quote_mode').notNull(),           // 'usd' | 'native'
  athRaw: text('ath_raw'),
  athRobust: text('ath_robust'),                     // §2.2：合格 candle 中第 k 高的 close
  athTs: integer('ath_ts'),
  athLiquidity: real('ath_liquidity'),               // 回填段为 NULL
  volH1AtAth: real('vol_h1_at_ath'),                 // §2.5 替代分母，已归一到 60 分钟
  athConfidence: text('ath_confidence'),             // 'verified' | 'inferred'
  verdictBasis: text('verdict_basis'),               // 'liquidity' | 'volume_proxy'
  backfillPartial: integer('backfill_partial').default(0).notNull(),
  updatedAt: integer('updated_at'),
}, (t) => [primaryKey({ columns: [t.tokenId, t.mode, t.quoteMode] })]);

/** §2.3：priceNative 自行推导，这里存链原生币的 USD 报价 */
export const nativePrices = sqliteTable('native_prices', {
  symbol: text('symbol').notNull(),                  // 'ETH' | 'BNB' | 'SOL'
  ts: integer('ts').notNull(),                       // 5m 对齐
  priceUsd: text('price_usd').notNull(),
  source: text('source'),
}, (t) => [primaryKey({ columns: [t.symbol, t.ts] })]);

export const alertRules = sqliteTable('alert_rules', {
  id: text('id').primaryKey(),
  tokenId: text('token_id'),                         // NULL = 全局默认规则
  type: text('type').notNull(),                      // 'drawdown' | 'bounce'
  athMode: text('ath_mode').default('rolling_90d').notNull(),
  quoteMode: text('quote_mode').default('usd').notNull(),
  levels: text('levels').notNull(),                  // JSON: [80,85,90,95]
  confirmTicks: integer('confirm_ticks').default(2).notNull(),
  hysteresis: real('hysteresis').default(15).notNull(),
  rearmMinutes: integer('rearm_minutes').default(60).notNull(),
  minLiquidityUsd: real('min_liquidity_usd').default(5000).notNull(),  // §2.4：门槛用 liquidity_total
  athSustainCandles: integer('ath_sustain_candles').default(3).notNull(), // §2.2 的 k
  cooldownMinutes: integer('cooldown_minutes').default(30).notNull(),
  bouncePct: real('bounce_pct').default(25).notNull(),
  channels: text('channels'),                        // JSON
  enabled: integer('enabled').default(1).notNull(),
});

export const alertStates = sqliteTable('alert_states', {
  tokenId: text('token_id').notNull(),
  ruleId: text('rule_id').notNull(),
  level: real('level').notNull(),
  state: text('state').notNull(),                    // 'ARMED' | 'FIRED'
  hitCount: integer('hit_count').default(0).notNull(),
  rearmSinceTs: integer('rearm_since_ts'),           // 回落到重新武装区间的起始时刻
  localLow: text('local_low'),                       // FIRED 后追踪的局部低点（Phase 3 bounce 用）
  localLowTs: integer('local_low_ts'),
  lastFiredAt: integer('last_fired_at'),
}, (t) => [primaryKey({ columns: [t.tokenId, t.ruleId, t.level] })]);

export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  tokenId: text('token_id').notNull(),
  ruleId: text('rule_id'),
  type: text('type'),                                // 'drawdown' | 'bounce'
  level: real('level'),
  firedAt: integer('fired_at').notNull(),
  priceUsd: text('price_usd'),
  athUsd: text('ath_usd'),
  drawdownUsd: text('drawdown_usd'),
  drawdownNative: text('drawdown_native'),
  snapshot: text('snapshot'),                        // JSON: §2.5 全量指标
  verdict: text('verdict'),                          // 'pullback' | 'unclear' | 'rug'
  verdictBasis: text('verdict_basis'),               // 'liquidity' | 'volume_proxy'
  delivered: text('delivered'),                      // JSON: 各渠道投递结果
  ackedAt: integer('acked_at'),
});

/** §4.4：数据源健康，供 /api/health 与 UI 顶部指标条使用 */
export const sourceHealth = sqliteTable('source_health', {
  sourceId: text('source_id').primaryKey(),
  lastOkAt: integer('last_ok_at'),
  lastFailAt: integer('last_fail_at'),
  lastFailKind: text('last_fail_kind'),
  lastFailMessage: text('last_fail_message'),        // 已掩码
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
});

/** 轮询轮次记录，UI 显示"上次轮询时间" */
export const pollRuns = sqliteTable('poll_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  tokensRequested: integer('tokens_requested').default(0).notNull(),
  tokensCovered: integer('tokens_covered').default(0).notNull(),
  errors: text('errors'),                            // JSON string[]，已掩码
});
