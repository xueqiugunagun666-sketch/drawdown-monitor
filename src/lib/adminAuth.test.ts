import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminName } from './adminAuth.ts';

// isAdminName 直接收配置值，避免测试依赖 process.env 与模块级缓存
test('配置为空时没有人是管理员 —— fail closed', () => {
  assert.equal(isAdminName('pananiu', undefined), false);
  assert.equal(isAdminName('pananiu', ''), false);
  assert.equal(isAdminName('pananiu', '   '), false);
});

test('名字匹配才是管理员', () => {
  assert.equal(isAdminName('pananiu', 'pananiu'), true);
  assert.equal(isAdminName('alice', 'pananiu'), false);
});

test('两侧都去空白 —— .env 里手抖多打个空格不该让管理员失效', () => {
  assert.equal(isAdminName('pananiu', ' pananiu '), true);
  assert.equal(isAdminName(' pananiu ', 'pananiu'), true);
});

test('区分大小写 —— users.name 是唯一键，PANANIU 是另一个账号', () => {
  assert.equal(isAdminName('PANANIU', 'pananiu'), false);
});

test('账号名为空不能匹配上空配置', () => {
  assert.equal(isAdminName('', ''), false);
  assert.equal(isAdminName('', 'pananiu'), false);
});
