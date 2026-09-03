/**
 * 邀请码管理。
 *
 *   npm run invite                      列出所有码及剩余次数
 *   npm run invite -- new 10 "给老王"    生成一个能用 10 次的码
 *   npm run invite -- rm <前8位哈希>     删掉一个码
 *
 * **码只在生成时打印这一次**，库里只存哈希。丢了就重新生成 ——
 * 存明文的话，库泄露就等于把注册入口一起交出去了。
 */
import { runMigrations } from '../src/db/migrate.ts';
import {
  generateCode, createInviteCode, listInviteCodes, deleteInviteCode,
} from '../src/db/inviteRepo.ts';

runMigrations();

const [cmd, ...rest] = process.argv.slice(2);

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function list(): void {
  const rows = listInviteCodes();
  if (rows.length === 0) {
    console.log('还没有邀请码。生成一个：npm run invite -- new 10 "给谁"');
    return;
  }
  console.log('哈希前缀   备注                剩余/总数   最后使用');
  console.log('-'.repeat(64));
  for (const r of rows) {
    const remaining = r.maxUses - r.usedCount;
    const flag = remaining <= 0 ? '  (已用完)' : '';
    console.log(
      `${r.codeHash.slice(0, 8)}   ${(r.label ?? '—').padEnd(18)}  ${String(remaining).padStart(3)}/${String(r.maxUses).padEnd(4)}  ${fmtTime(r.lastUsedAt)}${flag}`,
    );
  }
}

if (!cmd || cmd === 'ls') {
  list();
} else if (cmd === 'new') {
  const uses = Number(rest[0] ?? 10);
  const label = rest.slice(1).join(' ') || null;
  if (!Number.isInteger(uses) || uses < 1) {
    console.error('次数必须是正整数：npm run invite -- new 10 "给老王"');
    process.exit(1);
  }
  const code = generateCode();
  createInviteCode(code, label, uses);
  console.log('');
  console.log(`  ${code}`);
  console.log('');
  console.log(`可用 ${uses} 次${label ? `，备注「${label}」` : ''}。`);
  console.log('这个码只会显示这一次，库里只存哈希 —— 现在就复制走。');
} else if (cmd === 'rm') {
  const prefix = rest[0];
  if (!prefix) { console.error('用法: npm run invite -- rm <哈希前缀>'); process.exit(1); }
  const hit = listInviteCodes().filter((r) => r.codeHash.startsWith(prefix));
  if (hit.length === 0) { console.error(`没有哈希以 ${prefix} 开头的码`); process.exit(1); }
  if (hit.length > 1) { console.error(`${prefix} 匹配到 ${hit.length} 个，请写长一点`); process.exit(1); }
  deleteInviteCode(hit[0]!.codeHash);
  console.log(`已删除 ${hit[0]!.codeHash.slice(0, 8)}（${hit[0]!.label ?? '无备注'}）`);
} else {
  console.error(`不认识的命令 "${cmd}"。可用: ls / new / rm`);
  process.exit(1);
}
