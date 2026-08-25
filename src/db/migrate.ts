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
  last_source TEXT, last_quote_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0
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
  volume_usd REAL, liquidity_primary REAL, liquidity_total REAL,
  txn_count INTEGER, source TEXT,
  PRIMARY KEY (token_id, timeframe, ts)
);
CREATE TABLE IF NOT EXISTS ath_state (
  token_id TEXT NOT NULL, mode TEXT NOT NULL, quote_mode TEXT NOT NULL,
  ath_raw TEXT, ath_robust TEXT, ath_ts INTEGER, ath_liquidity REAL,
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
CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY, last_ok_at INTEGER, last_fail_at INTEGER,
  last_fail_kind TEXT, last_fail_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
  tokens_requested INTEGER NOT NULL DEFAULT 0, tokens_covered INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);
`;

export function runMigrations(): void {
  const db = getRawDb();
  db.exec(DDL);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  log.info(`schema applied at ${getDbPath()}`);
}
