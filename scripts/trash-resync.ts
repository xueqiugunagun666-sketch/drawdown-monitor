/**
 * 群聊淘金的一次性重同步：从 after_id=0 重新拉一遍，覆盖已有的行。
 *
 *   npm run trash:resync
 *
 * 平时用不着 —— 轮询的游标是本地 MAX(id)，只往前走。这个脚本是给
 * "存进来的数据本身是错的"这种情况用的：改了解析逻辑之后，光靠轮询
 * 修不了已经落库的旧行。
 */
import { runMigrations } from '../src/db/migrate.ts';
import { fetchTrashSignals, isConfigured, PAGE_LIMIT } from '../src/sources/trashSignals.ts';
import * as repo from '../src/db/trashRepo.ts';
import { makeLogger } from '../src/lib/log.ts';

const log = makeLogger('trash-resync');

async function main(): Promise<void> {
  runMigrations();
  if (!isConfigured()) {
    log.warn('未配置 TRASH_API_BASE / TRASH_API_TOKEN');
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  let cursor = 0;
  let seen = 0;

  for (let page = 0; page < 100; page++) {
    const res = await fetchTrashSignals(cursor);
    if (res.signals.length === 0) break;
    repo.insertSignals(res.signals, now);
    seen += res.signals.length;
    if (res.nextAfterId <= cursor) break;
    cursor = res.nextAfterId;
    if (res.signals.length < PAGE_LIMIT) break;
  }
  log.info(`重同步完成：覆盖 ${seen} 条，库里共 ${repo.countSignals()} 条`);
  process.exit(0);
}

void main().catch((err: unknown) => {
  log.exception('重同步失败', err);
  process.exit(1);
});
