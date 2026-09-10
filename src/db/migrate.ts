/**
 * 建表。Phase 1 直接用 CREATE TABLE IF NOT EXISTS，
 * schema 稳定后再切到 drizzle-kit 的迁移文件。
 */
import { getRawDb, getDbPath } from './index.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('migrate');

const DDL = `
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL,
  symbol TEXT, name TEXT, decimals INTEGER, added_at INTEGER NOT NULL,
  note TEXT, tags TEXT, frozen INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  last_source TEXT, last_quote_at INTEGER, primary_elected_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  address TEXT NOT NULL, dex TEXT, quote_symbol TEXT, quote_address TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, liquidity_usd REAL,
  price_usd TEXT, is_outlier INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token_id);
CREATE TABLE IF NOT EXISTS candles (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, ts INTEGER NOT NULL,
  o TEXT, h TEXT, l TEXT, c TEXT,
  o_native TEXT, h_native TEXT, l_native TEXT, c_native TEXT,
  volume_usd REAL, liquidity_primary REAL, liquidity_total REAL, market_cap_usd REAL,
  txn_count INTEGER, source TEXT,
  PRIMARY KEY (token_id, timeframe, ts)
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_candles (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, ts INTEGER NOT NULL,
  o TEXT NOT NULL, h TEXT NOT NULL, l TEXT NOT NULL, c TEXT NOT NULL,
  market_cap_usd TEXT, quote_fetched_at INTEGER NOT NULL,
  price_regime TEXT NOT NULL,
  PRIMARY KEY (token_id, timeframe, ts)
);
CREATE INDEX IF NOT EXISTS idx_wallet_xxyy_candles_ts
  ON wallet_xxyy_candles(ts);
CREATE TABLE IF NOT EXISTS wallet_xxyy_daily_highs (
  token_id TEXT NOT NULL, day INTEGER NOT NULL, high TEXT NOT NULL, high_ts INTEGER,
  price_regime TEXT NOT NULL,
  PRIMARY KEY (token_id, day)
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_history_meta (
  token_id TEXT PRIMARY KEY, first_observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_token_health (
  token_id TEXT PRIMARY KEY, last_ok_at INTEGER NOT NULL, last_missing_at INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_pending_quotes (
  token_id TEXT PRIMARY KEY, price_usd TEXT NOT NULL, market_cap_usd TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_source_baselines (
  chain TEXT PRIMARY KEY,
  baseline_requested INTEGER NOT NULL, baseline_covered INTEGER NOT NULL,
  last_requested INTEGER NOT NULL, last_covered INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ath_state (
  token_id TEXT NOT NULL, mode TEXT NOT NULL, quote_mode TEXT NOT NULL,
  ath_raw TEXT, ath_robust TEXT, ath_ts INTEGER, ath_liquidity REAL, ath_market_cap REAL,
  vol_h1_at_ath REAL, ath_confidence TEXT, verdict_basis TEXT,
  backfill_partial INTEGER NOT NULL DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY (token_id, mode, quote_mode)
);
CREATE TABLE IF NOT EXISTS native_prices (
  symbol TEXT NOT NULL, ts INTEGER NOT NULL, price_usd TEXT NOT NULL, source TEXT,
  PRIMARY KEY (symbol, ts)
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY, token_id TEXT, type TEXT NOT NULL,
  ath_mode TEXT NOT NULL DEFAULT 'rolling_90d', quote_mode TEXT NOT NULL DEFAULT 'usd',
  levels TEXT NOT NULL, confirm_ticks INTEGER NOT NULL DEFAULT 2,
  hysteresis REAL NOT NULL DEFAULT 15, rearm_minutes INTEGER NOT NULL DEFAULT 60,
  min_liquidity_usd REAL NOT NULL DEFAULT 5000,
  ath_sustain_candles INTEGER NOT NULL DEFAULT 3,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  bounce_pct REAL NOT NULL DEFAULT 25, channels TEXT, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS alert_states (
  token_id TEXT NOT NULL, rule_id TEXT NOT NULL, level REAL NOT NULL,
  state TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0,
  rearm_since_ts INTEGER, local_low TEXT, local_low_ts INTEGER, last_fired_at INTEGER,
  PRIMARY KEY (token_id, rule_id, level)
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, token_id TEXT NOT NULL, rule_id TEXT, type TEXT, level REAL,
  fired_at INTEGER NOT NULL, price_usd TEXT, ath_usd TEXT,
  drawdown_usd TEXT, drawdown_native TEXT, snapshot TEXT,
  verdict TEXT, verdict_basis TEXT, delivered TEXT, acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts(fired_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, at_ts INTEGER NOT NULL,
  input_tz TEXT NOT NULL, category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', note TEXT, links TEXT,
  remind_offsets TEXT NOT NULL, reminded_offsets TEXT,
  created_by TEXT, created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at_ts);
CREATE TABLE IF NOT EXISTS backfill_jobs (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, pool_address TEXT NOT NULL,
  status TEXT NOT NULL, target_since_ts INTEGER NOT NULL, oldest_done_ts INTEGER,
  pages_done INTEGER NOT NULL DEFAULT 0, pages_estimated INTEGER NOT NULL DEFAULT 0,
  candles_written INTEGER NOT NULL DEFAULT 0,
  reached_source_limit INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, started_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (token_id, timeframe)
);
CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY, last_ok_at INTEGER, last_fail_at INTEGER,
  last_fail_kind TEXT, last_fail_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pump_health (
  component TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_run_id INTEGER,
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_valid_quote_at INTEGER,
  requested_count INTEGER NOT NULL DEFAULT 0,
  covered_count INTEGER NOT NULL DEFAULT 0,
  failed_batch_count INTEGER NOT NULL DEFAULT 0,
  eval_error_count INTEGER NOT NULL DEFAULT 0,
  last_error_kind TEXT,
  last_error_message TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (component, scope)
);
CREATE TABLE IF NOT EXISTS quote_shadow (
  token_id TEXT NOT NULL,
  bucket_ts INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  ds_price_usd TEXT,
  xxyy_price_usd TEXT,
  decision TEXT NOT NULL,
  ratio TEXT,
  round_healthy INTEGER NOT NULL DEFAULT 0,
  current_price_usd TEXT,
  current_source TEXT,
  hypothetical_price_usd TEXT,
  hypothetical_source TEXT,
  ds_pair_address TEXT,
  ds_dex_id TEXT,
  ds_quote_address TEXT,
  ds_quote_identity TEXT,
  xxyy_pair_address TEXT,
  PRIMARY KEY (token_id, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_quote_shadow_observed
  ON quote_shadow(observed_at);
CREATE TABLE IF NOT EXISTS poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
  tokens_requested INTEGER NOT NULL DEFAULT 0, tokens_covered INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT,
  last_scanned_block INTEGER, last_scan_at INTEGER, last_scan_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  UNIQUE(user_id, chain, address)
);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE TABLE IF NOT EXISTS holdings (
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL, balance TEXT NOT NULL, decimals INTEGER,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  monitored INTEGER NOT NULL DEFAULT 0, filter_reason TEXT,
  below_since_ts INTEGER,
  PRIMARY KEY (wallet_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_token ON holdings(token_id);
CREATE TABLE IF NOT EXISTS wallet_token_candidates (
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (wallet_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_candidates_due
  ON wallet_token_candidates(wallet_id, next_retry_at);
CREATE TABLE IF NOT EXISTS pump_states (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, basis TEXT NOT NULL,
  level REAL NOT NULL, state TEXT NOT NULL, last_fired_at INTEGER,
  PRIMARY KEY (token_id, timeframe, basis, level)
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_pump_states (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, basis TEXT NOT NULL,
  level REAL NOT NULL, state TEXT NOT NULL, last_fired_at INTEGER,
  PRIMARY KEY (token_id, timeframe, basis, level)
);
CREATE TABLE IF NOT EXISTS pump_alerts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL, timeframe TEXT NOT NULL, basis TEXT NOT NULL,
  level REAL NOT NULL, multiple TEXT NOT NULL,
  price_usd TEXT, base_price_usd TEXT, balance TEXT, value_usd TEXT,
  acked_at INTEGER,
  price_source TEXT,
  price_regime TEXT
);
CREATE INDEX IF NOT EXISTS idx_pump_alerts_user ON pump_alerts(user_id, fired_at);
CREATE TABLE IF NOT EXISTS ath_daily (
  token_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  high TEXT NOT NULL,
  PRIMARY KEY (token_id, day)
);
CREATE TABLE IF NOT EXISTS wallet_ath (
  token_id TEXT PRIMARY KEY,
  ath_price TEXT,
  ath_ts INTEGER,
  history_start_ts INTEGER,
  pair_created_at INTEGER,
  complete INTEGER NOT NULL DEFAULT 0,
  backfilled_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_xxyy_ath (
  token_id TEXT PRIMARY KEY,
  ath_price TEXT, ath_ts INTEGER, history_start_ts INTEGER,
  state TEXT NOT NULL DEFAULT 'ARMED',
  last_alert_price TEXT, last_alert_at INTEGER, ref_ath TEXT,
  window_highs TEXT, window_highs_at INTEGER, last_window TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trash_signals (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT, name TEXT,
  peak_market_cap REAL, current_market_cap REAL, drawdown_percent REAL,
  first_call_time INTEGER, latest_call_time INTEGER, triggered_at INTEGER,
  sources TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_triggered ON trash_signals(triggered_at DESC);
CREATE TABLE IF NOT EXISTS token_meta (
  token_id TEXT PRIMARY KEY,
  holder_count INTEGER,
  symbol TEXT,
  fetched_at INTEGER NOT NULL,
  last_eval_at INTEGER,
  last_attempt_at INTEGER,
  last_quote_ok_at INTEGER,
  last_eval_ok_at INTEGER,
  next_retry_at INTEGER,
  eval_failure_count INTEGER NOT NULL DEFAULT 0,
  last_liquidity_usd REAL,
  last_backfill_at INTEGER,
  image_url TEXT,
  website_url TEXT,
  twitter_url TEXT,
  telegram_url TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ts INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at_ts DESC);

CREATE TABLE IF NOT EXISTS invite_codes (
  code_hash TEXT PRIMARY KEY,
  label TEXT,
  max_uses INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

/**
 * 新增列的补丁。CREATE TABLE IF NOT EXISTS 对已存在的表不会加列，
 * 而删库重来在有真实数据后是不可接受的。这里逐列检查后 ALTER。
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['pools', 'price_usd', 'TEXT'],
  ['pools', 'is_outlier', 'INTEGER NOT NULL DEFAULT 0'],
  ['tokens', 'primary_elected_at', 'INTEGER'],
  ['candles', 'liquidity_primary', 'REAL'],
  ['candles', 'liquidity_total', 'REAL'],
  ['candles', 'market_cap_usd', 'REAL'],
  ['ath_state', 'ath_market_cap', 'REAL'],
  ['tokens', 'created_by', 'TEXT'],
  ['tokens', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['candles', 'source', 'TEXT'],
  ['ath_state', 'vol_h1_at_ath', 'REAL'],
  ['ath_state', 'ath_confidence', 'TEXT'],
  ['ath_state', 'verdict_basis', 'TEXT'],
  ['alert_rules', 'ath_sustain_candles', 'INTEGER NOT NULL DEFAULT 3'],
  ['alert_states', 'rearm_since_ts', 'INTEGER'],
  ['alerts', 'verdict_basis', 'TEXT'],
  ['tokens', 'visibility', "TEXT NOT NULL DEFAULT 'public'"],
  ['holdings', 'symbol', 'TEXT'],
  ['token_meta', 'last_eval_at', 'INTEGER'],
  ['token_meta', 'last_attempt_at', 'INTEGER'],
  ['token_meta', 'last_quote_ok_at', 'INTEGER'],
  ['token_meta', 'last_eval_ok_at', 'INTEGER'],
  ['token_meta', 'next_retry_at', 'INTEGER'],
  ['token_meta', 'eval_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['token_meta', 'last_liquidity_usd', 'REAL'],
  ['token_meta', 'last_backfill_at', 'INTEGER'],
  ['pump_alerts', 'kind', 'TEXT'],
  ['pump_alerts', 'base_ts', 'INTEGER'],
  ['pump_alerts', 'ath_window', 'TEXT'],
  ['pump_alerts', 'market_cap_usd', 'REAL'],
  ['pump_alerts', 'quote_fetched_at', 'INTEGER'],
  ['pump_alerts', 'evaluated_at', 'INTEGER'],
  ['pump_alerts', 'price_source', 'TEXT'],
  ['pump_alerts', 'price_regime', 'TEXT'],
  ['wallet_ath', 'state', "TEXT NOT NULL DEFAULT 'ARMED'"],
  ['wallet_ath', 'last_alert_price', 'TEXT'],
  ['wallet_ath', 'last_alert_at', 'INTEGER'],
  ['wallet_ath', 'ref_ath', 'TEXT'],
  ['wallet_ath', 'window_highs', 'TEXT'],
  ['wallet_ath', 'window_highs_at', 'INTEGER'],
  ['wallet_ath', 'last_window', 'TEXT'],
  ['token_meta', 'image_url', 'TEXT'],
  ['token_meta', 'website_url', 'TEXT'],
  ['token_meta', 'twitter_url', 'TEXT'],
  ['token_meta', 'telegram_url', 'TEXT'],
  ['users', 'min_alert_value_usd', 'REAL'],
  ['tokens', 'owner_id', 'TEXT'],
  ['events', 'owner_id', 'TEXT'],
  ['wallet_xxyy_daily_highs', 'high_ts', 'INTEGER'],
];

export function runMigrations(): void {
  const db = getRawDb();
  db.exec(DDL);

  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue;                       // 表还不存在
    if (cols.some((c) => c.name === column)) continue;     // 列已存在
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    log.info(`已补列 ${table}.${column}`);
  }

  // 老版本只有 last_eval_at。首次升级时把它作为成功水位继承，避免所有冷币
  // 同时被当成“从未检查”打满报价队列；后续新字段会独立推进。
  db.exec(`
    UPDATE token_meta
       SET last_quote_ok_at = COALESCE(last_quote_ok_at, last_eval_at),
           last_eval_ok_at = COALESCE(last_eval_ok_at, last_eval_at)
     WHERE last_eval_at IS NOT NULL
       AND (last_quote_ok_at IS NULL OR last_eval_ok_at IS NULL)
  `);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  log.info(`schema applied at ${getDbPath()}`);
}
