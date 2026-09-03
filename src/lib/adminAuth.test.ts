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

/* ---------------- 多管理员：逗号分隔 ---------------- */

test('逗号分隔的多个账号都是管理员', () => {
  assert.equal(isAdminName('pananiu', 'pananiu,retend666'), true);
  assert.equal(isAdminName('retend666', 'pananiu,retend666'), true);
  assert.equal(isAdminName('alice', 'pananiu,retend666'), false);
});

test('逗号两侧的空格要吃掉 —— 人写配置时习惯加空格', () => {
  assert.equal(isAdminName('retend666', 'pananiu, retend666'), true);
  assert.equal(isAdminName('pananiu', ' pananiu , retend666 '), true);
});

test('空条目直接跳过，不能让多打的逗号变成「匹配空名字」', () => {
  assert.equal(isAdminName('pananiu', 'pananiu,,retend666'), true);
  assert.equal(isAdminName('pananiu', 'pananiu,'), true);
  assert.equal(isAdminName('', 'pananiu,,retend666'), false, '空账号名不能匹配上被跳过的空条目');
});

test('整串都是逗号空格 = 没有人是管理员', () => {
  assert.equal(isAdminName('pananiu', ',,,'), false);
  assert.equal(isAdminName('pananiu', ' , , '), false);
});

test('每一项都必须整体相等，不能是前缀或包含匹配', () => {
  // 这个项目里 retend 和 retend666 是两个真实存在的不同名字：
  // 一旦退化成包含匹配，配 retend 会把 retend666 一起提权
  assert.equal(isAdminName('retend666', 'retend'), false);
  assert.equal(isAdminName('retend', 'retend666'), false);
  assert.equal(isAdminName('retend666', 'retend,alice'), false);
  assert.equal(isAdminName('pananiu2', 'pananiu'), false);
});
