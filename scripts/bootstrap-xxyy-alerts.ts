/** 发布切源前显式准备 XXYY 同源历史；可重复运行，已有 5m 格不会重写。 */
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapXxyyAlertHistory } from '../src/worker/xxyyAlertEngine.ts';

const started = Date.now();
runMigrations();
const result = bootstrapXxyyAlertHistory();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `XXYY 报警历史准备完成：新增 ${result.accepted} 个 5m 格，耗时 ${seconds}s`,
);
