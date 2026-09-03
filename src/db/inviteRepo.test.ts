/**
 * 重点是**次数上限不能被绕过**，以及码的规范化 ——
 * 码要通过聊天软件转发、可能被人手打，转发时带上空格、
 * 打成小写、漏掉连字符都不该算错码。
 */
process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import {
  generateCode, createInviteCode, consumeInviteCode, refundInviteCode,
  listInviteCodes, deleteInviteCode, hashCode,
} from './inviteRepo.ts';

before(() => { runMigrations(); });

test('生成的码只含无歧义字符，且每次都不同', () => {
  const a = generateCode();
  assert.match(a, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){3}$/);
  // 手抄会认错的字符一个都不能有
  assert.ok(!/[01OIL]/.test(a.replace(/-/g, '')), `码里出现了易混字符: ${a}`);
  assert.notEqual(a, generateCode());
});

test('用满次数后失效，且理由和「码不对」分开', () => {
  const code = generateCode();
  createInviteCode(code, '给老王', 2);

  const r1 = consumeInviteCode(code);
  assert.equal(r1.ok, true);
  assert.equal(r1.ok && r1.remaining, 1);
  assert.equal(r1.ok && r1.label, '给老王');

  const r2 = consumeInviteCode(code);
  assert.equal(r2.ok, true);
  assert.equal(r2.ok && r2.remaining, 0);

  const r3 = consumeInviteCode(code);
  assert.equal(r3.ok, false);
  assert.equal(!r3.ok && r3.reason, '这个邀请码已经用完了');
});

test('不存在的码报「不对」而不是「用完了」', () => {
  const r = consumeInviteCode(generateCode());
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, '邀请码不对');
});

test('转发带来的空格、小写、缺连字符都要认', () => {
  const code = generateCode();
  createInviteCode(code, null, 4);
  const bare = code.replace(/-/g, '');
  assert.equal(consumeInviteCode(`  ${code}  `).ok, true, '前后空格');
  assert.equal(consumeInviteCode(code.toLowerCase()).ok, true, '小写');
  assert.equal(consumeInviteCode(bare).ok, true, '没有连字符');
  assert.equal(consumeInviteCode(`${bare.slice(0, 8)} ${bare.slice(8)}`).ok, true, '中间有空格');
});

test('库里不存明文', () => {
  const code = generateCode();
  createInviteCode(code, '明文检查', 1);
  const rows = listInviteCodes();
  const row = rows.find((r) => r.label === '明文检查')!;
  assert.equal(row.codeHash, hashCode(code));
  assert.ok(!JSON.stringify(rows).includes(code.replace(/-/g, '')), '库里出现了明文码');
});

test('用完的码仍然查得到 —— 你得知道额度是被谁用光的', () => {
  const code = generateCode();
  createInviteCode(code, '查得到', 1);
  consumeInviteCode(code);
  const row = listInviteCodes().find((r) => r.label === '查得到')!;
  assert.equal(row.usedCount, 1);
  assert.equal(row.maxUses, 1);
  assert.ok(row.lastUsedAt !== null, '最后使用时间要记下来');
});

test('可以删除', () => {
  const code = generateCode();
  createInviteCode(code, '待删', 1);
  assert.equal(deleteInviteCode(hashCode(code)), true);
  assert.equal(deleteInviteCode(hashCode(code)), false, '删不存在的返回 false');
  assert.equal(consumeInviteCode(code).ok, false);
});

test('退回：核销了但账号没建成时，额度要还回去', () => {
  const code = generateCode();
  createInviteCode(code, '退回', 3);
  consumeInviteCode(code);
  assert.equal(listInviteCodes().find((r) => r.label === '退回')!.usedCount, 1);
  refundInviteCode(code);
  assert.equal(listInviteCodes().find((r) => r.label === '退回')!.usedCount, 0);
});

test('退回不会把次数减成负数', () => {
  const code = generateCode();
  createInviteCode(code, '负数', 1);
  refundInviteCode(code);
  refundInviteCode(code);
  assert.equal(listInviteCodes().find((r) => r.label === '负数')!.usedCount, 0);
  // 减成负数的话，一个没用过的码会凭空多出额度
  assert.equal(consumeInviteCode(code).ok, true);
  assert.equal(consumeInviteCode(code).ok, false, '上限仍然是 1');
});

test('退回不存在的码不报错也不影响别人', () => {
  const code = generateCode();
  createInviteCode(code, '旁观', 2);
  refundInviteCode(generateCode());
  assert.equal(listInviteCodes().find((r) => r.label === '旁观')!.usedCount, 0);
});

test('maxUses 为 0 的码一次都用不了', () => {
  // 不该出现，但万一手滑传了 0，行为必须是「用不了」而不是「无限用」
  const code = generateCode();
  createInviteCode(code, '零次', 0);
  const r = consumeInviteCode(code);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, '这个邀请码已经用完了');
});
