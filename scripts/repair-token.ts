/**
 * 清掉某个代币被污染的历史数据，让它重新回填。
 *   npm run repair -- <chain:address>
 *
 * 会删除：该代币全部 candle、ATH 状态、报警状态与报警记录、回填任务。
 * 不动代币本身与它的备注。
 */
import { getRawDb } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';

const id = process.argv[2];
if (!id) { console.error('用法: npm run repair -- <chain:address>'); process.exit(1); }
const token = repo.getToken(id);
if (!token) { console.error(`找不到代币 ${id}`); process.exit(1); }

const db = getRawDb();
const counts = {
  candles: db.prepare('SELECT count(*) n FROM candles WHERE token_id = ?').get(id) as { n: number },
  alerts: db.prepare('SELECT count(*) n FROM alerts WHERE token_id = ?').get(id) as { n: number },
};

const tx = db.transaction(() => {
  db.prepare('DELETE FROM candles WHERE token_id = ?').run(id);
  db.prepare('DELETE FROM ath_state WHERE token_id = ?').run(id);
  db.prepare('DELETE FROM alert_states WHERE token_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE token_id = ?').run(id);
  db.prepare('DELETE FROM backfill_jobs WHERE token_id = ?').run(id);
  // 清掉取价元信息，让下一轮当作全新代币处理
  db.prepare('UPDATE tokens SET last_quote_at = NULL, fail_count = 0 WHERE id = ?').run(id);
});
tx();

console.log(`已清理 ${token.symbol ?? id}：`);
console.log(`  candle ${counts.candles.n} 根`);
console.log(`  报警记录 ${counts.alerts.n} 条`);
console.log(`  ATH 状态、报警状态、回填任务已重置`);
console.log(`\n备注保留：${token.note}`);
console.log('worker 下一轮会重新取价并排回填。');
