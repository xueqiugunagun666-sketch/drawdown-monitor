/** 查看审计日志。npm run audit -- 20 */
import { runMigrations } from '../src/db/migrate.ts';
import { listAudit } from '../src/db/auditLog.ts';

runMigrations();
const limit = Number(process.argv[2] ?? 30);
const rows = listAudit(limit);
if (rows.length === 0) { console.log('（没有记录）'); process.exit(0); }
for (const r of rows) {
  const t = new Date(r.atTs * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`${t}  ${r.actorName.padEnd(12)} ${r.action.padEnd(14)} ${r.targetLabel ?? r.targetId ?? ''}`);
  if (r.detail) console.log(`${' '.repeat(22)}${r.detail}`);
}
