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
  /** §2.4：主池选举时刻，用于 6 小时粘性 */
  primaryElectedAt: integer('primary_elected_at'),
  failCount: integer('fail_count').default(0).notNull(),
  /** 添加者的账号名，展示用。权限一律看 ownerId，不看这里 ——
   *  账号改名之后这里就成了旧名字的快照，正是想要的效果（历史记录不该被后来的改名改写）。
   *  账号系统之前的旧行里是自填署名，可能对应不到任何账号。 */
  createdBy: text('created_by'),
  pinned: integer('pinned').default(0).notNull(),   // 置顶高亮，与跌幅无关
  /** 'public' 进共享看板 | 'wallet' 只在个人钱包页可见。
   *  两人持有同一个币时共用这一条记录，价格只轮询一次。 */
  visibility: text('visibility').default('public').notNull(),
  /** 添加者的 users.id。NULL = 无主（账号系统上线前加的），只有管理员能动 */
  ownerId: text('owner_id'),
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
  marketCapUsd: real('market_cap_usd'),   // 回填段为 NULL（OHLCV 不含市值）
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
  athMarketCap: real('ath_market_cap'),              // 同上；为 NULL 时不能用价格反推，见 notifier
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

/**
 * 项目日程 —— mint / 发行 / 上所等时间点。
 *
 * at_ts 一律存 UTC 秒。input_tz 记录录入时选的时区，
 * 编辑时按原时区回显，展示时统一换算成北京时间。
 */
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  atTs: integer('at_ts').notNull(),               // UTC 秒
  inputTz: text('input_tz').notNull(),            // IANA 时区名
  category: text('category'),
  priority: text('priority').default('normal').notNull(),
  note: text('note'),
  links: text('links'),                           // JSON: [{label, url}]
  /** 提前多久提醒，JSON 数字数组（分钟），0 表示到点 */
  remindOffsets: text('remind_offsets').notNull(),
  /** 已发出的提醒，JSON 数字数组 —— 去重用，防止重启后重复推 */
  remindedOffsets: text('reminded_offsets'),
  createdBy: text('created_by'),
  ownerId: text('owner_id'),
  createdAt: integer('created_at').notNull(),
  enabled: integer('enabled').default(1).notNull(),
});

/**
 * OHLCV 回填任务。必须可断点续传 —— GT 免费档只有 5 req/min，
 * 100 个代币的全量回填要 10 小时以上，中途重启不能从头再来。
 */
export const backfillJobs = sqliteTable('backfill_jobs', {
  tokenId: text('token_id').notNull(),
  timeframe: text('timeframe').notNull(),        // '5m'（rolling_90d）| '1h'（all_time）
  poolAddress: text('pool_address').notNull(),
  status: text('status').notNull(),              // 'pending' | 'running' | 'done' | 'failed'
  targetSinceTs: integer('target_since_ts').notNull(),
  /** 已回填到的最旧时刻；续传时从这里继续往前翻 */
  oldestDoneTs: integer('oldest_done_ts'),
  pagesDone: integer('pages_done').default(0).notNull(),
  pagesEstimated: integer('pages_estimated').default(0).notNull(),
  candlesWritten: integer('candles_written').default(0).notNull(),
  /** GT 历史深度不足以覆盖 target 时置 1，UI 需明确标识数据不完整 */
  reachedSourceLimit: integer('reached_source_limit').default(0).notNull(),
  lastError: text('last_error'),                 // 已掩码
  startedAt: integer('started_at'),
  updatedAt: integer('updated_at'),
}, (t) => [primaryKey({ columns: [t.tokenId, t.timeframe] })]);

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

/* ============ 钱包暴涨异动监控（spec 2026-08-30） ============ */

/**
 * 个人账号。这是全站唯一的身份来源（共用口令已撤销）——
 * 这个是"进来之后你是谁"。钱包持仓必须按人隔离，而 display_name 是
 * 自己填的署名、能冒充，所以必须有真密码。
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  passwordHash: text('password_hash').notNull(),     // scrypt$N$r$p$salt$hash
  createdAt: integer('created_at').notNull(),
  /**
   * 持仓价值低于这个数就当作粉尘：不报警，持仓列表里也默认折叠起来。
   *
   * **必须是每人一个值**，不能做成全局门槛：同一个币，你只有几毛钱、
   * 别人有几千块，该不该吵醒你们的答案不一样。这也是为什么它不能去动
   * holdings.monitored —— 那是跨用户共享的一行，改了会影响别人。
   *
   * NULL = 没设过，用 pumpEngine 的默认值。用 REAL 与 alert_rules 里
   * 那些门槛列一致；它只做比较不参与价格运算，不违反"价格一律 Decimal"。
   */
  minAlertValueUsd: real('min_alert_value_usd'),
});

/** 会话。库里只存 token 的哈希：数据库泄露时拿不到可用的凭证。 */
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const wallets = sqliteTable('wallets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chain: text('chain').notNull(),
  address: text('address').notNull(),
  label: text('label'),
  /** 增量扫描的水位。扫描成功后才推进 —— 中途失败必须能重来 */
  lastScannedBlock: integer('last_scanned_block'),
  lastScanAt: integer('last_scan_at'),
  lastScanError: text('last_scan_error'),             // 已掩码；UI 必须显示
  enabled: integer('enabled').default(1).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const holdings = sqliteTable('holdings', {
  walletId: text('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
  tokenId: text('token_id').notNull(),
  /** 链上原始整数余额，十进制字符串。uint256 超过 2^53，绝不能存 REAL */
  balance: text('balance').notNull(),
  decimals: integer('decimals'),                      // 读不到就是 null，不猜 18
  /** 代币符号。存在 holdings 而不是 tokens —— 钱包币绝不写进 tokens 表，
   *  那是共享看板的数据源，写进去别人就看到你的持仓了 */
  symbol: text('symbol'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  monitored: integer('monitored').default(0).notNull(),
  filterReason: text('filter_reason'),                // 没进监控的原因，UI 要显示
  /** 滞回用：跌破退出门槛的起始时刻，持续够时长才真的退出 */
  belowSinceTs: integer('below_since_ts'),
}, (t) => [primaryKey({ columns: [t.walletId, t.tokenId] })]);

/**
 * 暴涨分档状态机。**全局的，不按用户** —— 价格变动是全局事实，
 * 只有"通知谁"是每人不同的。这顺带解决了一个边界情况：
 * 新用户加入时持有一个已是 FIRED 的币，不会收到追溯报警。
 */
export const pumpStates = sqliteTable('pump_states', {
  tokenId: text('token_id').notNull(),
  timeframe: text('timeframe').notNull(),             // '5m' | '1h' | '6h' | '24h'
  basis: text('basis').notNull(),                     // 'low' | 'open'
  level: real('level').notNull(),                     // 2 | 5 | 10
  state: text('state').notNull(),                     // 'ARMED' | 'FIRED'
  lastFiredAt: integer('last_fired_at'),
}, (t) => [primaryKey({ columns: [t.tokenId, t.timeframe, t.basis, t.level] })]);

/** 报警记录，每个持有者一行 —— 余额与持仓价值是各人自己的 */
export const pumpAlerts = sqliteTable('pump_alerts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenId: text('token_id').notNull(),
  firedAt: integer('fired_at').notNull(),
  timeframe: text('timeframe').notNull(),
  basis: text('basis').notNull(),
  level: real('level').notNull(),
  multiple: text('multiple').notNull(),               // 实际倍数，十进制字符串
  priceUsd: text('price_usd'),
  basePriceUsd: text('base_price_usd'),
  balance: text('balance'),
  valueUsd: text('value_usd'),
  ackedAt: integer('acked_at'),
});

/**
 * 代币的全局元信息缓存。**跨用户共用** —— 持有人数是链上事实，
 * 不因谁持有而不同，两个人持有同一个币只查一次。
 *
 * 持有人数变化很慢，缓存一天足够；每天一个币一次请求，
 * 95 个币约 1 分钟跑完，远在 GMGN 的限速内。
 */
export const tokenMeta = sqliteTable('token_meta', {
  tokenId: text('token_id').primaryKey(),
  holderCount: integer('holder_count'),
  symbol: text('symbol'),
  fetchedAt: integer('fetched_at').notNull(),
  /** 上次跑过判定的时刻。已被挡掉的币不必每轮重查报价 */
  lastEvalAt: integer('last_eval_at'),
  /**
   * 上次看到的流动性。用来把「被挡掉的币」分成两拨：
   * 流动性够、只差成交量的走快车道（3 分钟复查），其余走慢车道（30 分钟）。
   *
   * 存在 token_meta 而不是 holdings，因为流动性是代币的全局事实，
   * 不因谁持有而不同 —— 两个人持有同一个币不该有两个答案。
   */
  lastLiquidityUsd: real('last_liquidity_usd'),
  /**
   * 上次**尝试**回填的时刻（不是成功的时刻）。
   *
   * 没有它，稀疏的币会每一轮都重试一次回填：needsBackfill 要求 24 小时内
   * 有 144 根 5m candle，而上游对没成交的币根本给不出这么多 —— 条件永远为真。
   * 线上实测 296 个监控中的币里有 52 个天天如此，每轮 52 个串行的 GMGN
   * 请求（限速 80/分钟），占掉判定轮次一半以上的时间。
   */
  lastBackfillAt: integer('last_backfill_at'),
  /** 项目方在 DexScreener 付费绑定的官网 / 推特 / 电报，以及代币头像。
   *  跟报价一起白拿的，存下来给页面上的跳转按钮用 */
  imageUrl: text('image_url'),
  websiteUrl: text('website_url'),
  twitterUrl: text('twitter_url'),
  telegramUrl: text('telegram_url'),
});

/**
 * 审计日志。
 *
 * actor_name 与 target_label 存**快照**而不是 JOIN 出来：账号会改名，
 * 代币删掉之后光看 id 根本不知道是什么。审计日志必须能脱离其他表
 * 独立读懂 —— 否则它记录的历史会被后来的变更改写。
 */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  atTs: integer('at_ts').notNull(),
  actorId: text('actor_id'),
  actorName: text('actor_name').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  targetLabel: text('target_label'),
  detail: text('detail'),
});

/**
 * 注册邀请码。
 *
 * 取代原来那个「所有人共用一个、永不过期」的全站口令：一个码带一个
 * 使用次数上限，用完自动失效，发给谁也能标注。
 *
 * 只存哈希，和密码、会话一个做法 —— 库泄露也拿不到可用的码。
 * 代价是丢了查不回来，但重新生成只是一条命令。
 *
 * **只在注册时校验并消耗**：登录和日常访问都不需要码，
 * 已有账号的人一次都不会消耗额度。
 */
export const inviteCodes = sqliteTable('invite_codes', {
  codeHash: text('code_hash').primaryKey(),
  /** 发给谁了，纯备注，方便你回头对账 */
  label: text('label'),
  maxUses: integer('max_uses').notNull(),
  usedCount: integer('used_count').default(0).notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

/**
 * 群聊淘金：喊单回撤信号。
 *
 * 主键直接用上游的 id —— 它是自增游标，天然去重，重复拉同一页不会写重。
 *
 * **故意不存 caller_wxid 与 group_id**：那是微信的个人与群标识，在页面上
 * 没有任何展示价值，存进来只是把别人的身份信息搬到一个多人共享的看板里。
 * 不收就不会泄。展示需要的是"谁在哪个群喊的"，名字够了。
 */
export const trashSignals = sqliteTable('trash_signals', {
  id: integer('id').primaryKey(),                    // 上游 id
  chain: text('chain').notNull(),
  address: text('address').notNull(),
  symbol: text('symbol'),
  name: text('name'),
  peakMarketCap: real('peak_market_cap'),
  currentMarketCap: real('current_market_cap'),
  drawdownPercent: real('drawdown_percent'),
  firstCallTime: integer('first_call_time'),
  latestCallTime: integer('latest_call_time'),
  triggeredAt: integer('triggered_at'),
  /** JSON: [{callerName, groupName, firstCallTime}]，同一个币可能好几个群都喊过 */
  sources: text('sources'),
  fetchedAt: integer('fetched_at').notNull(),
});
