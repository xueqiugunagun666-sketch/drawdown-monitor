import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeExternalUrl, pickFirstUrl, pickSocialUrl } from './dexscreener.ts';

/* ---------- 项目方绑定的外链（看板这边） ---------- */

test('只认 http/https —— 这些 URL 是项目方自己填的第三方内容', () => {
  assert.equal(safeExternalUrl('https://ok.example/'), 'https://ok.example/');
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('data:text/html,<script>'), null);
  assert.equal(safeExternalUrl(''), null);
  assert.equal(safeExternalUrl(123), null);
  assert.equal(safeExternalUrl(null), null);
});

test('官网取第一个能用的，跳过不安全的', () => {
  assert.equal(pickFirstUrl([{ url: 'javascript:x' }, { url: 'https://ok.example/' }]),
    'https://ok.example/');
  assert.equal(pickFirstUrl([]), null);
  assert.equal(pickFirstUrl('乱写'), null);
});

test('按 type 取社交账号，不会误取别的类型', () => {
  const socials = [
    { url: 'https://discord.gg/x', type: 'discord' },
    { url: 'https://x.com/foo', type: 'twitter' },
  ];
  assert.equal(pickSocialUrl(socials, 'twitter'), 'https://x.com/foo');
  assert.equal(pickSocialUrl(socials, 'telegram'), null);
  assert.equal(pickSocialUrl(null, 'twitter'), null);
});
