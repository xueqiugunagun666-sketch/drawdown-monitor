/**
 * 一次性回填历史归属。
 *
 * 映射由用户本人确认，**不做任何字符串相似度匹配** ——
 * retend 与 retend666 形似纯属巧合，采信依据是用户确认。
 * 不在表里的署名（307大王小锐、赌命哥）保持无主，只有管理员能动。
 *
 * 幂等：只写 owner_id IS NULL 的行。
 * 按署名值匹配而非数量 —— 看板一直在变，写死数量会让脚本行为错误。
 */
import { runMigrations } from '../src/db/migrate.ts';
import { getRawDb } from '../src/db/index.ts';

const TOKEN_MAP: Array<[createdBy: string | null, accountName: string]> = [
  ['小牛', 'pananiu'],
  ['retend', 'retend666'],
  [null, 'pananiu'],          // 无署名的都是账号系统上线前加的，用户决定归管理员
];
const EVENT_MAP: Array<[createdBy: string | null, accountName: string]> = [
  ['小牛', 'pananiu'],
];

runMigrations();
const db = getRawDb();
const dry = process.argv.includes('--dry-run');

function userId(name: string): string {
  const r = db.prepare('SELECT id FROM users WHERE name = ?').get(name) as { id: string } | undefined;
  if (!r) throw new Error(`账号不存在: ${name} —— 回填中止，不猜`);
  return r.id;
}

for (const [table, map] of [['tokens', TOKEN_MAP], ['events', EVENT_MAP]] as const) {
  for (const [createdBy, account] of map) {
    const uid = userId(account);
    const where = createdBy === null
      ? `created_by IS NULL AND owner_id IS NULL`
      : `created_by = ? AND owner_id IS NULL`;
    const args = createdBy === null ? [uid] : [uid, createdBy];
    const count = db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE ${where}`,
    ).get(...(createdBy === null ? [] : [createdBy])) as { c: number };
    console.log(`${table}: 署名 ${createdBy ?? '<无>'} -> ${account}，${count.c} 行`);
    if (!dry) db.prepare(`UPDATE ${table} SET owner_id = ? WHERE ${where}`).run(...args);
  }
}

const orphanT = db.prepare('SELECT COUNT(*) c FROM tokens WHERE owner_id IS NULL').get() as { c: number };
const orphanE = db.prepare('SELECT COUNT(*) c FROM events WHERE owner_id IS NULL').get() as { c: number };
console.log(`\n剩余无主：代币 ${orphanT.c}、日程 ${orphanE.c}（只有管理员能删改）`);
if (dry) console.log('（--dry-run，未写入）');
