/**
 * 加币 CLI（Web 端 /add 在 Phase 3）。
 *   npm run token:add -- <chain> <address> "<备注>"
 * 备注必填 —— 强制记录筛选理由（§9.4）。
 */
import { runMigrations } from '../src/db/migrate.ts';
import * as repo from '../src/db/repo.ts';
import { CHAIN_IDS } from '../src/sources/types.ts';

const [chain, address, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim();

if (!chain || !address || !note) {
  console.error('用法: npm run token:add -- <chain> <address> "<备注>"');
  console.error(`chain 可选: ${CHAIN_IDS.join(' | ')}`);
  console.error('备注必填 —— 报警时最需要回忆的就是当初为什么关注它');
  process.exit(1);
}
if (!(CHAIN_IDS as string[]).includes(chain)) {
  console.error(`未知链 "${chain}"，可选: ${CHAIN_IDS.join(' | ')}`);
  process.exit(1);
}

runMigrations();
const t = repo.addToken({ chain, address, note });
console.log(`已加入: ${t.id}`);
console.log(`备注: ${t.note}`);
