/**
 * SQLite 连接（WAL）。worker 与 Next.js 两个进程共享同一个文件。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema.ts';

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _raw: Database.Database | null = null;

/** better-sqlite3 的内存库哨兵值，必须原样透传 —— 一旦过 resolve()
 *  就变成仓库里一个真实文件，测试会跨次运行互相污染。 */
const MEMORY = ':memory:';

export function getDbPath(): string {
  const raw = process.env.DATABASE_PATH ?? './data/monitor.db';
  return raw === MEMORY ? MEMORY : resolve(raw);
}

export function getRawDb(): Database.Database {
  if (_raw) return _raw;
  const path = getDbPath();
  if (path !== MEMORY) mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  _raw = conn;
  return conn;
}

export function getDb() {
  if (_db) return _db;
  _db = drizzle(getRawDb(), { schema });
  return _db;
}

export { schema };
