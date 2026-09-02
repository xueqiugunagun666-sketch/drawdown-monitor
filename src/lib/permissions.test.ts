import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDelete, canEditMeta, canToggleGlobal, type Actor } from './permissions.ts';

const admin: Actor = { id: 'u-admin', name: 'pananiu', isAdmin: true };
const alice: Actor = { id: 'u-alice', name: 'alice', isAdmin: false };
const bob: Actor   = { id: 'u-bob',   name: 'bob',   isAdmin: false };

test('管理员能删任何东西，包括无主的', () => {
  assert.equal(canDelete(admin, 'u-alice'), true);
  assert.equal(canDelete(admin, null), true);
});

test('普通用户只能删自己的', () => {
  assert.equal(canDelete(alice, 'u-alice'), true);
  assert.equal(canDelete(alice, 'u-bob'), false);
});

test('无主的东西普通用户删不了 —— NULL 不等于任何人', () => {
  // 15 个历史代币里就有 1 个无主，这条不是假想情况
  assert.equal(canDelete(alice, null), false);
  assert.equal(canDelete(bob, null), false);
});

test('未登录一律不能删', () => {
  assert.equal(canDelete(null, 'u-alice'), false);
  assert.equal(canDelete(null, null), false);
});

test('改备注与删除同规则', () => {
  assert.equal(canEditMeta(admin, null), true);
  assert.equal(canEditMeta(alice, 'u-alice'), true);
  assert.equal(canEditMeta(alice, 'u-bob'), false);
  assert.equal(canEditMeta(null, 'u-alice'), false);
});

test('停用/冻结/改档位只有管理员', () => {
  assert.equal(canToggleGlobal(admin), true);
  assert.equal(canToggleGlobal(alice), false);
  assert.equal(canToggleGlobal(null), false);
});

test('空 owner id 当作无主，不能靠空字符串绕过', () => {
  // 万一哪天写入了空串，不能让它和「未设置 id」意外相等
  assert.equal(canDelete(alice, ''), false);
  assert.equal(canEditMeta(alice, ''), false);
});
