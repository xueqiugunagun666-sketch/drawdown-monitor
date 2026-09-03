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
  // "未登录时被弹回登录页"那个结果，于是跳了等于没跳。
  // 只钉「整页跳转」这条约定，不钉具体目标 —— 目标现在由 ?next= 决定
  assert.match(code, /window\.location\.href\s*=/);
  assert.ok(!code.includes('router.push'), '不该再用 router.push');
  assert.ok(!code.includes('router.refresh'), 'push 后紧跟 refresh 会互相打断');
  assert.ok(!code.includes('useRouter'), '不再需要 useRouter');
});

test('跳转目标必须挡住开放重定向', () => {
  // ?next= 直接拿去跳转的话，别人能构造
  // /wallet/login?next=https://钓鱼站 的链接骗人。
  //
  // 这条断言必须对 src 而不是 code：上面那个剥注释的正则是按
  // 「两个斜杠到行尾」粗暴切的，而要匹配的代码里恰好有字符串
  // 字面量 '//'，会被它当成注释开头整行吃掉
  assert.match(src, /startsWith\('\/'\)/, 'next 必须是站内相对路径');
  assert.match(src, /startsWith\('\/\/'\)/, '协议相对地址（两个斜杠开头）指向外站，要挡');
});

test('注册要带邀请码，登录不带', () => {
  // 登录也要码的话，已有账号的人会被莫名其妙挡住，而额度也会被白白耗掉
  assert.match(code, /mode === 'register' \? \{ name, password, invite \}/);
});

test('成功和失败都要有可见反馈', () => {
  assert.match(code, /setOk\(/, '成功要有提示');
  assert.match(code, /setErr\(/, '失败要有提示');
  assert.match(src, /注册成功|登录成功/);
});

test('提交中按钮有状态，不是只变个省略号', () => {
  assert.match(src, /处理中/);
});
