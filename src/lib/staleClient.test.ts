import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptReload } from './staleClient.ts';

test('版本一致时不提示', () => {
  assert.equal(shouldPromptReload('v4.1', 'v4.1'), false);
});

test('服务端更新了就提示 —— 页面还在跑打包时那份旧代码', () => {
  assert.equal(shouldPromptReload('v4.2', 'v4.1'), true);
});

test('客户端反而更新也提示 —— 不一致本身就说明该刷新', () => {
  // 比如回滚了服务端。方向不重要，一致性才重要
  assert.equal(shouldPromptReload('v4.0', 'v4.1'), true);
});

test('拿不到服务端版本时不提示 —— 别因为一次字段缺失就给所有人假警报', () => {
  assert.equal(shouldPromptReload(undefined, 'v4.1'), false);
  assert.equal(shouldPromptReload(null, 'v4.1'), false);
  assert.equal(shouldPromptReload('', 'v4.1'), false);
});
