/**
 * 给钱包监控币补长历史，建立可信的 ATH。
 *
 *   npm run ath:backfill            # 只补没有记录或过期的
 *   npm run ath:backfill -- --all   # 全部重拉
 *   npm run ath:backfill -- --limit 20   # 先拿几个试
 *
 * 见 src/worker/athHistory.ts：我们的 5 分钟线只从开始监控那天算起，
 * 对多数钱包币"历史最高"根本不知道。这个脚本按币龄挑分辨率
 * （40 天以内小时线、更老日线），一次请求覆盖整个生命，
 * 并用建池时间判定覆盖是否完整 —— 完整才敢说「历史新高」。
 */
import { runMigrations } from '../src/db/migrate.ts';
import { getRawDb } from '../src/db/index.ts';
import { backfillAth, REFRESH_SECONDS } from '../src/worker/athBackfill.ts';
import * as athRepo from '../src/db/athRepo.ts';
import { makeLogger } from '../src/lib/log.ts';

const log = makeLogger('ath-backfill');

async function main(): Promise<void> {
  runMigrations();
  const now = Math.floor(Date.now() / 1000);
  const all = process.argv.includes('--all');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const ids = (getRawDb().prepare(
    `SELECT DISTINCT token_id FROM holdings WHERE monitored = 1`,
  ).all() as Array<{ token_id: string }>).map((r) => r.token_id);

  let todo = all ? ids : athRepo.tokenIdsNeedingBackfill(ids, now - REFRESH_SECONDS);
  if (Number.isFinite(limit)) todo = todo.slice(0, limit);

  if (todo.length === 0) {
    log.info('没有需要回填的币');
    process.exit(0);
  }
  log.info(`开始回填 ${todo.length}/${ids.length} 个币的长历史…`);

  const t0 = Date.now();
  const r = await backfillAth(todo, now);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  log.info(
    `完成：成功 ${r.done}、跳过 ${r.skipped}，其中 ${r.complete} 个历史覆盖完整`
    + `（可以说「历史新高」），耗时 ${secs}s`,
  );
  process.exit(0);
}

void main().catch((err: unknown) => {
  log.exception('回填失败', err);
  process.exit(1);
});
