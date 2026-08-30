/**
 * 注册/登录流程的关键约定。
 *
 * 这些不是 UI 快照测试，是把"接口返回成功不等于会话生效"这条
 * 契约钉住 —— 用户报的问题正是：注册确实成功了，但页面上什么都没发生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./AccountForm.tsx', import.meta.url), 'utf8');
/** 去掉注释再断言 —— 否则会匹配到解释"为什么不用 router.push"的注释文字 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('成功后必须验证会话真的生效，不能直接跳转', () => {
  assert.match(code, /fetch\('\/api\/wallet\/wallets'\)/,
    '要拿一个需要鉴权的接口验一下，否则 Cookie 被拦时会静默失败');
});

test('会话没生效时要给出可操作的提示，不能只是不跳转', () => {
  assert.match(src, /Cookie/i);
  assert.match(src, /无痕|隐私设置|换个浏览器/);
});

test('用整页跳转而不是 router.push', () => {
  // router.push 会走客户端路由缓存，而缓存里可能存着
  // "未登录时 /wallet 被弹回登录页"那个结果，于是跳了等于没跳
  assert.match(code, /window\.location\.href\s*=\s*'\/wallet'/);
  assert.ok(!code.includes('router.push'), '不该再用 router.push');
  assert.ok(!code.includes('router.refresh'), 'push 后紧跟 refresh 会互相打断');
  assert.ok(!code.includes('useRouter'), '不再需要 useRouter');
});

test('成功和失败都要有可见反馈', () => {
  assert.match(code, /setOk\(/, '成功要有提示');
  assert.match(code, /setErr\(/, '失败要有提示');
  assert.match(src, /注册成功|登录成功/);
});

test('提交中按钮有状态，不是只变个省略号', () => {
  assert.match(src, /处理中/);
});
